"""실제 대국 기반 관계(단짝·라이벌): 같은 판에서 누가 위였는지와 동석 판 수."""
from collections import defaultdict

MIN_CO_RIVAL = 8      # 라이벌 판정 최소 동석 판 수
RIVAL_BAND = 0.05     # 50%±5%면 라이벌


def head_to_head(games, names):
    """names 사이의 (a, b) → {"co": 동석 판 수, "above": a가 b보다 위였던 판 수}."""
    target = set(names)
    h2h = defaultdict(lambda: {"co": 0, "above": 0})
    for g in games:
        seats = [(n, r) for n, r in zip(g["names"], g["ranks"]) if n in target]
        for a, ra in seats:
            for b, rb in seats:
                if a == b:
                    continue
                h2h[(a, b)]["co"] += 1
                if ra < rb:
                    h2h[(a, b)]["above"] += 1
    return h2h


def relations_for(name, names, h2h, min_list=3):
    """name 기준 동석 상대 목록과 대표 관계(단짝/라이벌)."""
    rows = []
    for other in names:
        if other == name:
            continue
        st = h2h.get((name, other))
        if not st or st["co"] < min_list:
            continue
        rows.append({"name": other, "co": st["co"], "win_rate": round(st["above"] / st["co"], 3)})
    rows.sort(key=lambda r: -r["co"])

    picks = {}
    if rows:
        picks["단짝"] = rows[0]["name"]
    rivals = [r for r in rows if r["co"] >= MIN_CO_RIVAL and abs(r["win_rate"] - 0.5) <= RIVAL_BAND
              and r["name"] != picks.get("단짝")]
    if rivals:
        picks["라이벌"] = max(rivals, key=lambda r: r["co"])["name"]

    labels = defaultdict(list)
    for label, other in picks.items():
        labels[other].append(label)
    for r in rows:
        r["labels"] = labels.get(r["name"], [])
    return rows
