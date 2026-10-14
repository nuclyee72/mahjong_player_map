"""파이프라인 공용: 경로, 콘솔 인코딩, 게임 로드, 순위/pt 계산."""
import importlib.util
import json
import sys
from datetime import datetime
from pathlib import Path

# Windows 콘솔(cp949/cp932)에서 한글 print가 죽지 않도록
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

PROJECT_DIR = Path(__file__).resolve().parent.parent          # mahjong_player_map/
MADANG_DIR = PROJECT_DIR.parent                               # madang_web/
SITE_DIR = MADANG_DIR / "mahjong_rating_site"
DATA_DIR = PROJECT_DIR / "data"
WEB_DATA_DIR = PROJECT_DIR / "web" / "data"
GAMES_JSON = DATA_DIR / "games.json"

MIN_GAMES = 20          # 지도·군집 학습 대상
MIN_GAMES_PROJECT = 10  # 학습된 지도에 투영만 하는 대상 (관측 중)


def load_mahjong_config():
    """madang_web/config.json의 MAHJONG_CONFIG (없으면 서브모듈 쪽)."""
    for path in (MADANG_DIR / "config.json", SITE_DIR / "config.json"):
        if path.exists():
            with open(path, encoding="utf-8") as f:
                return json.load(f)["MAHJONG_CONFIG"]
    raise FileNotFoundError("config.json(MAHJONG_CONFIG)을 찾을 수 없습니다.")


_site_module = None


def _load_site_module():
    """mahjong_rating_site/app.py를 불러와 pt 계산 로직을 그대로 재사용한다."""
    global _site_module
    if _site_module is None:
        spec = importlib.util.spec_from_file_location("mahjong_site_app", SITE_DIR / "app.py")
        _site_module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(_site_module)
    return _site_module


def calc_pts(scores, cfg):
    return _load_site_module()._award_calc_pts(scores, cfg)


def calc_ranks(scores):
    """사이트와 동일: 점수 내림차순, 동점이면 입력 순서가 앞선 쪽이 상위."""
    order = sorted(range(4), key=lambda i: scores[i], reverse=True)
    ranks = [0, 0, 0, 0]
    for rank, idx in enumerate(order):
        ranks[idx] = rank + 1
    return ranks


def parse_time(created_at):
    return datetime.strptime(created_at[:16], "%Y-%m-%dT%H:%M")


def load_games():
    """data/games.json → 시간순 정렬된 게임 목록 (rank/pt/time 포함)."""
    if not GAMES_JSON.exists():
        raise FileNotFoundError(f"{GAMES_JSON} 이 없습니다. 먼저 fetch_data.py를 실행하세요.")
    with open(GAMES_JSON, encoding="utf-8") as f:
        raw = json.load(f)["games"]
    cfg = load_mahjong_config()
    games = []
    for g in sorted(raw, key=lambda g: g["created_at"]):
        games.append({
            **g,
            "time": parse_time(g["created_at"]),
            "ranks": calc_ranks(g["scores"]),
            "pts": calc_pts(g["scores"], cfg),
        })
    return games
