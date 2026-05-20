"""
build_continent_data.py — Annotate airports with a continent and generate
per-continent puzzle pools where:
  * start AND dest are in the same continent
  * only intra-continent routes are walkable
Difficulty is scored using the same model as score_difficulty.py, but on the
continent-restricted graph, so 1★/5★ are calibrated within each continent.

Outputs:
  data/airports.json + airports.js   (each airport gets `continent`)
  data/continent_routes.json + .js   (per-continent adjacency dict)
  data/continent_puzzles.json + .js  (per-continent puzzle pools)
"""
import json
import math
import random
from collections import defaultdict, deque
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

# ---------- 1. Country → continent map -------------------------------------
# Africa, Asia, Europe, North America, South America, Oceania.
# Caribbean and Central America fold into North America. Russia and Turkey
# are placed where their major airline operations live (Europe / Asia
# respectively — same convention as IATA region splits).
CONTINENT_OF = {
    # Africa
    "Algeria": "Africa", "Angola": "Africa", "Benin": "Africa",
    "Botswana": "Africa", "Burkina Faso": "Africa", "Burundi": "Africa",
    "Cameroon": "Africa", "Cape Verde": "Africa",
    "Central African Republic": "Africa", "Chad": "Africa",
    "Comoros": "Africa", "Congo (Brazzaville)": "Africa",
    "Congo (Kinshasa)": "Africa", "Cote d'Ivoire": "Africa",
    "Djibouti": "Africa", "Egypt": "Africa", "Equatorial Guinea": "Africa",
    "Eritrea": "Africa", "Ethiopia": "Africa", "Gabon": "Africa",
    "Gambia": "Africa", "Ghana": "Africa", "Guinea": "Africa",
    "Guinea-Bissau": "Africa", "Kenya": "Africa", "Liberia": "Africa",
    "Libya": "Africa", "Madagascar": "Africa", "Malawi": "Africa",
    "Mali": "Africa", "Mauritania": "Africa", "Mauritius": "Africa",
    "Mayotte": "Africa", "Morocco": "Africa", "Mozambique": "Africa",
    "Namibia": "Africa", "Niger": "Africa", "Nigeria": "Africa",
    "Reunion": "Africa", "Rwanda": "Africa",
    "Sao Tome and Principe": "Africa", "Senegal": "Africa",
    "Seychelles": "Africa", "Sierra Leone": "Africa", "Somalia": "Africa",
    "South Africa": "Africa", "South Sudan": "Africa", "Sudan": "Africa",
    "Tanzania": "Africa", "Togo": "Africa", "Tunisia": "Africa",
    "Uganda": "Africa", "Western Sahara": "Africa", "Zambia": "Africa",
    "Zimbabwe": "Africa",

    # Asia
    "Afghanistan": "Asia", "Armenia": "Asia", "Azerbaijan": "Asia",
    "Bahrain": "Asia", "Bangladesh": "Asia", "Bhutan": "Asia",
    "Brunei": "Asia", "Burma": "Asia", "Cambodia": "Asia", "China": "Asia",
    "Cyprus": "Asia", "East Timor": "Asia", "Georgia": "Asia",
    "Hong Kong": "Asia", "India": "Asia", "Indonesia": "Asia",
    "Iran": "Asia", "Iraq": "Asia", "Israel": "Asia", "Japan": "Asia",
    "Jordan": "Asia", "Kazakhstan": "Asia", "Kuwait": "Asia",
    "Kyrgyzstan": "Asia", "Laos": "Asia", "Lebanon": "Asia", "Macau": "Asia",
    "Malaysia": "Asia", "Maldives": "Asia", "Mongolia": "Asia",
    "Nepal": "Asia", "North Korea": "Asia", "Oman": "Asia",
    "Pakistan": "Asia", "Philippines": "Asia", "Qatar": "Asia",
    "Saudi Arabia": "Asia", "Singapore": "Asia", "South Korea": "Asia",
    "Sri Lanka": "Asia", "Syria": "Asia", "Taiwan": "Asia",
    "Tajikistan": "Asia", "Thailand": "Asia", "Turkey": "Asia",
    "Turkmenistan": "Asia", "United Arab Emirates": "Asia",
    "Uzbekistan": "Asia", "Vietnam": "Asia", "Yemen": "Asia",

    # Europe
    "Albania": "Europe", "Austria": "Europe", "Belarus": "Europe",
    "Belgium": "Europe", "Bosnia and Herzegovina": "Europe",
    "Bulgaria": "Europe", "Croatia": "Europe", "Czech Republic": "Europe",
    "Denmark": "Europe", "Estonia": "Europe", "Faroe Islands": "Europe",
    "Finland": "Europe", "France": "Europe", "Germany": "Europe",
    "Gibraltar": "Europe", "Greece": "Europe", "Guernsey": "Europe",
    "Hungary": "Europe", "Iceland": "Europe", "Ireland": "Europe",
    "Isle of Man": "Europe", "Italy": "Europe", "Jersey": "Europe",
    "Latvia": "Europe", "Lithuania": "Europe", "Luxembourg": "Europe",
    "Macedonia": "Europe", "Malta": "Europe", "Moldova": "Europe",
    "Montenegro": "Europe", "Netherlands": "Europe", "Norway": "Europe",
    "Poland": "Europe", "Portugal": "Europe", "Romania": "Europe",
    "Russia": "Europe", "Serbia": "Europe", "Slovakia": "Europe",
    "Slovenia": "Europe", "Spain": "Europe", "Sweden": "Europe",
    "Switzerland": "Europe", "Ukraine": "Europe", "United Kingdom": "Europe",

    # North America (incl. Caribbean & Central America)
    "Anguilla": "North America", "Antigua and Barbuda": "North America",
    "Aruba": "North America", "Bahamas": "North America",
    "Barbados": "North America", "Belize": "North America",
    "Bermuda": "North America", "British Virgin Islands": "North America",
    "Canada": "North America", "Cayman Islands": "North America",
    "Costa Rica": "North America", "Cuba": "North America",
    "Dominica": "North America", "Dominican Republic": "North America",
    "El Salvador": "North America", "Greenland": "North America",
    "Grenada": "North America", "Guadeloupe": "North America",
    "Guatemala": "North America", "Haiti": "North America",
    "Honduras": "North America", "Jamaica": "North America",
    "Martinique": "North America", "Mexico": "North America",
    "Netherlands Antilles": "North America", "Nicaragua": "North America",
    "Panama": "North America", "Puerto Rico": "North America",
    "Saint Kitts and Nevis": "North America", "Saint Lucia": "North America",
    "Saint Pierre and Miquelon": "North America",
    "Saint Vincent and the Grenadines": "North America",
    "Trinidad and Tobago": "North America",
    "Turks and Caicos Islands": "North America",
    "United States": "North America", "Virgin Islands": "North America",

    # South America
    "Argentina": "South America", "Bolivia": "South America",
    "Brazil": "South America", "Chile": "South America",
    "Colombia": "South America", "Ecuador": "South America",
    "Falkland Islands": "South America", "French Guiana": "South America",
    "Guyana": "South America", "Paraguay": "South America",
    "Peru": "South America", "Suriname": "South America",
    "Uruguay": "South America", "Venezuela": "South America",

    # Oceania
    "Australia": "Oceania", "Cook Islands": "Oceania", "Fiji": "Oceania",
    "French Polynesia": "Oceania", "Guam": "Oceania", "Kiribati": "Oceania",
    "Marshall Islands": "Oceania", "Micronesia": "Oceania",
    "Nauru": "Oceania", "New Caledonia": "Oceania",
    "New Zealand": "Oceania", "Norfolk Island": "Oceania",
    "Northern Mariana Islands": "Oceania", "Palau": "Oceania",
    "Papua New Guinea": "Oceania", "Samoa": "Oceania",
    "Solomon Islands": "Oceania", "Tonga": "Oceania", "Vanuatu": "Oceania",
    "Wallis and Futuna": "Oceania",
}

CONTINENTS = ["Africa", "Asia", "Europe", "North America",
              "South America", "Oceania"]

# Difficulty weights — same as score_difficulty.py.
ALPHA, BETA, GAMMA, DELTA = 2.0, 0.7, 0.9, 4.0
MAX_ENUM = 500

# Puzzle generation knobs (per continent).
TARGET_PER_CONTINENT = 80          # rough cap; smaller continents get fewer
MIN_HOPS = 2                        # require at least 1 stop
MAX_HOPS = 4
SEED = 2026


# ---------- 2. Helpers (BFS, DP, scoring) ----------------------------------
def bfs_distances(adj, start):
    dist = {start: 0}
    q = deque([start])
    while q:
        n = q.popleft()
        for nb in adj.get(n, []):
            if nb not in dist:
                dist[nb] = dist[n] + 1
                q.append(nb)
    return dist


def shortest_routes(start, dest, adj, max_enum=MAX_ENUM):
    if start == dest:
        return 1, [[start]]
    dist = {start: 0}
    parents = {start: []}
    q = deque([start])
    while q:
        n = q.popleft()
        for nb in adj.get(n, []):
            if nb not in dist:
                dist[nb] = dist[n] + 1
                parents[nb] = [n]
                q.append(nb)
            elif dist[nb] == dist[n] + 1:
                parents[nb].append(n)
    if dest not in dist:
        return 0, []

    memo = {}

    def count_to(node):
        if node == start:
            return 1
        if node in memo:
            return memo[node]
        total = sum(count_to(p) for p in parents[node])
        memo[node] = total
        return total

    count = count_to(dest)

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


def difficulty_features(start, dest, hops, adj):
    count, routes = shortest_routes(start, dest, adj)
    if count == 0:
        return {"raw": 0.0, "count": 0}
    if hops <= 1:
        return {"raw": -10.0, "count": count}

    max_fame = -math.inf
    for route in routes:
        intermediates = route[1:-1]
        if not intermediates:
            continue
        fames = [math.log(1 + len(adj.get(c, []))) for c in intermediates]
        avg = sum(fames) / len(fames)
        if avg > max_fame:
            max_fame = avg
    if max_fame == -math.inf:
        max_fame = 0.0

    slot_sets = defaultdict(set)
    for route in routes:
        for k, code in enumerate(route[1:-1]):
            slot_sets[k].add(code)
    if slot_sets:
        widths = [len(s) for s in slot_sets.values()]
        log_geo = sum(math.log(w) for w in widths) / len(widths)
        tightness = math.exp(-log_geo)
    else:
        tightness = 0.0

    raw = (
        ALPHA * (hops - 1)
        - BETA * math.log(1 + count)
        - GAMMA * max_fame
        + DELTA * tightness
    )
    return {"raw": raw, "count": count}


def quintile_bucket(values):
    if not values:
        return (lambda v: 1), (0, 0, 0, 0)
    sv = sorted(values)
    n = len(sv)

    def at(p):
        return sv[min(n - 1, int(n * p))]

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


# ---------- 3. Build continent puzzle pools --------------------------------
def restrict_routes(routes_adj, allowed_codes):
    """Return adjacency restricted to airports in `allowed_codes`."""
    out = {}
    for code, nbrs in routes_adj.items():
        if code not in allowed_codes:
            continue
        kept = [n for n in nbrs if n in allowed_codes]
        if kept:
            out[code] = kept
    return out


def build_pool(continent_codes, restricted_adj, target):
    """Generate up to `target` puzzles within the continent's subgraph."""
    rng = random.Random(SEED + hash(tuple(sorted(continent_codes))) % 1000)
    # Connected airports only (those with at least one intra-continent route).
    pool = sorted(restricted_adj.keys())
    if len(pool) < 2:
        return []

    seen = set()
    puzzles = []
    attempts = 0
    max_attempts = target * 200
    while len(puzzles) < target and attempts < max_attempts:
        attempts += 1
        a = rng.choice(pool)
        b = rng.choice(pool)
        if a == b or (a, b) in seen:
            continue
        seen.add((a, b))
        # Compute hops via BFS (single-source so we cache per `a`).
        dist_a = bfs_distances(restricted_adj, a)
        if b not in dist_a:
            continue
        hops = dist_a[b]
        if hops < MIN_HOPS or hops > MAX_HOPS:
            continue
        puzzles.append({
            "start": a,
            "dest": b,
            "shortest_hops": hops,
        })
    return puzzles


def main():
    airports = json.loads((DATA / "airports.json").read_text())
    routes = json.loads((DATA / "routes.json").read_text())

    # 1. Sanity-check coverage.
    countries = sorted({a["country"] for a in airports.values()})
    missing = [c for c in countries if c not in CONTINENT_OF]
    if missing:
        print(f"WARNING: {len(missing)} countries unmapped: {missing}")

    # 2. Annotate airports with continent.
    for code, a in airports.items():
        a["continent"] = CONTINENT_OF.get(a["country"])

    # 3. Bucket airport codes by continent.
    codes_by_continent = defaultdict(set)
    for code, a in airports.items():
        cont = a["continent"]
        if cont:
            codes_by_continent[cont].add(code)

    # 4. Build per-continent restricted adjacency + puzzle pools.
    cont_routes = {}
    cont_puzzles = {}
    for cont in CONTINENTS:
        codes = codes_by_continent[cont]
        adj = restrict_routes(routes, codes)
        cont_routes[cont] = adj

        edges = sum(len(v) for v in adj.values()) // 2
        print(f"\n=== {cont} ===")
        print(f"  airports with intra-continent routes: {len(adj)}")
        print(f"  unique flight pairs: {edges}")

        # Smaller continents get smaller pools.
        target = TARGET_PER_CONTINENT if len(adj) >= 60 else max(20, len(adj) // 2)
        pool = build_pool(codes, adj, target)
        print(f"  puzzles generated: {len(pool)}")

        # Score difficulty within this continent.
        feats = [difficulty_features(p["start"], p["dest"],
                                     p["shortest_hops"], adj)
                 for p in pool]
        raws = [f["raw"] for f in feats]
        star_fn, thr = quintile_bucket(raws)
        print(f"  thresholds: p20={thr[0]:.2f} p40={thr[1]:.2f} "
              f"p60={thr[2]:.2f} p80={thr[3]:.2f}")
        dist = defaultdict(int)
        for p, f in zip(pool, feats):
            s = star_fn(f["raw"])
            p["difficulty"] = round(f["raw"], 3)
            p["stars"] = s
            p["alt_count"] = f["count"]
            dist[s] += 1
        for s in sorted(dist):
            print(f"    {'★'*s + '☆'*(5-s)}  {dist[s]} puzzles")
        cont_puzzles[cont] = pool

    # 5. Persist outputs.
    (DATA / "airports.json").write_text(json.dumps(airports))
    (DATA / "airports.js").write_text(
        "window.AIRPORTS = " + json.dumps(airports) + ";\n"
    )
    (DATA / "continent_routes.json").write_text(json.dumps(cont_routes))
    (DATA / "continent_routes.js").write_text(
        "window.CONTINENT_ROUTES = " + json.dumps(cont_routes) + ";\n"
    )
    (DATA / "continent_puzzles.json").write_text(json.dumps(cont_puzzles))
    (DATA / "continent_puzzles.js").write_text(
        "window.CONTINENT_PUZZLES = " + json.dumps(cont_puzzles) + ";\n"
    )

    print("\nWrote:")
    for f in ["airports.json", "airports.js",
              "continent_routes.json", "continent_routes.js",
              "continent_puzzles.json", "continent_puzzles.js"]:
        size = (DATA / f).stat().st_size // 1024
        print(f"  data/{f}  {size} KB")


if __name__ == "__main__":
    main()
