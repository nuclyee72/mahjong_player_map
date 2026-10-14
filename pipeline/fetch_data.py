"""대국 기록 수집 → data/games.json

  운영 서버에서:  python -m pipeline.fetch_data --base-url https://<계정>.pythonanywhere.com
  로컬 DB에서:    python -m pipeline.fetch_data --db ../games.db

라이브 + 모든 시즌 아카이브 + 대회(tournament_games)를 모은다.
'TEST' 아카이브는 제외하고, (created_at, 이름 4, 점수 4)가 같은 게임은 하나만 남긴다.
"""
import argparse
import json
import sqlite3
import urllib.request
from collections import Counter
from datetime import datetime

from .common import DATA_DIR, GAMES_JSON, MADANG_DIR, MIN_GAMES

COLS = ("created_at",
        "player1_name", "player2_name", "player3_name", "player4_name",
        "player1_score", "player2_score", "player3_score", "player4_score")


def _row_to_game(row, source):
    return {
        "created_at": row["created_at"],
        "names": [(row[f"player{i}_name"] or "").strip() for i in range(1, 5)],
        "scores": [int(row[f"player{i}_score"]) for i in range(1, 5)],
        "source": source,
    }


def fetch_from_db(db_path):
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cols = ", ".join(COLS)
    live = [dict(r) for r in conn.execute(f"SELECT {cols} FROM games")]
    try:
        tournament = [dict(r) for r in conn.execute(f"SELECT {cols} FROM tournament_games")]
    except sqlite3.OperationalError:
        tournament = []
    archives = [dict(r) for r in conn.execute("SELECT id, name FROM archives ORDER BY id")]
    archive_games = {}
    for a in archives:
        archive_games[a["id"]] = [dict(r) for r in conn.execute(
            f"SELECT {cols} FROM archive_games WHERE archive_id = ?", (a["id"],))]
    conn.close()
    return live, tournament, archives, archive_games


def _get_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "mahjong-player-map/1.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def fetch_from_api(base_url):
    api = base_url.rstrip("/") + "/mahjong_rating/api"
    live = _get_json(f"{api}/games")
    try:
        tournament = _get_json(f"{api}/tournament_games")
    except Exception as e:  # 대회 기능이 없는 배포본 대비
        print(f"[WARN] tournament_games 수집 실패: {e}")
        tournament = []
    archives = sorted(_get_json(f"{api}/archives"), key=lambda a: a["id"])
    archive_games = {a["id"]: _get_json(f"{api}/archives/{a['id']}/games") for a in archives}
    return live, tournament, archives, archive_games


def collect(live, tournament, archives, archive_games, exclude_names):
    exclude = {n.strip().lower() for n in exclude_names}
    batches = [("live", live), ("tournament", tournament)]
    report = [("live", len(live), True), ("tournament", len(tournament), True)]
    for a in archives:
        rows = archive_games.get(a["id"], [])
        use = a["name"].strip().lower() not in exclude
        report.append((f"archive {a['id']} '{a['name']}'", len(rows), use))
        if use:
            batches.append((f"archive:{a['id']}:{a['name']}", rows))

    games, seen, dup = [], set(), 0
    for source, rows in batches:
        for row in rows:
            g = _row_to_game(row, source)
            key = (g["created_at"], tuple(g["names"]), tuple(g["scores"]))
            if key in seen:
                dup += 1
                continue
            seen.add(key)
            games.append(g)
    return games, report, dup


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    src = ap.add_mutually_exclusive_group()
    src.add_argument("--base-url", help="운영 사이트 주소 (예: https://계정.pythonanywhere.com)")
    src.add_argument("--db", help="games.db 경로 (기본: madang_web/games.db)")
    ap.add_argument("--exclude-archive", action="append", default=["TEST"],
                    help="제외할 아카이브 이름 (여러 번 지정 가능, 기본: TEST)")
    args = ap.parse_args()

    if args.base_url:
        origin = args.base_url
        live, tournament, archives, archive_games = fetch_from_api(args.base_url)
    else:
        db = args.db or str(MADANG_DIR / "games.db")
        origin = db
        live, tournament, archives, archive_games = fetch_from_db(db)

    games, report, dup = collect(live, tournament, archives, archive_games, args.exclude_archive)

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with open(GAMES_JSON, "w", encoding="utf-8") as f:
        json.dump({"fetched_at": datetime.now().isoformat(timespec="seconds"),
                   "origin": origin, "games": games}, f, ensure_ascii=False)

    print(f"수집 출처: {origin}")
    for label, n, used in report:
        print(f"  {'✓' if used else '✗ 제외'} {label}: {n}판")
    print(f"중복 제거: {dup}판 → 최종 {len(games)}판")
    if games:
        dates = sorted(g["created_at"] for g in games)
        print(f"기간: {dates[0][:10]} ~ {dates[-1][:10]}")

    counts = Counter(n for g in games for n in g["names"] if n)
    eligible = sorted(((n, c) for n, c in counts.items() if c >= MIN_GAMES), key=lambda x: -x[1])
    print(f"전체 플레이어 {len(counts)}명, {MIN_GAMES}판 이상 {len(eligible)}명")
    print("  " + ", ".join(f"{n}({c})" for n, c in eligible))
    print(f"→ {GAMES_JSON}")


if __name__ == "__main__":
    main()
