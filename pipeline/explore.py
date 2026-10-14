"""군집 탐색 리포트 (유형 이름을 정하기 위한 단계).

  python -m pipeline.explore                     # 기본 가중치, k 자동 선택
  python -m pipeline.explore --k 6 --w rank=0.2 --w life=0.3
  python -m pipeline.explore --residualize       # 스타일 특징에서 실력(평균 pt) 영향 제거

결과는 콘솔과 data/explore_report.md에 쓴다.
"""
import argparse
import io

import numpy as np
import pandas as pd

from .common import DATA_DIR, load_games
from .features import (DEFAULT_WEIGHTS, FEATURE_GROUPS, FEATURE_LABELS, build_matrix,
                       compute_features, zscore)
from .reduce_cluster import cluster_scan, kmeans, neighbors, pca_reduce


def residualize(feat_df, skill):
    """각 특징을 실력에 선형회귀한 잔차로 바꾼다 (평균은 유지)."""
    out = feat_df.copy()
    s = (skill - skill.mean()) / skill.std()
    for c in out.columns:
        beta = np.cov(out[c], s, ddof=0)[0, 1] / np.var(s)
        out[c] = out[c] - beta * s
    return out


def pick_k(scan):
    stable = [r for r in scan if r["seed_ari"] >= 0.8 and min(r["sizes"]) >= 2]
    pool = stable or scan
    return max(pool, key=lambda r: r["sil_kmeans"])["k"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--k", type=int)
    ap.add_argument("--w", action="append", default=[], help="그룹 가중치 group=value")
    ap.add_argument("--residualize", action="store_true")
    args = ap.parse_args()
    weights = {**DEFAULT_WEIGHTS}
    for kv in args.w:
        g, v = kv.split("=")
        weights[g] = float(v)

    games = load_games()
    feat_df, disp, partners = compute_features(games)
    # 탐색은 학습 대상(core)만으로, 관측 중인 사람은 마지막에 어디 붙는지만 본다
    core_mask = disp["core"].to_numpy()
    all_feat, all_disp = feat_df, disp
    X_all = build_matrix(all_feat, weights, disp["core"])
    feat_df, disp = feat_df[core_mask], disp[core_mask]
    skill = disp["avg_pt"]
    if args.residualize:
        feat_df = residualize(feat_df, skill)

    X = X_all[core_mask]
    Xp, evr = pca_reduce(X)
    scan = cluster_scan(Xp)
    k = args.k or pick_k(scan)
    labels = kmeans(Xp, k)
    z = zscore(feat_df)
    names = list(feat_df.index)

    buf = io.StringIO()
    p = lambda *a: print(*a, file=buf)

    p(f"# 군집 탐색 리포트\n")
    p(f"- 학습 대상 {len(names)}명 + 관측 중(투영) {int((~core_mask).sum())}명, 총 {len(games)}판")
    p(f"- 가중치: {weights}" + (" · 실력 잔차화 적용" if args.residualize else ""))
    p(f"- PCA {len(evr)}차원 누적 설명력: {evr.sum():.0%} (상위 3: {', '.join(f'{v:.0%}' for v in evr[:3])})\n")

    p("## 실력(평균 pt)과의 상관")
    corr = feat_df.apply(lambda c: np.corrcoef(c, skill)[0, 1]).sort_values(key=abs, ascending=False)
    p("| 특징 | r |\n|---|---|")
    for c, r in corr.items():
        flag = " ⚠" if abs(r) >= 0.6 else ""
        p(f"| {FEATURE_LABELS[c]} | {r:+.2f}{flag} |")
    p(f"\n- 연대 3연속 비율 vs 연대율 상관: {np.corrcoef(feat_df['streak_top2'], disp['top2_rate'])[0, 1]:+.2f}")
    pc1_skill = np.corrcoef(Xp[:, 0], skill)[0, 1]
    p(f"- PCA 1축 vs 실력 상관: {pc1_skill:+.2f} (|r|이 크면 지도가 실력 순으로 펼쳐짐)\n")

    p("## k별 군집 품질")
    p("| k | 실루엣(KMeans) | 실루엣(Ward) | 시드 안정성 ARI | KMeans↔Ward ARI | 군집 크기 |")
    p("|---|---|---|---|---|---|")
    for r in scan:
        mark = " ◀" if r["k"] == k else ""
        p(f"| {r['k']}{mark} | {r['sil_kmeans']:.3f} | {r['sil_agglo']:.3f} | {r['seed_ari']:.2f} | "
          f"{r['km_vs_agglo_ari']:.2f} | {r['sizes']} |")

    p(f"\n## 군집 프로필 (k={k})")
    p("특징 값은 전체 대상 대비 z-score (+는 평균보다 높음).\n")
    for c in sorted(set(labels), key=lambda c: -np.sum(labels == c)):
        idx = [i for i, l in enumerate(labels) if l == c]
        members = [names[i] for i in idx]
        mz = z.iloc[idx].mean().sort_values()
        p(f"### 군집 {c} — {len(members)}명 · 평균 pt {skill.iloc[idx].mean():+.1f} · "
          f"평균 순위 {disp['avg_rank'].iloc[idx].mean():.2f}")
        p(f"- 멤버: {', '.join(members)}")
        p("- 높음: " + ", ".join(f"{FEATURE_LABELS[f]} {v:+.1f}" for f, v in mz[::-1][:5].items() if v > 0.3))
        p("- 낮음: " + ", ".join(f"{FEATURE_LABELS[f]} {v:+.1f}" for f, v in mz[:5].items() if v < -0.3))
        grp = {g: z.iloc[idx][cols].mean(axis=1).mean() for g, cols in FEATURE_GROUPS.items()}
        p("- 그룹 평균 z: " + ", ".join(f"{g} {v:+.2f}" for g, v in grp.items()))
        p("")

    p("## 관측 중(10~19판) 플레이어의 투영 결과")
    from .reduce_cluster import MapModel
    model = MapModel(k).fit(X)
    _, all_labels, _ = model.transform(X_all, core_mask)
    all_names = list(all_feat.index)
    nb_all = neighbors(X_all, all_names, core_mask)
    for i, name in enumerate(all_names):
        if not core_mask[i]:
            sims = ", ".join(f"{n}({s:.2f})" for n, s in nb_all[name]["similar"])
            p(f"- {name}({all_disp['games'].iloc[i]}판) → 군집 {all_labels[i]} · 닮은꼴 {sims}")
    p("")

    p("## 닮은꼴 예시 (고차원 코사인)")
    nb = neighbors(X, names)
    for name in names[:8]:
        sims = ", ".join(f"{n}({s:.2f})" for n, s in nb[name]["similar"])
        p(f"- {name}: {sims} / 정반대 {nb[name]['opposite'][0]}")

    p("\n## 플레이어별 원값")
    show = feat_df.copy()
    show.insert(0, "군집", labels)
    show.insert(1, "판수", disp["games"])
    show.insert(2, "평균pt", skill.round(1))
    show = show.sort_values(["군집", "판수"], ascending=[True, False])
    p(show.round(3).to_markdown())

    report = buf.getvalue()
    print(report)
    DATA_DIR.mkdir(exist_ok=True)
    (DATA_DIR / "explore_report.md").write_text(report, encoding="utf-8")


if __name__ == "__main__":
    pd.set_option("display.width", 200)
    main()
