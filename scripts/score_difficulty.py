"""
score_difficulty.py — Add a difficulty score and 1–5 star rating to every
puzzle in data/puzzles.json (and the matching .js).

Difficulty model: three signals computed off the BFS+DP analysis we already
do at runtime in shortestRoutes(start, dest), plus the puzzle's hop count.

  raw = α · (hops - 1)
      − β · log(1 + count)            // many shortest routes → easier
      − γ · max_route_fame            // a famous route exists → easier
      + δ · slot_tightness            // tight per-slot choices → harder

Where:
  count            = total number of distinct shortest paths (DP-counted).
  max_route_fame   = max over enumerated shortest routes of the average
                     log(1+degree) of the route's INTERMEDIATE airports
                     — i.e. "the most-recognizable shortest path the player
                     could plausibly find."
  slot_tightness   = 1 / geo_mean(distinct airports per intermediate slot)
                     across enumerated shortest routes.

The raw score is then mapped to 1–5 stars via population quintiles, so the
weights only need to be roughly sane — the bucketing absorbs scale issues.
"""
import json
import math
from collections import defaultdict, deque
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

# Weights — picked so that hops, fame, and tightness contribute on a similar
# magnitude to the raw score. Tweak only if the resulting star distribution
# looks visibly off.
ALPHA = 2.0   # per extra stop
BETA  = 0.7   # log dampener for route count
GAMMA = 0.9   # weight on max-fame across routes (subtracts difficulty)
DELTA = 4.0   # weight on slot tightness (adds difficulty)

# Cap on enumeration. We only need enumerate enough routes to capture slot
# diversity and the most-famous route; ~500 is plenty for any real puzzle.
MAX_ENUM = 500


def shortest_routes(start, dest, routes_adj, max_enum=MAX_ENUM):
    """Same BFS+DP as the in-browser version. Returns (count, [routes])."""
    if start == dest:
        return 1, [[start]]
    dist = {start: 0}
    parents = {start: []}
    q = deque([start])
    while q:
        n = q.popleft()
        d = dist[n]
        for nb in routes_adj.get(n, []):
            if nb not in dist:
                dist[nb] = d + 1
                parents[nb] = [n]
                q.append(nb)
            elif dist[nb] == d + 1:
                parents[nb].append(n)
    if dest not in dist:
        return 0, []

    memo = {}

    def count_to(node):
        if node == start:
            return 1
        if node in memo:
            return memo[node]
        total = 0
        for p in parents[node]:
            total += count_to(p)
        memo[node] = total
        return total

    count = count_to(dest)

    # Enumerate up to max_enum shortest routes
    routes = []

    def recurse(node, suffix):
        if len(routes) >= max_enum:
            return
        if node == start:
            routes.append([start] + suffix)
            return
        for p in parents[node]:
            if len(routes) >= max_enum:
                return
            recurse(p, [node] + suffix)

    recurse(dest, [])
    return count, routes


def difficulty_features(puzzle, routes_adj):
    start = puzzle["start"]
    dest = puzzle["dest"]
    hops = puzzle["shortest_hops"]
    count, routes = shortest_routes(start, dest, routes_adj)

    if count == 0:
        return {"raw": 0.0, "count": 0, "max_fame": 0.0, "tightness": 0.0}

    # Direct flight — trivial; pin to the easiest end of the scale.
    if hops <= 1:
        return {
            "raw": -10.0,
            "count": count,
            "max_fame": 0.0,
            "tightness": 0.0,
        }

    # 1) Max route fame across enumerated shortest routes.
    max_fame = -math.inf
    for route in routes:
        intermediates = route[1:-1]
        if not intermediates:
            continue
        fames = [math.log(1 + len(routes_adj.get(c, []))) for c in intermediates]
        avg_fame = sum(fames) / len(fames)
        if avg_fame > max_fame:
            max_fame = avg_fame
    if max_fame == -math.inf:
        max_fame = 0.0

    # 2) Slot tightness: distinct airports per intermediate slot.
    slot_sets = defaultdict(set)
    for route in routes:
        for k, code in enumerate(route[1:-1]):
            slot_sets[k].add(code)
    if slot_sets:
        widths = [len(s) for s in slot_sets.values()]
        log_geo = sum(math.log(w) for w in widths) / len(widths)
        tightness = math.exp(-log_geo)  # 1/geo_mean
    else:
        tightness = 0.0

    # 3) Combine.
    raw = (
        ALPHA * (hops - 1)
        - BETA * math.log(1 + count)
        - GAMMA * max_fame
        + DELTA * tightness
    )

    return {
        "raw": raw,
        "count": count,
        "max_fame": max_fame,
        "tightness": tightness,
    }


def quintile_bucket(values):
    """Return a function val → 1..5 based on quintile thresholds."""
    sorted_vals = sorted(values)
    n = len(sorted_vals)

    def at(p):
        return sorted_vals[min(n - 1, int(n * p))]

    p20, p40, p60, p80 = at(0.20), at(0.40), at(0.60), at(0.80)

    def stars(v):
        if v <= p20:
            return 1
        if v <= p40:
            return 2
        if v <= p60:
            return 3
        if v <= p80:
            return 4
        return 5

    return stars, (p20, p40, p60, p80)


def main():
    airports = json.loads((DATA / "airports.json").read_text())
    routes = json.loads((DATA / "routes.json").read_text())
    puzzles = json.loads((DATA / "puzzles.json").read_text())

    print(f"Loaded {len(puzzles)} puzzles, {len(airports)} airports, "
          f"{sum(len(v) for v in routes.values())//2} unique flight pairs.")

    feats = [difficulty_features(p, routes) for p in puzzles]
    raws = [f["raw"] for f in feats]
    star_fn, thresholds = quintile_bucket(raws)
    print("Quintile thresholds (raw): "
          f"p20={thresholds[0]:.2f}  p40={thresholds[1]:.2f}  "
          f"p60={thresholds[2]:.2f}  p80={thresholds[3]:.2f}")

    # Annotate each puzzle in-place.
    star_dist = defaultdict(int)
    for p, f in zip(puzzles, feats):
        s = star_fn(f["raw"])
        p["difficulty"] = round(f["raw"], 3)
        p["stars"] = s
        # Light-weight diagnostics; useful when designing UI later.
        p["alt_count"] = f["count"]
        star_dist[s] += 1

    print("\nStar distribution:")
    for s in sorted(star_dist):
        print(f"  {'★' * s + '☆' * (5 - s)}  {star_dist[s]} puzzles")

    # Sanity: print a couple from each tier.
    print("\nSamples from each tier:")
    by_tier = defaultdict(list)
    for p in puzzles:
        by_tier[p["stars"]].append(p)
    for s in sorted(by_tier):
        sample = by_tier[s][:3]
        for p in sample:
            print(f"  {s}★  {p['start']}→{p['dest']}  "
                  f"hops={p['shortest_hops']}  "
                  f"alt={p['alt_count']}  raw={p['difficulty']}")

    # Persist annotated copies — overwrite both .json and .js.
    (DATA / "puzzles.json").write_text(json.dumps(puzzles))
    (DATA / "puzzles.js").write_text(
        "window.PUZZLES = " + json.dumps(puzzles) + ";\n"
    )
    print(f"\nWrote data/puzzles.json  {(DATA / 'puzzles.json').stat().st_size // 1024} KB")
    print(f"Wrote data/puzzles.js    {(DATA / 'puzzles.js').stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
