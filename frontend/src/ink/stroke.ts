/**
 * Ink geometry.
 *
 * The old renderer stroked a poly-quad path at a constant width, and for the
 * fountain pen emitted one `<Path>` per segment. That produced three visible
 * artefacts: uniform "marker" strokes, stepped width with overlapping round
 * caps at every joint, and a kink at the tail where the smoothed curve became
 * a straight `lineTo`.
 *
 * This module builds a single *filled outline* per stroke instead. Width varies
 * continuously along the spine, both ends taper, and the whole stroke is one
 * draw call regardless of how many samples it holds.
 */

import { Skia, SkPath } from '@shopify/react-native-skia';

export interface InkPoint {
  x: number;
  y: number;
  /** Monotonic milliseconds. Sub-millisecond resolution where available. */
  t: number;
  /** Normalised stylus pressure 0..1. Undefined for finger/mouse input. */
  p?: number;
}

export type InkTool = 'pen' | 'fountain' | 'marker' | 'highlighter' | 'pencil';

interface ToolProfile {
  /** Width multiplier at minimum pressure/maximum speed. */
  minScale: number;
  /** Width multiplier at maximum pressure/minimum speed. */
  maxScale: number;
  /** 0 = ignore pressure, 1 = pressure fully drives width. */
  pressureWeight: number;
  /** 0 = ignore speed, 1 = speed fully drives width. */
  speedWeight: number;
  /** Fraction of the stroke length used to taper each end. */
  taper: number;
  /** How much of the previous width carries into the next sample (0..1). */
  smoothing: number;
}

const PROFILES: Record<InkTool, ToolProfile> = {
  // A ballpoint barely varies. A little pressure response reads as "real"
  // without looking wobbly.
  pen: { minScale: 0.82, maxScale: 1.12, pressureWeight: 0.8, speedWeight: 0.2, taper: 0.06, smoothing: 0.65 },
  // The expressive one: wide dynamic range, long taper.
  fountain: { minScale: 0.35, maxScale: 1.75, pressureWeight: 0.65, speedWeight: 0.35, taper: 0.18, smoothing: 0.55 },
  marker: { minScale: 0.95, maxScale: 1.05, pressureWeight: 0.5, speedWeight: 0.0, taper: 0.02, smoothing: 0.8 },
  // Highlighters are chisel-flat: no taper, no modulation, or the overlap
  // between passes looks blotchy.
  highlighter: { minScale: 1, maxScale: 1, pressureWeight: 0, speedWeight: 0, taper: 0, smoothing: 1 },
  pencil: { minScale: 0.7, maxScale: 1.15, pressureWeight: 0.85, speedWeight: 0.15, taper: 0.1, smoothing: 0.6 },
};

/** Speed, in world px/ms, treated as "fast" for width purposes. */
const FAST_SPEED = 2.2;
/** Angle (radians) above which a vertex is treated as a corner and not smoothed. */
const CORNER_THRESHOLD = Math.PI / 2.2;

/**
 * Monotonic, sub-millisecond clock.
 *
 * `Date.now()` has 1 ms resolution, so at a 120 Hz sampling rate consecutive
 * points frequently share a timestamp. The old velocity model clamped that to
 * `dt = 1` and produced noise rather than speed.
 */
export const inkNow: () => number =
  typeof globalThis.performance?.now === 'function'
    ? () => globalThis.performance.now()
    : () => Date.now();

function dist(a: InkPoint, b: InkPoint): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Per-sample half-widths along the stroke.
 *
 * Pressure leads when the digitiser reports it; speed fills in for finger input
 * and for devices that don't. The result is low-pass filtered so a single noisy
 * sample can't put a bulge in the line.
 */
function halfWidths(points: InkPoint[], baseWidth: number, profile: ToolProfile): number[] {
  const n = points.length;
  const out = new Array<number>(n);
  const base = baseWidth / 2;
  const range = profile.maxScale - profile.minScale;

  let carried = -1;
  for (let i = 0; i < n; i++) {
    const prev = points[i - 1] ?? points[i];
    const cur = points[i];

    const dt = Math.max(0.5, cur.t - prev.t);
    const speed = dist(prev, cur) / dt;
    // Fast strokes thin out.
    const speedTerm = 1 - clamp01(speed / FAST_SPEED);

    // No reported pressure means finger or mouse: sit at a neutral mid weight
    // rather than pinning to one end of the range.
    const pressureTerm = cur.p === undefined ? 0.55 : clamp01(cur.p);

    const totalWeight = profile.pressureWeight + profile.speedWeight || 1;
    const mix =
      (pressureTerm * profile.pressureWeight + speedTerm * profile.speedWeight) / totalWeight;

    const target = base * (profile.minScale + range * mix);
    carried = carried < 0 ? target : carried + (target - carried) * (1 - profile.smoothing);
    out[i] = carried;
  }

  // Taper both ends toward a point so strokes start and finish like ink rather
  // than like a rubber stamp.
  if (profile.taper > 0 && n > 2) {
    const span = Math.max(1, Math.floor(n * profile.taper));
    for (let i = 0; i < span; i++) {
      const k = 0.25 + 0.75 * (i / span);
      out[i] *= k;
      out[n - 1 - i] *= k;
    }
  }
  return out;
}

/** Unit normals at each sample, averaged across adjacent segments. */
function normals(points: InkPoint[]): { nx: number; ny: number }[] {
  const n = points.length;
  const segs: { nx: number; ny: number }[] = [];
  for (let i = 1; i < n; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    const len = Math.hypot(dx, dy) || 1;
    segs.push({ nx: -dy / len, ny: dx / len });
  }
  const out: { nx: number; ny: number }[] = [];
  for (let i = 0; i < n; i++) {
    const a = segs[i - 1] ?? segs[0] ?? { nx: 0, ny: 1 };
    const b = segs[i] ?? segs[segs.length - 1] ?? { nx: 0, ny: 1 };
    const nx = a.nx + b.nx;
    const ny = a.ny + b.ny;
    const len = Math.hypot(nx, ny) || 1;
    out.push({ nx: nx / len, ny: ny / len });
  }
  return out;
}

/** True when the vertex at `i` turns sharply enough to be a deliberate corner. */
function isCorner(points: InkPoint[], i: number): boolean {
  const a = points[i - 1];
  const b = points[i];
  const c = points[i + 1];
  if (!a || !c) return false;
  const a1 = Math.atan2(b.y - a.y, b.x - a.x);
  const a2 = Math.atan2(c.y - b.y, c.x - b.x);
  let d = Math.abs(a2 - a1);
  if (d > Math.PI) d = 2 * Math.PI - d;
  return d > CORNER_THRESHOLD;
}

/**
 * Append a corner-preserving smooth curve through `pts` onto `path`.
 *
 * Centripetal Catmull-Rom, converted to cubic Béziers. Unlike the previous
 * midpoint-quadratic approach this interpolates the sample points themselves,
 * so the tip of a `v` and the junction of a `t` survive. Detected corners break
 * the spline so they stay sharp instead of being rounded off.
 */
function appendSmoothSpine(path: SkPath, pts: { x: number; y: number }[], corners: boolean[]) {
  const n = pts.length;
  if (n === 0) return;
  path.moveTo(pts[0].x, pts[0].y);
  if (n === 1) return;
  if (n === 2) {
    path.lineTo(pts[1].x, pts[1].y);
    return;
  }

  for (let i = 0; i < n - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? pts[i + 1];

    if (corners[i] || corners[i + 1]) {
      path.lineTo(p2.x, p2.y);
      continue;
    }

    // 1/6 is the standard uniform Catmull-Rom to Bézier tangent scale.
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    path.cubicTo(c1x, c1y, c2x, c2y, p2.x, p2.y);
  }
}

/**
 * Drop samples that carry no shape information.
 *
 * The old code gated on a fixed `1.2 / scale` world distance, which threw away
 * detail on small handwriting and kept different amounts of detail depending on
 * the zoom level the user happened to be at. This keeps anything that deviates
 * from the straight line between its neighbours, so corners survive and only
 * genuinely redundant points are removed.
 *
 * Deviation is measured in *both* position and pressure. A long straight
 * downstroke that swells from light to heavy is geometrically collinear, so a
 * purely positional pass would collapse it to two points and flatten the width
 * modulation with it.
 */
export function simplify(
  points: InkPoint[],
  tolerance = 0.35,
  pressureTolerance = 0.06
): InkPoint[] {
  const n = points.length;
  if (n <= 2) return points.slice();
  const keep = new Array<boolean>(n).fill(false);
  keep[0] = true;
  keep[n - 1] = true;

  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop()!;
    if (hi - lo < 2) continue;
    const a = points[lo];
    const b = points[hi];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy || 1;
    const pa = a.p;
    const pb = b.p;
    const havePressure = pa !== undefined && pb !== undefined;

    let worst = -1;
    let worstIdx = -1;
    for (let i = lo + 1; i < hi; i++) {
      const p = points[i];
      let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
      t = t < 0 ? 0 : t > 1 ? 1 : t;

      // Positional error, normalised against the tolerance.
      let err = Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)) / tolerance;

      // Pressure error, normalised the same way, so whichever signal deviates
      // more decides whether this sample carries information.
      if (havePressure && p.p !== undefined) {
        const interpolated = pa! + (pb! - pa!) * t;
        err = Math.max(err, Math.abs(p.p - interpolated) / pressureTolerance);
      }

      if (err > worst) {
        worst = err;
        worstIdx = i;
      }
    }
    if (worst > 1 && worstIdx > 0) {
      keep[worstIdx] = true;
      stack.push([lo, worstIdx], [worstIdx, hi]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/**
 * Build the filled outline of a stroke.
 *
 * Walks the right-hand side of the spine out to the end, rounds the cap, and
 * walks the left-hand side back. One closed path, one draw call, continuously
 * variable width.
 */
export function buildStrokeOutline(
  rawPoints: InkPoint[],
  baseWidth: number,
  tool: InkTool,
  /**
   * Skip the simplification pass. The live preview rebuilds on every sample, so
   * it must stay O(n): RDP is worth its cost once, when the stroke is committed.
   */
  skipSimplify = false
): SkPath {
  const path = Skia.Path.Make();
  const points = !skipSimplify && rawPoints.length > 2 ? simplify(rawPoints) : rawPoints;
  const n = points.length;

  if (n === 0) return path;
  if (n === 1) {
    path.addCircle(points[0].x, points[0].y, Math.max(0.4, baseWidth / 2));
    return path;
  }

  const profile = PROFILES[tool] ?? PROFILES.pen;

  // Highlighters want a flat, constant-width band, which a plain stroked path
  // renders more cleanly (and more cheaply) than an outline.
  if (profile.minScale === 1 && profile.maxScale === 1 && profile.taper === 0) {
    const corners = points.map((_, i) => isCorner(points, i));
    appendSmoothSpine(
      path,
      points.map((p) => ({ x: p.x, y: p.y })),
      corners
    );
    return path;
  }

  const hw = halfWidths(points, baseWidth, profile);
  const nrm = normals(points);
  const corners = points.map((_, i) => isCorner(points, i));

  const right: { x: number; y: number }[] = [];
  const left: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) {
    const { nx, ny } = nrm[i];
    const w = Math.max(0.2, hw[i]);
    right.push({ x: points[i].x + nx * w, y: points[i].y + ny * w });
    left.push({ x: points[i].x - nx * w, y: points[i].y - ny * w });
  }

  appendSmoothSpine(path, right, corners);

  // Round the far end across to the other side.
  const endW = Math.max(0.2, hw[n - 1]);
  path.arcToTangent(
    points[n - 1].x + nrm[n - 1].nx * endW,
    points[n - 1].y + nrm[n - 1].ny * endW,
    left[n - 1].x,
    left[n - 1].y,
    endW
  );
  path.lineTo(left[n - 1].x, left[n - 1].y);

  const back = left.slice().reverse();
  const backCorners = corners.slice().reverse();
  for (let i = 0; i < back.length - 1; i++) {
    const p0 = back[i - 1] ?? back[i];
    const p1 = back[i];
    const p2 = back[i + 1];
    const p3 = back[i + 2] ?? back[i + 1];
    if (backCorners[i] || backCorners[i + 1]) {
      path.lineTo(p2.x, p2.y);
      continue;
    }
    path.cubicTo(
      p1.x + (p2.x - p0.x) / 6,
      p1.y + (p2.y - p0.y) / 6,
      p2.x - (p3.x - p1.x) / 6,
      p2.y - (p3.y - p1.y) / 6,
      p2.x,
      p2.y
    );
  }

  path.close();
  return path;
}

/**
 * Identity-keyed cache for committed strokes.
 *
 * Stroke objects are immutable once finalised, so the object reference is a
 * sound cache key and a `WeakMap` lets the entries die with the stroke. This is
 * what stops the renderer rebuilding every path on the page on every frame.
 */
const outlineCache = new WeakMap<object, SkPath>();

export function cachedOutline(
  stroke: object,
  points: InkPoint[],
  baseWidth: number,
  tool: InkTool
): SkPath {
  const hit = outlineCache.get(stroke);
  if (hit) return hit;
  const built = buildStrokeOutline(points, baseWidth, tool);
  outlineCache.set(stroke, built);
  return built;
}

export function invalidateOutline(stroke: object): void {
  outlineCache.delete(stroke);
}

/** Opacity each tool draws at. */
export const TOOL_OPACITY: Record<InkTool, number> = {
  pen: 1,
  fountain: 1,
  marker: 0.92,
  highlighter: 0.35,
  pencil: 0.78,
};

/** Highlighters read as noticeably broader than the nominal nib width. */
export function effectiveWidth(tool: InkTool, width: number): number {
  return tool === 'highlighter' ? width * 2.4 : width;
}

/**
 * Live preview path. Never simplifies, so cost stays linear in the number of
 * samples captured so far and the ink keeps up with the pen.
 */
export function buildLiveOutline(points: InkPoint[], baseWidth: number, tool: InkTool): SkPath {
  return buildStrokeOutline(points, baseWidth, tool, true);
}
