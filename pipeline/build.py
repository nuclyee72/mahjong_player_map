"""전체 실행: data/games.json → web/data/player_map.json

  python -m pipeline.fetch_data --db ../games.db   # (데이터 갱신 시)
  python -m pipeline.build
  python -m pipeline.build --k 12 --out player_map_k12.json   # 군집 수를 바꿔 따로 만들어 보기 (웹에서 ?data=player_map_k12)
"""
import argparse
import json
from datetime import datetime

import numpy as np

from .common import MIN_GAMES, MIN_GAMES_PROJECT, WEB_DATA_DIR, load_games
from .features import DEFAULT_WEIGHTS, FEATURE_GROUPS, FEATURE_LABELS, build_matrix, compute_features, zscore
from .reduce_cluster import MapModel, neighbors
from .relations import head_to_head, relations_for

K = 10
N_TRAITS = 3


def _r(x, nd=3):
    return round(float(x), nd)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--k", type=int, default=K, help=f"군집(무리) 수, 기본 {K}")
    ap.add_argument("--out", default="player_map.json", help="web/data/ 아래 출력 파일 이름")
    args = ap.parse_args()

    games = load_games()
    feat_df, disp, partners = compute_features(games)
    core_mask = disp["core"].to_numpy()
    names = list(feat_df.index)

    X = build_matrix(feat_df, DEFAULT_WEIGHTS, disp["core"])
    model = MapModel(args.k).fit(X[core_mask])
    xyz, labels, Xp = model.transform(X, core_mask)
    # 소속 애매함: 자기 무리 중심까지 거리 ÷ 가장 가까운 다른 무리 중심까지 거리 (1에 가까울수록 경계에 있음)
    dists = model.km.transform(Xp)
    own = dists[np.arange(len(names)), labels]
    other = np.where(np.arange(dists.shape[1]) == labels[:, None], np.inf, dists).min(axis=1)
    ambiguity = np.clip(own / other, 0, 1)
    nb = neighbors(X, names, core_mask)
    z = zscore(feat_df, disp["core"])
    h2h = head_to_head(games, names)

    skill = disp["avg_pt"]
    core_skill = np.sort(skill[core_mask].to_numpy())
    skill_pct = {n: float(np.searchsorted(core_skill, skill[n], side="right") / len(core_skill)) for n in names}

    players = []
    for i, name in enumerate(names):
        d = disp.loc[name]
        zi = z.loc[name].sort_values()
        players.append({
            "name": name,
            "games": int(d["games"]),
            "core": bool(d["core"]),
            "cluster": int(labels[i]),
            "ambiguity": _r(ambiguity[i]),
            "xyz": [_r(v, 4) for v in xyz[i]],
            "skill": {"avg_pt": _r(d["avg_pt"], 2), "pct": _r(skill_pct[name])},
            "stats": {
                "avg_rank": _r(d["avg_rank"]), "rank_counts": [int(c) for c in d["rank_counts"]],
                "top2_rate": _r(d["top2_rate"]), "last_avoid_rate": _r(d["last_avoid_rate"]),
                "total_pt": _r(d["total_pt"], 1), "score_mean": int(round(d["score_mean"])),
                "max_score": int(d["max_score"]), "max_consec_1st": int(d["max_consec_1st"]),
                "max_consec_4th": int(d["max_consec_4th"]),
                "first_game": d["first_game"], "last_game": d["last_game"],
            },
            "features": {k: _r(v, 4) for k, v in feat_df.loc[name].items()},
            "z": {k: _r(v, 2) for k, v in z.loc[name].items()},
            "traits": {
                "high": [k for k, v in zi[::-1][:N_TRAITS].items() if v >= 0.5],
                "low": [k for k, v in zi[:N_TRAITS].items() if v <= -0.5],
            },
            "similar": [{"name": n, "sim": _r(s)} for n, s in nb[name]["similar"]],
            "opposite": {"name": nb[name]["opposite"][0], "sim": _r(nb[name]["opposite"][1])},
            "partners": [{"name": n, "co": c} for n, c in partners[name]],
            "relations": relations_for(name, names, h2h),
        })

    dates = [g["created_at"][:10] for g in games]
    out = {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "method": {
            "min_games_core": MIN_GAMES, "min_games_projected": MIN_GAMES_PROJECT,
            "k": args.k, "weights": DEFAULT_WEIGHTS, "total_games": len(games),
            "period": [min(dates), max(dates)],
        },
        "feature_groups": FEATURE_GROUPS,
        "feature_labels": FEATURE_LABELS,
        "players": players,
    }
    WEB_DATA_DIR.mkdir(parents=True, exist_ok=True)
    path = WEB_DATA_DIR / args.out
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print(f"플레이어 {len(players)}명 (학습 {int(core_mask.sum())} + 관측 중 {int((~core_mask).sum())}) "
          f"→ {path} ({path.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
