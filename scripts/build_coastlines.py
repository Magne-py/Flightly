"""
Generate data/coastlines.js from Natural Earth 1:50m land polygons.

Natural Earth is the public-domain cartographic dataset used by most web
mapping projects. The 1:50m scale is the sweet spot for an SVG globe —
detailed enough that Norway's fjords, Greek islands, and the Indonesian
archipelago all show up, but small enough to stay under ~150 KB after
simplification.

Pipeline:
  1. Fetch ne_50m_land.geojson over HTTPS (cached locally on first run).
  2. Walk every Polygon / MultiPolygon feature and pull out each exterior
     ring as a sequence of [lat, lon] pairs (GeoJSON's lon/lat is swapped).
  3. Split any ring that crosses the antimeridian into two halves so no
     straight-line segment wraps the globe the wrong way.
  4. Simplify each ring with Douglas-Peucker, using a small epsilon. This
     drops ~85% of points while preserving the visual silhouette.
  5. Sort rings into "continents" (large landmasses) vs "islands" (small)
     by spherical-cap area — the renderer styles them differently.
  6. Emit window.COASTLINES = {continents: [...], islands: [...]} into
     data/coastlines.js with the same shape the existing renderer expects.

Run once after pulling a fresh Natural Earth release:

    python3 scripts/build_coastlines.py

Inputs:
  data/natural_earth/ne_50m_land.geojson   (auto-downloaded if missing)

Outputs:
  data/coastlines.js
  data/coastlines.json
"""
import json
import math
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
CACHE_DIR = DATA / "natural_earth"
CACHE_FILE = CACHE_DIR / "ne_50m_land.geojson"
OUT_JS = DATA / "coastlines.js"
OUT_JSON = DATA / "coastlines.json"

NE_URL = (
    "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/"
    "master/geojson/ne_50m_land.geojson"
)

# Tuning knobs --------------------------------------------------------------
# Douglas-Peucker epsilon in degrees. Lower → more points, more fidelity.
# 0.25° (~25 km at the equator) keeps the silhouette honest without
# carrying every cove and bay. Increase to shrink the file further.
DP_EPSILON_DEG = 0.25

# Spherical-cap area threshold for "continent" vs "island", in km^2.
# Mainland Australia (~7.7M km^2) is a continent; Madagascar (~590K) is
# an island. We split at 1.2M km^2 so Greenland counts as a continent.
CONTINENT_AREA_KM2 = 1_200_000

# Drop tiny polygons whose area is below this threshold (clears up the
# noise from islets that would render as 1-pixel dots).
MIN_AREA_KM2 = 50

EARTH_KM = 6371.0


# --------------------------------------------------------------------------
# Fetch / cache
# --------------------------------------------------------------------------
def load_geojson() -> dict:
    if CACHE_FILE.exists():
        print(f"Using cached {CACHE_FILE.relative_to(ROOT)}")
        return json.loads(CACHE_FILE.read_text())
    print(f"Downloading Natural Earth 1:50m land polygons…")
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(NE_URL, timeout=60) as resp:
        data = resp.read()
    CACHE_FILE.write_bytes(data)
    print(f"  wrote {CACHE_FILE.relative_to(ROOT)}  ({len(data)//1024} KB)")
    return json.loads(data)


# --------------------------------------------------------------------------
# Antimeridian handling
# --------------------------------------------------------------------------
def split_antimeridian(ring):
    """
    Split a ring at any segment that crosses ±180°. Returns a list of
    sub-rings, each strictly in (-180, 180] longitude with no segment
    spanning >180° in longitude. Each returned ring is NOT explicitly
    closed (the renderer densifies + closes paths itself).
    """
    if len(ring) < 2:
        return [ring]
    pieces = []
    current = [ring[0]]
    for i in range(1, len(ring)):
        prev_lat, prev_lon = ring[i - 1]
        lat, lon = ring[i]
        if abs(lon - prev_lon) > 180:
            # Crosses antimeridian — start a new piece. We don't try to
            # interpolate exactly to ±180 because the renderer's densify
            # step + projection horizon-cull will paper over the seam.
            if len(current) > 1:
                pieces.append(current)
            current = [[lat, lon]]
        else:
            current.append([lat, lon])
    if len(current) > 1:
        pieces.append(current)
    return pieces


# --------------------------------------------------------------------------
# Spherical-cap area (km^2) of a polygon ring on a unit sphere.
# Uses the L'Huilier shoelace formula in spherical coordinates.
# Sign indicates orientation; we use absolute value.
# --------------------------------------------------------------------------
def ring_area_km2(ring):
    if len(ring) < 3:
        return 0.0
    total = 0.0
    n = len(ring)
    for i in range(n):
        lat1, lon1 = ring[i]
        lat2, lon2 = ring[(i + 1) % n]
        total += math.radians(lon2 - lon1) * (
            2 + math.sin(math.radians(lat1)) + math.sin(math.radians(lat2))
        )
    return abs(total * EARTH_KM * EARTH_KM / 2.0)


# --------------------------------------------------------------------------
# Douglas-Peucker over geographic coords. Uses planar distance in degrees
# as the error metric — fine at 1:50m scale where most polygons span only
# a few tens of degrees.
# --------------------------------------------------------------------------
def perp_distance(p, a, b):
    # Distance from p to line a-b, in degree units (planar approx).
    ax, ay = a[1], a[0]      # [lat, lon] -> (lon, lat)
    bx, by = b[1], b[0]
    px, py = p[1], p[0]
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return math.hypot(px - ax, py - ay)
    # Project p onto line a-b, clamp to segment.
    t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)
    t = max(0.0, min(1.0, t))
    fx, fy = ax + t * dx, ay + t * dy
    return math.hypot(px - fx, py - fy)


def douglas_peucker(points, epsilon):
    if len(points) < 3:
        return list(points)
    # Iterative DP — recursion blows the stack on the largest rings
    # (Eurasia at 1:50m has tens of thousands of vertices).
    keep = [False] * len(points)
    keep[0] = True
    keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        lo, hi = stack.pop()
        if hi <= lo + 1:
            continue
        a, b = points[lo], points[hi]
        idx, max_d = -1, 0.0
        for i in range(lo + 1, hi):
            d = perp_distance(points[i], a, b)
            if d > max_d:
                idx, max_d = i, d
        if max_d > epsilon:
            keep[idx] = True
            stack.append((lo, idx))
            stack.append((idx, hi))
    return [p for p, k in zip(points, keep) if k]


# --------------------------------------------------------------------------
# Extract rings from a GeoJSON geometry. Returns a list of [[lat, lon], …]
# rings, with antimeridian splits applied.
# --------------------------------------------------------------------------
def geometry_rings(geom):
    out = []
    if geom is None:
        return out
    gtype = geom.get("type")
    coords = geom.get("coordinates", [])
    if gtype == "Polygon":
        polygons = [coords]
    elif gtype == "MultiPolygon":
        polygons = coords
    else:
        return out
    for poly in polygons:
        # poly = [exterior, hole1, hole2, ...]. We only need the exterior;
        # holes are lakes/inland seas and the SVG fill rule would punch
        # them out anyway — but they'd add visual noise on the globe.
        if not poly:
            continue
        exterior = poly[0]
        ring = [[lat, lon] for lon, lat in exterior]
        out.extend(split_antimeridian(ring))
    return out


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------
def main():
    geo = load_geojson()
    features = geo.get("features", [])
    print(f"Features: {len(features)}")

    raw_rings = []
    for feat in features:
        for ring in geometry_rings(feat.get("geometry")):
            raw_rings.append(ring)

    total_in = sum(len(r) for r in raw_rings)
    print(f"Rings after antimeridian split: {len(raw_rings)}  "
          f"({total_in:,} vertices)")

    # Drop tiny polygons before simplification — cheap.
    sized = []
    for ring in raw_rings:
        area = ring_area_km2(ring)
        if area >= MIN_AREA_KM2:
            sized.append((area, ring))
    sized.sort(key=lambda t: -t[0])
    print(f"Rings ≥ {MIN_AREA_KM2:,} km²: {len(sized)}")

    # Simplify each ring with Douglas-Peucker.
    continents = []
    islands = []
    total_out = 0
    for area, ring in sized:
        simp = douglas_peucker(ring, DP_EPSILON_DEG)
        if len(simp) < 3:
            continue
        total_out += len(simp)
        bucket = continents if area >= CONTINENT_AREA_KM2 else islands
        bucket.append(simp)

    print(f"After Douglas-Peucker (ε={DP_EPSILON_DEG}°): "
          f"{total_out:,} vertices "
          f"({100*total_out/total_in:.1f}% of original)")
    print(f"  continents: {len(continents)} rings, "
          f"{sum(len(r) for r in continents):,} vertices")
    print(f"  islands:    {len(islands)} rings, "
          f"{sum(len(r) for r in islands):,} vertices")

    payload = {"continents": continents, "islands": islands}
    js_blob = json.dumps(payload, separators=(",", ":"))
    OUT_JS.write_text("window.COASTLINES = " + js_blob + ";\n")
    OUT_JSON.write_text(js_blob)
    print(f"\nWrote {OUT_JS.relative_to(ROOT)}  "
          f"{OUT_JS.stat().st_size // 1024} KB")
    print(f"Wrote {OUT_JSON.relative_to(ROOT)}  "
          f"{OUT_JSON.stat().st_size // 1024} KB")


if __name__ == "__main__":
    try:
        main()
    except urllib.error.URLError as e:
        print(f"\nERROR: couldn't download Natural Earth data: {e}",
              file=sys.stderr)
        print(f"If you've already downloaded it, drop the file at:",
              file=sys.stderr)
        print(f"  {CACHE_FILE}", file=sys.stderr)
        sys.exit(1)
