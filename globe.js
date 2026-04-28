/* JetSets — orthographic SVG globe.
 * Exposes window.JetSetsGlobe with:
 *   init(svgEl, airportsMap)
 *   setPuzzle(startIata, destIata)     — recenters globe on midpoint
 *   setDraft(codes)                    — dashed current-row waypoints
 *   setHistory(attempts)               — graded color arcs for past attempts
 *   reset()
 *
 * Projection: orthographic. We hide primitives on the back hemisphere.
 * Flight paths are drawn as great-circle arcs (slerp on the unit sphere).
 */
(function () {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";
  const WIDTH = 400, HEIGHT = 400;
  const CX = WIDTH / 2, CY = HEIGHT / 2;
  const BASE_RADIUS = 185;
  const MIN_ZOOM = 0.6;
  const MAX_ZOOM = 4.0;
  let RADIUS = BASE_RADIUS;
  let zoom = 1.0;

  let svg = null;
  let airportsRef = null;
  let coastRef = null;  // { continents: [[[lat,lon],...]], islands: [...] }
  let rotateLon = 0;   // degrees — west-positive axis rotation
  let rotateLat = 20;  // degrees — north-tilt
  let dragging = false;
  let dragStart = null;

  // Retained state so we can re-render on rotation
  let state = {
    start: null,
    dest: null,
    draft: [],      // [iata, ...]
    history: [],    // [{row: [{code, color}, ...]}]
    solution: [],   // [iata, ...] — full shortest route to highlight after round ends
    hub: null,      // { center: iata, neighbors: [iata, ...] } — Learn-page mode
  };

  function clampZoom(z) { return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z)); }
  function applyZoom(z) {
    zoom = clampZoom(z);
    RADIUS = BASE_RADIUS * zoom;
  }

  // ---------- Projection ----------
  function toRad(d) { return d * Math.PI / 180; }

  // Orthographic projection. Returns {x, y, visible}.
  function project(lat, lon) {
    const λ = toRad(lon - rotateLon);
    const φ = toRad(lat);
    const φ0 = toRad(rotateLat);
    const cosc = Math.sin(φ0) * Math.sin(φ) + Math.cos(φ0) * Math.cos(φ) * Math.cos(λ);
    const visible = cosc >= 0;
    const x = Math.cos(φ) * Math.sin(λ);
    const y = Math.cos(φ0) * Math.sin(φ) - Math.sin(φ0) * Math.cos(φ) * Math.cos(λ);
    return { x: CX + RADIUS * x, y: CY - RADIUS * y, visible };
  }

  // Great-circle interpolation between two lat/lon points.
  // Returns an array of [lat, lon] samples along the arc.
  function greatCircleSamples(lat1, lon1, lat2, lon2, steps = 64) {
    const φ1 = toRad(lat1), λ1 = toRad(lon1);
    const φ2 = toRad(lat2), λ2 = toRad(lon2);
    const cosΔ = Math.sin(φ1) * Math.sin(φ2) +
                 Math.cos(φ1) * Math.cos(φ2) * Math.cos(λ2 - λ1);
    const Δ = Math.acos(Math.max(-1, Math.min(1, cosΔ)));
    if (Δ < 1e-6) return [[lat1, lon1], [lat2, lon2]];
    const pts = [];
    for (let i = 0; i <= steps; i++) {
      const f = i / steps;
      const A = Math.sin((1 - f) * Δ) / Math.sin(Δ);
      const B = Math.sin(f * Δ) / Math.sin(Δ);
      const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
      const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
      const z = A * Math.sin(φ1) + B * Math.sin(φ2);
      const lat = Math.atan2(z, Math.sqrt(x * x + y * y)) * 180 / Math.PI;
      const lon = Math.atan2(y, x) * 180 / Math.PI;
      pts.push([lat, lon]);
    }
    return pts;
  }

  // Turn sampled great-circle points into one or more SVG polyline `points` strings,
  // splitting where the arc dips behind the globe.
  function pathSegments(samples) {
    const segs = [];
    let cur = [];
    for (const [lat, lon] of samples) {
      const p = project(lat, lon);
      if (p.visible) {
        cur.push(p.x.toFixed(2) + "," + p.y.toFixed(2));
      } else {
        if (cur.length > 1) segs.push(cur);
        cur = [];
      }
    }
    if (cur.length > 1) segs.push(cur);
    return segs;
  }

  // ---------- SVG helpers ----------
  function el(tag, attrs) {
    const e = document.createElementNS(SVG_NS, tag);
    if (attrs) {
      for (const k in attrs) e.setAttribute(k, attrs[k]);
    }
    return e;
  }

  // ---------- Rendering ----------
  function render() {
    if (!svg) return;
    // Clear
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    // Outer sphere
    svg.appendChild(el("circle", {
      class: "globe-sphere", cx: CX, cy: CY, r: RADIUS,
    }));

    // Land masses (drawn before graticule so grid lines sit on top)
    drawCoastlines();

    // Graticule — meridians every 30°, parallels every 30°
    for (let lon = -180; lon < 180; lon += 30) {
      drawGraticuleLine(meridianSamples(lon), "globe-graticule");
    }
    for (let lat = -60; lat <= 60; lat += 30) {
      drawGraticuleLine(parallelSamples(lat), lat === 0 ? "globe-equator" : "globe-graticule");
    }

    // History arcs (older attempts behind, newer in front)
    for (let h = 0; h < state.history.length; h++) {
      const attempt = state.history[h];
      const isLatest = h === state.history.length - 1;
      drawAttemptArcs(attempt.row, isLatest);
    }

    // Solution overlay arcs (only after round ends — accent-colored)
    drawSolutionArcs();

    // Hub arcs (Learn page — every neighbor of the selected airport)
    drawHubArcs();

    // Draft arcs (dashed blue)
    drawDraftArcs();

    // Markers — drawn last so they sit on top of arcs
    if (state.start && airportsRef[state.start]) {
      drawMarker(state.start, "start");
    }
    if (state.dest && airportsRef[state.dest]) {
      drawMarker(state.dest, "dest");
    }
    // Solution intermediate markers (after round ends)
    if (state.solution && state.solution.length > 2) {
      for (let i = 1; i < state.solution.length - 1; i++) {
        const code = state.solution[i];
        if (airportsRef[code]) drawMarker(code, "solution");
      }
    }
    // Hub markers — center is the green "start" marker, neighbors are
    // unlabelled accent dots (labelling every neighbor swamps the globe;
    // hover highlight from the table handles individual call-outs).
    if (state.hub && state.hub.center && airportsRef[state.hub.center]) {
      drawMarker(state.hub.center, "start");
      for (const nb of state.hub.neighbors) {
        if (!airportsRef[nb]) continue;
        drawHubNeighborDot(nb);
      }
    }
    // Draft waypoints
    for (let i = 0; i < state.draft.length; i++) {
      const code = state.draft[i];
      if (airportsRef[code]) drawMarker(code, "draft", i + 1);
    }
  }

  function drawHubArcs() {
    if (!state.hub || !state.hub.center) return;
    const center = state.hub.center;
    const C = airportsRef[center];
    if (!C) return;
    for (const nb of state.hub.neighbors) {
      const N = airportsRef[nb];
      if (!N) continue;
      const samples = greatCircleSamples(C.lat, C.lon, N.lat, N.lon);
      const segs = pathSegments(samples);
      for (const seg of segs) {
        svg.appendChild(el("polyline", {
          class: "leg-line hub", points: seg.join(" "),
        }));
      }
    }
  }

  function drawHubNeighborDot(code) {
    const a = airportsRef[code];
    if (!a) return;
    const p = project(a.lat, a.lon);
    if (!p.visible) return;
    svg.appendChild(el("circle", {
      class: "marker-hub", cx: p.x, cy: p.y, r: 3.2,
    }));
  }

  function drawSolutionArcs() {
    if (!state.solution || state.solution.length < 2) return;
    for (let i = 0; i < state.solution.length - 1; i++) {
      const a = state.solution[i], b = state.solution[i + 1];
      if (!airportsRef[a] || !airportsRef[b]) continue;
      const A = airportsRef[a], B = airportsRef[b];
      const samples = greatCircleSamples(A.lat, A.lon, B.lat, B.lon);
      const segs = pathSegments(samples);
      for (const seg of segs) {
        svg.appendChild(el("polyline", {
          class: "leg-line solution", points: seg.join(" "),
        }));
      }
    }
  }

  // ---------- Coastlines ----------
  // Densify a polygon ring so that straight-line chord segments are short
  // enough that linear interpolation is visually indistinguishable from a
  // great-circle arc. We then project each sample and split the projected
  // path at the hemisphere horizon, rejoining each visible span via an arc
  // along the globe limb so filled regions look solid.
  function densifyRing(ring, stepDeg) {
    const out = [];
    for (let i = 0; i < ring.length - 1; i++) {
      const [lat1, lon1] = ring[i], [lat2, lon2] = ring[i + 1];
      // Use planar lat/lon distance as a proxy — fine for short edges.
      const dLat = lat2 - lat1, dLon = lon2 - lon1;
      const dist = Math.sqrt(dLat * dLat + dLon * dLon);
      const steps = Math.max(1, Math.ceil(dist / stepDeg));
      for (let s = 0; s < steps; s++) {
        const f = s / steps;
        out.push([lat1 + dLat * f, lon1 + dLon * f]);
      }
    }
    out.push(ring[ring.length - 1]);
    return out;
  }

  // Project a lat/lon sample to the sphere-tangent plane. Same math as
  // `project`, but also returns the underlying unit-vector angle (atan2 of
  // the planar x/y) so we can close off-screen hops along the globe limb.
  function projectEx(lat, lon) {
    const p = project(lat, lon);
    // Angle from globe center to the projected point (works for any point
    // on the canvas; we only use it when visible is borderline / false).
    const dx = p.x - CX, dy = p.y - CY;
    p.theta = Math.atan2(dy, dx);
    return p;
  }

  // Given a densified projected ring, emit an SVG path "d" string that
  // covers all visible arcs, with each hidden gap sutured along the globe
  // limb so fills don't leak off-sphere.
  function ringPath(projected) {
    let d = "";
    let started = false;      // have we begun a visible subpath yet?
    let lastHiddenTheta = 0;  // angle where we last went off-screen
    let firstVisibleTheta = null;
    for (let i = 0; i < projected.length; i++) {
      const p = projected[i];
      if (p.visible) {
        if (!started) {
          d += `M ${p.x.toFixed(2)} ${p.y.toFixed(2)}`;
          firstVisibleTheta = p.theta;
          started = true;
        } else {
          d += ` L ${p.x.toFixed(2)} ${p.y.toFixed(2)}`;
        }
      } else {
        if (started) {
          // We were visible; now we're hidden. Trace along the limb from
          // the last visible exit to where the next visible point re-enters.
          // We do this lazily — record the hidden-entry angle and resume
          // when the polygon becomes visible again.
          lastHiddenTheta = p.theta;
          // Swap to "awaiting re-entry" mode by toggling started off and
          // remembering that we need to stitch along the limb.
          const reentry = findNextVisible(projected, i);
          if (reentry === -1) {
            // Ring goes fully out-of-sight for the rest of the sequence.
            break;
          }
          // Emit a limb-arc from current exit limb-angle to the re-entry
          // limb-angle, picking the shorter arc so we don't wrap around.
          const exit = limbAngleFor(projected[i - 1]);
          const enter = limbAngleFor(projected[reentry]);
          d += limbArc(exit, enter);
          // Restart the subpath at the re-entry point.
          d += ` L ${projected[reentry].x.toFixed(2)} ${projected[reentry].y.toFixed(2)}`;
          i = reentry; // continue from the re-entry sample
        }
      }
    }
    if (started) {
      d += " Z";
    }
    return d;
  }

  function findNextVisible(projected, from) {
    for (let j = from; j < projected.length; j++) {
      if (projected[j].visible) return j;
    }
    return -1;
  }

  // Angle on the globe limb closest to a (potentially off-globe) projected
  // sample. For hidden samples we push them back onto the circle of radius
  // RADIUS around the globe center.
  function limbAngleFor(p) {
    const dx = p.x - CX, dy = p.y - CY;
    return Math.atan2(dy, dx);
  }

  // SVG arc fragment along the globe limb between two angles.
  function limbArc(fromAngle, toAngle) {
    let delta = toAngle - fromAngle;
    // Normalise to (-π, π]
    while (delta > Math.PI) delta -= 2 * Math.PI;
    while (delta < -Math.PI) delta += 2 * Math.PI;
    const sweep = delta > 0 ? 1 : 0;
    const largeArc = Math.abs(delta) > Math.PI ? 1 : 0;
    const ex = CX + RADIUS * Math.cos(toAngle);
    const ey = CY + RADIUS * Math.sin(toAngle);
    return ` A ${RADIUS} ${RADIUS} 0 ${largeArc} ${sweep} ${ex.toFixed(2)} ${ey.toFixed(2)}`;
  }

  function drawCoastlines() {
    if (!coastRef) return;
    const densifyEvery = 2;       // degrees — coarser for islands
    const groups = [
      { rings: coastRef.continents || [], cls: "globe-land", step: 2 },
      { rings: coastRef.islands    || [], cls: "globe-island", step: 1.5 },
    ];
    for (const g of groups) {
      for (const ring of g.rings) {
        const dense = densifyRing(ring, g.step);
        const projected = dense.map(([lat, lon]) => projectEx(lat, lon));
        // Fast-path: entirely hidden (back hemisphere)? skip.
        let anyVisible = false;
        for (const p of projected) { if (p.visible) { anyVisible = true; break; } }
        if (!anyVisible) continue;
        const d = ringPath(projected);
        if (!d) continue;
        svg.appendChild(el("path", { class: g.cls, d }));
      }
    }
  }

  function meridianSamples(lon) {
    const pts = [];
    for (let lat = -85; lat <= 85; lat += 2) pts.push([lat, lon]);
    return pts;
  }
  function parallelSamples(lat) {
    const pts = [];
    for (let lon = -180; lon <= 180; lon += 2) pts.push([lat, lon]);
    return pts;
  }

  function drawGraticuleLine(samples, cls) {
    const segs = pathSegments(samples);
    for (const seg of segs) {
      svg.appendChild(el("polyline", {
        class: cls, points: seg.join(" "),
      }));
    }
  }

  function drawAttemptArcs(row, isLatest) {
    // row is [{code, color}|null, ...] length 5; empty slots mean "skipped"
    const codes = row.filter(c => c && c.code);
    if (!state.start || !state.dest) return;
    const fullPath = [state.start, ...codes.map(c => c.code), state.dest];
    // Colors per leg: use the color of the *destination* airport of each leg.
    // For the final leg into puzzle.dest, use the color of the last filled cell
    // (that's the one whose validity determines the leg into dest).
    // Simpler rule: paint each leg with the color of its arriving waypoint,
    // and the final arc uses the last waypoint's color or neutral if none.
    for (let i = 0; i < fullPath.length - 1; i++) {
      const a = fullPath[i], b = fullPath[i + 1];
      // Skip if either endpoint's data missing
      if (!airportsRef[a] || !airportsRef[b]) continue;
      // Color: pick the color of the "arriving" airport if it's a filled cell;
      // for the final leg (arriving at dest), reuse the last cell's color.
      let color = "";
      if (i < codes.length) color = codes[i].color;     // arriving at codes[i]
      else if (codes.length > 0) color = codes[codes.length - 1].color; // final leg
      else color = ""; // direct flight with no cells — leave neutral
      if (!color) color = "orange";
      const A = airportsRef[a], B = airportsRef[b];
      const samples = greatCircleSamples(A.lat, A.lon, B.lat, B.lon);
      const segs = pathSegments(samples);
      for (const seg of segs) {
        const cls = "leg-line " + color + (isLatest ? " latest" : "");
        svg.appendChild(el("polyline", { class: cls, points: seg.join(" ") }));
      }
    }
  }

  function drawDraftArcs() {
    if (!state.start || !state.dest) return;
    if (state.draft.length === 0) return; // no draft yet
    const path = [state.start, ...state.draft];
    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i], b = path[i + 1];
      if (!airportsRef[a] || !airportsRef[b]) continue;
      const A = airportsRef[a], B = airportsRef[b];
      const samples = greatCircleSamples(A.lat, A.lon, B.lat, B.lon);
      const segs = pathSegments(samples);
      for (const seg of segs) {
        svg.appendChild(el("polyline", {
          class: "leg-line draft", points: seg.join(" "),
        }));
      }
    }
  }

  function drawMarker(code, kind, label) {
    const a = airportsRef[code];
    if (!a) return;
    const p = project(a.lat, a.lon);
    if (!p.visible) return;
    const r = (kind === "draft") ? 6.5 : (kind === "start" || kind === "dest") ? 6 : 5;
    svg.appendChild(el("circle", {
      class: "marker-" + kind, cx: p.x, cy: p.y, r: r,
    }));
    if (kind === "draft" && label != null) {
      svg.appendChild(el("text", {
        class: "waypoint-badge", x: p.x, y: p.y + 0.5,
      })).textContent = String(label);
    }
    // Text label offset. Choose side based on x position so labels stay on the globe.
    const rightSide = p.x < CX;
    const dx = rightSide ? 10 : -10;
    const anchor = rightSide ? "start" : "end";
    const labelText = code;
    const subText = a.city;
    const labelY = p.y - 3;
    const subY = p.y + 10;

    const lEl = el("text", {
      class: "marker-label", x: p.x + dx, y: labelY, "text-anchor": anchor,
    });
    lEl.textContent = labelText;
    svg.appendChild(lEl);

    const sEl = el("text", {
      class: "marker-sublabel", x: p.x + dx, y: subY, "text-anchor": anchor,
    });
    sEl.textContent = subText;
    svg.appendChild(sEl);
  }

  // ---------- Centering / auto-rotation ----------
  function centerOn(lat, lon) {
    rotateLon = lon;
    rotateLat = Math.max(-55, Math.min(55, lat));
  }

  function centerMidpoint(a, b) {
    if (!a || !b) return;
    // Midpoint on the great circle: normalised mean of Cartesian coords
    const φ1 = toRad(a.lat), λ1 = toRad(a.lon);
    const φ2 = toRad(b.lat), λ2 = toRad(b.lon);
    const x = Math.cos(φ1) * Math.cos(λ1) + Math.cos(φ2) * Math.cos(λ2);
    const y = Math.cos(φ1) * Math.sin(λ1) + Math.cos(φ2) * Math.sin(λ2);
    const z = Math.sin(φ1) + Math.sin(φ2);
    const lat = Math.atan2(z, Math.sqrt(x * x + y * y)) * 180 / Math.PI;
    const lon = Math.atan2(y, x) * 180 / Math.PI;
    centerOn(lat, lon);
  }

  // ---------- Drag rotation ----------
  function attachDrag() {
    if (!svg) return;
    const onDown = (e) => {
      dragging = true;
      const p = pointerXY(e);
      dragStart = { x: p.x, y: p.y, lon: rotateLon, lat: rotateLat };
      e.preventDefault();
    };
    const onMove = (e) => {
      if (!dragging) return;
      const p = pointerXY(e);
      const dx = p.x - dragStart.x;
      const dy = p.y - dragStart.y;
      // Sensitivity: full width of the SVG covers ~180° longitude (at zoom 1).
      // Divide by zoom so when zoomed in, the same pixel drag rotates less.
      const scale = 180 / WIDTH / zoom;
      rotateLon = dragStart.lon + dx * scale;
      rotateLat = Math.max(-80, Math.min(80, dragStart.lat - dy * scale));
      render();
    };
    const onUp = () => { dragging = false; };
    const onWheel = (e) => {
      e.preventDefault();
      // Trackpad / wheel: smoothly scale zoom with deltaY
      const factor = Math.exp(-e.deltaY * 0.0015);
      applyZoom(zoom * factor);
      render();
    };

    svg.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    svg.addEventListener("touchstart", onDown, { passive: false });
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend", onUp);
    svg.addEventListener("wheel", onWheel, { passive: false });
  }
  function pointerXY(e) {
    const rect = svg.getBoundingClientRect();
    const c = e.touches ? e.touches[0] : e;
    // Convert to SVG coordinate system (0..WIDTH)
    const x = (c.clientX - rect.left) * (WIDTH / rect.width);
    const y = (c.clientY - rect.top) * (HEIGHT / rect.height);
    return { x, y };
  }

  // ---------- Public API ----------
  function init(svgEl, airportsMap, coastData) {
    svg = svgEl;
    airportsRef = airportsMap;
    if (coastData) coastRef = coastData;
    attachDrag();
    render();
  }

  function setCoastlines(data) {
    coastRef = data;
    render();
  }

  function setPuzzle(startIata, destIata) {
    state.start = startIata;
    state.dest = destIata;
    state.draft = [];
    state.history = [];
    state.solution = [];
    state.hub = null;
    // Reset zoom so a new puzzle always starts framed sensibly.
    applyZoom(1.0);
    const A = airportsRef[startIata], B = airportsRef[destIata];
    centerMidpoint(A, B);
    render();
  }

  // Learn-page mode. Clears all puzzle state, recenters on the hub
  // airport, and draws great-circle arcs to every neighbor.
  function setHub(centerIata, neighborIatas) {
    state.start = null;
    state.dest = null;
    state.draft = [];
    state.history = [];
    state.solution = [];
    state.hub = {
      center: centerIata || null,
      neighbors: (neighborIatas || []).slice(),
    };
    if (centerIata && airportsRef[centerIata]) {
      const A = airportsRef[centerIata];
      centerOn(A.lat, A.lon);
    }
    applyZoom(1.0);
    render();
  }

  function clearHub() {
    state.hub = null;
    render();
  }

  function setDraft(codes) {
    state.draft = codes.slice();
    render();
  }

  function setHistory(attempts) {
    // attempts is the live `attempts` array from game.js:
    // an array of rows, each row is an array of {code, color}|null
    state.history = attempts.map(row => ({ row }));
    render();
  }

  function setSolution(codes) {
    // Codes is the FULL shortest route including start and dest, e.g.
    // [start, mid1, mid2, dest]. We highlight every leg.
    state.solution = codes ? codes.slice() : [];
    render();
  }

  function setZoom(z) {
    applyZoom(z);
    render();
  }
  function zoomBy(factor) {
    applyZoom(zoom * factor);
    render();
  }
  function resetView() {
    applyZoom(1.0);
    if (state.start && state.dest) {
      centerMidpoint(airportsRef[state.start], airportsRef[state.dest]);
    } else {
      rotateLon = 0;
      rotateLat = 20;
    }
    render();
  }

  function reset() {
    state = { start: null, dest: null, draft: [], history: [], solution: [], hub: null };
    applyZoom(1.0);
    render();
  }

  window.JetSetsGlobe = {
    init, setPuzzle, setDraft, setHistory, setSolution, setCoastlines,
    setHub, clearHub,
    setZoom, zoomBy, resetView, reset,
  };
})();
