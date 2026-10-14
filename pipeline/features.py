"""플레이어별 특징 계산.

compute_features(games) → (feat_df, display_df, partners)
  feat_df    : 벡터에 들어가는 특징 (소표본 보정 적용, 원래 단위). MIN_GAMES_PROJECT판 이상 전원
  display_df : 화면 표시 전용 지표 (평균 순위, 평균 pt 등). core=True가 MIN_GAMES판 이상(학습 대상)
  partners   : 이름 → [(동석자, 판수), ...] 내림차순
build_matrix(feat_df, weights, core) → core 기준 z-score + 그룹 가중 스케일링된 numpy 행렬
"""
import math
from collections import Counter, defaultdict
from datetime import timedelta

import numpy as np
import pandas as pd

from .common import MIN_GAMES, MIN_GAMES_PROJECT

RUN_GAP = timedelta(hours=3)   # 직전 판과 3시간 이내면 같은 묶음
RUN_MIN = 3                    # 3판 이상 묶음만 '연속'
STREAK_MIN = 3                 # 연대 3연속 이상
PRIOR = 10                     # 경험적 베이즈 사전 강도(판)
PRIOR_SMALL = 5                # 조건부 평균(1위 시 점수 등)의 사전 강도

FEATURE_GROUPS = {
    "rank":   ["r1", "r2", "r3", "r4"],
    "score":  ["score_std", "big_win_rate", "tobi_rate", "flat_rate", "win_margin", "loss_floor"],
    "flow":   ["streak_top2", "recovery", "trend"],
    "life":   ["time_day", "time_evening", "time_night", "weekend_rate",
               "run_freq", "avg_run_len", "max_run"],
    "social": ["partner_diversity", "top1_share", "top3_share", "top5_share", "opp_strength"],
}
DEFAULT_WEIGHTS = {"rank": 0.4, "score": 1.0, "flow": 0.7, "life": 0.5, "social": 0.5}

FEATURE_LABELS = {
    "r1": "톱률", "r2": "2착률", "r3": "3착률", "r4": "라스율",
    "score_std": "점수 기복", "big_win_rate": "대톱률(5만점+)", "tobi_rate": "토비율",
    "flat_rate": "원점 부근 종국률", "win_margin": "톱 시 평균 점수", "loss_floor": "라스 시 평균 점수",
    "streak_top2": "연속 연대율(3연대+)", "recovery": "라스 후 회복", "trend": "순위 추세",
    "time_day": "낮 대국(12~17시)", "time_evening": "저녁 대국(17~22시)", "time_night": "심야 대국(22~12시)",
    "weekend_rate": "주말 대국", "run_freq": "연속 대국 빈도", "avg_run_len": "연속 대국 길이",
    "max_run": "최다 연속 대국",
    "partner_diversity": "동탁자 다양성", "top1_share": "최다 동탁자 비중", "top3_share": "동탁 Top3 비중",
    "top5_share": "동탁 Top5 비중", "opp_strength": "동탁자 실력",
}


def _shrink_rate(count, n, prior_rate, k=PRIOR):
    return (count + k * prior_rate) / (n + k)


def _shrink_mean(values, prior_mean, k=PRIOR_SMALL):
    return (sum(values) + k * prior_mean) / (len(values) + k)


def _runs(flags):
    """True가 STREAK_MIN개 이상 이어진 구간에 속한 원소 수."""
    total, cur = 0, 0
    for f in list(flags) + [False]:
        if f:
            cur += 1
        else:
            if cur >= STREAK_MIN:
                total += cur
            cur = 0
    return total


def _max_consec(values, target):
    best = cur = 0
    for v in values:
        cur = cur + 1 if v == target else 0
        best = max(best, cur)
    return best


def _sessions(times):
    """시간순 timestamp 목록 → 묶음 길이 목록 (직전 판과 RUN_GAP 이내면 같은 묶음)."""
    lengths, cur = [], 1
    for prev, now in zip(times, times[1:]):
        if now - prev <= RUN_GAP:
            cur += 1
        else:
            lengths.append(cur)
            cur = 1
    lengths.append(cur)
    return lengths


def _per_player_records(games):
    recs = defaultdict(list)
    for g in games:
        for i, name in enumerate(g["names"]):
            if not name:
                continue
            recs[name].append({
                "time": g["time"], "rank": g["ranks"][i], "score": g["scores"][i],
                "pt": g["pts"][i],
                "opps": [g["names"][j] for j in range(4) if j != i and g["names"][j]],
            })
    return recs


def compute_features(games, min_games=MIN_GAMES_PROJECT, core_min=MIN_GAMES):
    recs = _per_player_records(games)
    avg_rank_all = {n: np.mean([r["rank"] for r in rs]) for n, rs in recs.items()}
    n_players_all = len(recs)

    # 모집단(전체 플레이어-판) 기준 사전값
    all_rows = [r for rs in recs.values() for r in rs]
    pop = {
        "r": [np.mean([r["rank"] == k for r in all_rows]) for k in (1, 2, 3, 4)],
        "big": np.mean([r["score"] >= 50000 for r in all_rows]),
        "tobi": np.mean([r["score"] < 0 for r in all_rows]),
        "flat": np.mean([20000 <= r["score"] <= 30000 for r in all_rows]),
        "win_score": np.mean([r["score"] for r in all_rows if r["rank"] == 1]),
        "loss_score": np.mean([r["score"] for r in all_rows if r["rank"] == 4]),
        "day": np.mean([12 <= r["time"].hour < 17 for r in all_rows]),
        "evening": np.mean([17 <= r["time"].hour < 22 for r in all_rows]),
        "weekend": np.mean([r["time"].weekday() >= 5 for r in all_rows]),
    }
    pop["night"] = 1 - pop["day"] - pop["evening"]

    eligible = {n: rs for n, rs in recs.items() if len(rs) >= min_games}
    core = {n: rs for n, rs in eligible.items() if len(rs) >= core_min}

    # 연대 3연속 비율·4위 후 회복력·연속 빈도의 모집단 사전값 (학습 대상자 평균)
    def _streak_raw(rs):
        return _runs([r["rank"] <= 2 for r in rs]) / len(rs)
    pop["streak"] = np.mean([_streak_raw(rs) for rs in core.values()])
    rec_pairs = []
    for rs in core.values():
        for a, b in zip(rs, rs[1:]):
            if a["rank"] == 4 and b["time"] - a["time"] <= RUN_GAP:
                rec_pairs.append(b["rank"])
    pop["recovery"] = np.mean(rec_pairs) if rec_pairs else 2.5
    all_sessions = [_sessions([r["time"] for r in rs]) for rs in core.values()]
    pop["run_freq"] = np.mean([l >= RUN_MIN for ss in all_sessions for l in ss])

    feat_rows, disp_rows, partners = {}, {}, {}
    for name, rs in eligible.items():
        n = len(rs)
        ranks = [r["rank"] for r in rs]
        scores = [r["score"] for r in rs]
        times = [r["time"] for r in rs]
        rc = [ranks.count(k) for k in (1, 2, 3, 4)]

        f = {}
        for k in range(4):
            f[f"r{k+1}"] = _shrink_rate(rc[k], n, pop["r"][k])

        f["score_std"] = float(np.std(scores, ddof=1))
        f["big_win_rate"] = _shrink_rate(sum(s >= 50000 for s in scores), n, pop["big"])
        f["tobi_rate"] = _shrink_rate(sum(s < 0 for s in scores), n, pop["tobi"])
        f["flat_rate"] = _shrink_rate(sum(20000 <= s <= 30000 for s in scores), n, pop["flat"])
        f["win_margin"] = _shrink_mean([r["score"] for r in rs if r["rank"] == 1], pop["win_score"])
        f["loss_floor"] = _shrink_mean([r["score"] for r in rs if r["rank"] == 4], pop["loss_score"])

        f["streak_top2"] = _shrink_rate(_runs([k <= 2 for k in ranks]), n, pop["streak"])
        nxt = [b["rank"] for a, b in zip(rs, rs[1:])
               if a["rank"] == 4 and b["time"] - a["time"] <= RUN_GAP]
        # 순위가 낮을수록 좋으므로 부호를 뒤집어 '클수록 회복력 좋음'
        f["recovery"] = -_shrink_mean(nxt, pop["recovery"])
        # 판 진행(0→1)에 대한 순위 회귀 기울기, 부호 반전해 '클수록 성장'
        x = np.linspace(0, 1, n)
        f["trend"] = -float(np.polyfit(x, ranks, 1)[0]) * n / (n + PRIOR)

        hours = [t.hour for t in times]
        f["time_day"] = _shrink_rate(sum(12 <= h < 17 for h in hours), n, pop["day"])
        f["time_evening"] = _shrink_rate(sum(17 <= h < 22 for h in hours), n, pop["evening"])
        f["time_night"] = _shrink_rate(sum(h >= 22 or h < 12 for h in hours), n, pop["night"])
        f["weekend_rate"] = _shrink_rate(sum(t.weekday() >= 5 for t in times), n, pop["weekend"])

        sess = _sessions(times)
        runs = [l for l in sess if l >= RUN_MIN]
        f["run_freq"] = _shrink_rate(len(runs), len(sess), pop["run_freq"])
        f["avg_run_len"] = float(np.mean(runs)) if runs else 0.0
        f["max_run"] = float(max(sess))

        co = Counter(o for r in rs for o in r["opps"])
        ranked_co = co.most_common()
        slots = sum(co.values())
        probs = np.array([c for _, c in ranked_co]) / slots
        entropy = float(-(probs * np.log(probs)).sum())
        f["partner_diversity"] = entropy / math.log(n_players_all - 1)
        for k in (1, 3, 5):
            f[f"top{k}_share"] = sum(c for _, c in ranked_co[:k]) / slots
        # 상대들의 통산 평균 순위 → 2.5 기준으로 '클수록 강한 상대'
        f["opp_strength"] = 2.5 - float(np.mean([avg_rank_all[o] for r in rs for o in r["opps"]]))

        feat_rows[name] = f
        partners[name] = ranked_co[:5]
        disp_rows[name] = {
            "games": n,
            "core": n >= core_min,
            "avg_rank": float(np.mean(ranks)),
            "rank_counts": rc,
            "top2_rate": (rc[0] + rc[1]) / n,
            "last_avoid_rate": 1 - rc[3] / n,
            "avg_pt": float(np.mean([r["pt"] for r in rs])),
            "total_pt": float(sum(r["pt"] for r in rs)),
            "score_mean": float(np.mean(scores)),
            "max_score": max(scores),
            "max_consec_1st": _max_consec(ranks, 1),
            "max_consec_4th": _max_consec(ranks, 4),
            "first_game": times[0].strftime("%Y-%m-%d"),
            "last_game": times[-1].strftime("%Y-%m-%d"),
        }

    cols = [c for g in FEATURE_GROUPS.values() for c in g]
    feat_df = pd.DataFrame.from_dict(feat_rows, orient="index")[cols]
    display_df = pd.DataFrame.from_dict(disp_rows, orient="index")
    return feat_df, display_df, partners


def zscore(feat_df, core=None):
    """core(불리언 Series)가 주어지면 학습 대상의 평균·표준편차로 전원을 표준화."""
    ref = feat_df if core is None else feat_df[core]
    std = ref.std(ddof=0).replace(0, 1)
    return (feat_df - ref.mean()) / std


def build_matrix(feat_df, weights=None, core=None):
    weights = {**DEFAULT_WEIGHTS, **(weights or {})}
    z = zscore(feat_df, core)
    parts = []
    for group, cols in FEATURE_GROUPS.items():
        w = weights[group] / math.sqrt(len(cols))
        if w:
            parts.append(z[cols].to_numpy() * w)
    return np.hstack(parts)
