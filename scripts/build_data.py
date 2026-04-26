"""
Build Flightly's airport + route dataset from OpenFlights data.

Input  (dropped into data/openflights/):
  airports.dat.txt  — raw OpenFlights airports list
  routes.dat.txt    — raw OpenFlights routes list

Output (data/):
  airports.json   {iata: {name, city, country, lat, lon, tier}}
  routes.json     {iata: [iata, ...]}  (adjacency list, bidirectional)
  puzzles.json    [{start, dest, shortest_hops}, ...]
  airports.js     window.AIRPORTS = {...}
  routes.js       window.ROUTES = {...}
  puzzles.js      window.PUZZLES = [...]
"""
import csv
import json
import random
from collections import defaultdict, deque
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
OF = DATA / "openflights"
DATA.mkdir(exist_ok=True)

# ---------------------------------------------------------------
# OpenFlights airport columns:
#   0  id
#   1  name
#   2  city
#   3  country
#   4  iata (3 letters or \N)
#   5  icao
#   6  latitude
#   7  longitude
#   8  altitude
#   9  tz offset
#  10  dst
#  11  tz name
#  12  type
#  13  source
# ---------------------------------------------------------------
def parse_airports():
    """Return dict keyed by IATA with basic airport info."""
    airports = {}
    with open(OF / "airports.dat.txt", encoding="utf-8", newline="") as f:
        reader = csv.reader(f)
        for row in reader:
            if len(row) < 13:
                continue
            iata = row[4].strip()
            atype = row[12].strip().lower()
            if len(iata) != 3 or iata == "\\N":
                continue
            if atype and atype != "airport":
                # OpenFlights has train stations, heliports, etc. Skip those.
                continue
            try:
                lat = float(row[6])
                lon = float(row[7])
            except ValueError:
                continue
            # Prefer first-seen entry per IATA (occasional duplicates)
            if iata in airports:
                continue
            airports[iata] = {
                "name": row[1].strip(),
                "city": row[2].strip(),
                "country": row[3].strip(),
                "lat": lat,
                "lon": lon,
            }
    return airports

# ---------------------------------------------------------------
# OpenFlights routes columns:
#   0  airline
#   1  airline id
#   2  src iata
#   3  src id
#   4  dst iata
#   5  dst id
#   6  codeshare (Y or empty)
#   7  stops
#   8  equipment
# ---------------------------------------------------------------
def parse_routes(airports):
    """Return adjacency map (set) restricted to known airports, direct flights only."""
    adj = defaultdict(set)
    with open(OF / "routes.dat.txt", encoding="utf-8", newline="") as f:
        reader = csv.reader(f)
        for row in reader:
            if len(row) < 9:
                continue
            src, dst = row[2].strip(), row[4].strip()
            stops = row[7].strip()
            if stops and stops != "0":
                continue
            if src not in airports or dst not in airports:
                continue
            if src == dst:
                continue
            adj[src].add(dst)
            adj[dst].add(src)  # treat routes as bidirectional for the game
    return {k: sorted(v) for k, v in adj.items()}

# ---------------------------------------------------------------
# Filter airports to those with real commercial service (≥ 2 routes)
# and assign tiers by route count.
# ---------------------------------------------------------------
def filter_and_tier(airports, adj, min_routes=2):
    filtered = {k: v for k, v in airports.items() if len(adj.get(k, [])) >= min_routes}
    # Prune adjacency to only include surviving airports
    pruned = {}
    for k, nbs in adj.items():
        if k not in filtered:
            continue
        pruned[k] = sorted([n for n in nbs if n in filtered])
    # After pruning, some airports may have < min_routes. Iterate until stable.
    changed = True
    while changed:
        changed = False
        drops = [k for k, nbs in pruned.items() if len(nbs) < min_routes]
        for k in drops:
            filtered.pop(k, None)
            pruned.pop(k, None)
            changed = True
        if changed:
            pruned = {k: [n for n in nbs if n in filtered] for k, nbs in pruned.items()}

    # Tier assignment based on route count rank
    counts = sorted(((k, len(v)) for k, v in pruned.items()),
                    key=lambda t: (-t[1], t[0]))
    n = len(counts)
    t1_cut = 60      # top 60 = Tier 1 mega-hubs
    t2_cut = 300     # next ~240 = Tier 2 majors
    tiers = {}
    for i, (k, _) in enumerate(counts):
        if i < t1_cut:     tiers[k] = 1
        elif i < t2_cut:   tiers[k] = 2
        else:              tiers[k] = 3

    for k in filtered:
        filtered[k]["tier"] = tiers[k]
    return filtered, pruned

# ---------------------------------------------------------------
# BFS helpers.
# ---------------------------------------------------------------
def bfs_dist(adj, source, limit=8):
    dist = {source: 0}
    q = deque([source])
    while q:
        n = q.popleft()
        d = dist[n]
        if d >= limit:
            continue
        for nb in adj.get(n, []):
            if nb not in dist:
                dist[nb] = d + 1
                q.append(nb)
    return dist

def shortest_hops(adj, a, b, limit=6):
    if a == b:
        return 0
    dist = bfs_dist(adj, a, limit=limit)
    return dist.get(b)

# ---------------------------------------------------------------
# Build puzzle pool: a BALANCED mix of difficulties biased toward
# recognizable, well-connected airports.
# ---------------------------------------------------------------
def build_puzzles(airports, adj, n_per_bucket=None):
    if n_per_bucket is None:
        n_per_bucket = {2: 60, 3: 120, 4: 140, 5: 80}
    random.seed(42)
    codes = list(airports.keys())
    # Weighted sampling: favor tier 1/2 airports as puzzle endpoints
    # so daily puzzles feature airports players will recognize.
    t1 = [c for c in codes if airports[c]["tier"] == 1]
    t2 = [c for c in codes if airports[c]["tier"] == 2]
    t3 = [c for c in codes if airports[c]["tier"] == 3]

    def pick_pair():
        r = random.random()
        if r < 0.55:  # both from tier 1/2
            pool = t1 + t2
            return random.sample(pool, 2)
        elif r < 0.90:  # one from tier 1/2, one from any
            a = random.choice(t1 + t2)
            b = random.choice(codes)
            return [a, b] if a != b else pick_pair()
        else:  # any
            return random.sample(codes, 2)

    buckets = {2: [], 3: [], 4: [], 5: []}
    seen = set()
    attempts = 0
    max_attempts = 500000
    while attempts < max_attempts and any(len(buckets[h]) < n_per_bucket[h] for h in buckets):
        attempts += 1
        a, b = pick_pair()
        pair = (a, b)
        if pair in seen:
            continue
        seen.add(pair)
        hops = shortest_hops(adj, a, b, limit=6)
        if hops is None or hops < 2 or hops > 5:
            continue
        if len(buckets[hops]) < n_per_bucket[hops]:
            buckets[hops].append({
                "start": a, "dest": b, "shortest_hops": hops,
            })

    puzzles = []
    for h in (2, 3, 4, 5):
        puzzles.extend(buckets[h])
    puzzles.sort(key=lambda p: (p["shortest_hops"], p["start"]))
    return puzzles

# ---------------------------------------------------------------
# For airports.json we also strip some heavy data to keep the file
# light; the game doesn't need timezone etc.
# ---------------------------------------------------------------
def airports_for_game(filtered):
    out = {}
    for k, v in filtered.items():
        out[k] = {
            "name": v["name"],
            "city": v["city"],
            "country": v["country"],
            "lat": round(v["lat"], 4),
            "lon": round(v["lon"], 4),
            "tier": v["tier"],
        }
    return out

def main():
    print("Parsing OpenFlights airports…")
    raw_airports = parse_airports()
    print(f"  raw airports with IATA: {len(raw_airports)}")

    print("Parsing OpenFlights routes…")
    adj = parse_routes(raw_airports)
    total_edges = sum(len(v) for v in adj.values())
    print(f"  directed edges: {total_edges}  ({total_edges//2} unique pairs)")

    print("Filtering to commercially-served airports…")
    filtered, pruned = filter_and_tier(raw_airports, adj, min_routes=2)
    print(f"  airports kept: {len(filtered)}")
    tiers = defaultdict(int)
    for v in filtered.values(): tiers[v["tier"]] += 1
    for t in sorted(tiers):
        print(f"    tier {t}: {tiers[t]} airports")
    total_edges2 = sum(len(v) for v in pruned.values())
    print(f"  edges after filtering: {total_edges2}  ({total_edges2//2} unique pairs)")

    print("Building puzzle pool…")
    puzzles = build_puzzles(filtered, pruned)
    dist = defaultdict(int)
    for p in puzzles: dist[p["shortest_hops"]-1] += 1
    print(f"  puzzles: {len(puzzles)}")
    for stops in sorted(dist):
        print(f"    {stops} stop(s): {dist[stops]} puzzles")

    airports_game = airports_for_game(filtered)

    (DATA / "airports.json").write_text(json.dumps(airports_game))
    (DATA / "routes.json").write_text(json.dumps(pruned))
    (DATA / "puzzles.json").write_text(json.dumps(puzzles))
    (DATA / "airports.js").write_text("window.AIRPORTS = " + json.dumps(airports_game) + ";\n")
    (DATA / "routes.js").write_text("window.ROUTES = " + json.dumps(pruned) + ";\n")
    (DATA / "puzzles.js").write_text("window.PUZZLES = " + json.dumps(puzzles) + ";\n")

    print("\nFiles written.")
    for f in ["airports.json", "routes.json", "puzzles.json",
              "airports.js", "routes.js", "puzzles.js"]:
        print(f"  data/{f}  {(DATA / f).stat().st_size // 1024} KB")

if __name__ == "__main__":
    main()
