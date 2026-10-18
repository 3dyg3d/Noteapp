/**
 * Ink rendering: turns stroke geometry (see ./geometry.ts) into Skia paths.
 *
 * Each stroke is one filled outline: width varies continuously along the
 * spine, both ends are round, and the whole stroke is one draw call however
 * many samples it holds. The live (wet) stroke and the committed stroke go
 * through the same code with the same per-point widths, so nothing changes
 * shape when the pen lifts except the exit taper being drawn.
 */

import { Skia, SkPath } from '@shopify/react-native-skia';

import {
  InkPoint,
  InkTool,
  XY,
  isConstantWidth,
  outline,
  withWidths,
  corners as cornerFlags,
} from './geometry';

export type { InkPoint, InkTool } from './geometry';
export { simplify, commitPoints, storePoints, annotateWidth, OneEuro2D, isConstantWidth } from './geometry';

/**
 * Monotonic, sub-millisecond clock. `Date.now()` has 1 ms resolution, so at
 * 120 Hz+ sampling consecutive points often share a timestamp.
 */
export const inkNow: () => number =
  typeof globalThis.performance?.now === 'function'
    ? () => globalThis.performance.now()
    : () => Date.now();

/**
 * Append a smooth curve through `pts` (centripetal-ish Catmull-Rom as cubic
 * Béziers). Interpolates the samples themselves, so the tip of a `v` survives;
 * detected corners break the spline so they stay sharp.
 */
function appendSpine(path: SkPath, pts: XY[], corners: boolean[], move: boolean) {
  const n = pts.length;
  if (n === 0) return;
  if (move) path.moveTo(pts[0].x, pts[0].y);
  else path.lineTo(pts[0].x, pts[0].y);
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
    path.cubicTo(
      p1.x + (p2.x - p0.x) / 6,
      p1.y + (p2.y - p0.y) / 6,
      p2.x - (p3.x - p1.x) / 6,
      p2.y - (p3.y - p1.y) / 6,
      p2.x,
      p2.y
    );
  }
}

/**
 * Build the filled outline of a stroke. `finished` adds the exit taper; the
 * wet stroke leaves it off so its end stays a round nib at full width.
 */
export function buildStrokeOutline(
  rawPoints: InkPoint[],
  baseWidth: number,
  tool: InkTool,
  finished = true,
  noTaper = false
): SkPath {
  const path = Skia.Path.Make();
  const n = rawPoints.length;
  if (n === 0) return path;
  if (n === 1) {
    path.addCircle(rawPoints[0].x, rawPoints[0].y, Math.max(0.4, (baseWidth / 2) * (rawPoints[0].w ?? 1)));
    return path;
  }

  // Highlighters are a flat constant band: a stroked spine renders it cleanly.
  if (isConstantWidth(tool)) {
    appendSpine(path, rawPoints, cornerFlags(rawPoints), true);
    return path;
  }

  const points = withWidths(rawPoints, tool);
  const o = outline(points, baseWidth, tool, finished, noTaper);

  appendSpine(path, o.right, o.corners, true);
  for (const p of o.endCap) path.lineTo(p.x, p.y);
  appendSpine(path, o.left.slice().reverse(), o.corners.slice().reverse(), false);
  for (const p of o.startCap) path.lineTo(p.x, p.y);
  path.close();
  // Fill folds at tight turns (see Outline.patches); they are wound the same
  // way as the ring, so they add to it instead of cancelling.
  for (const q of o.patches) {
    path.moveTo(q[0].x, q[0].y);
    for (let k = 1; k < q.length; k++) path.lineTo(q[k].x, q[k].y);
    path.close();
  }
  return path;
}

/**
 * Identity-keyed cache for committed strokes. Stroke objects are immutable
 * once committed, so the reference is a sound key and a WeakMap lets entries
 * die with the stroke.
 */
const outlineCache = new WeakMap<object, SkPath>();

export function cachedOutline(
  stroke: object,
  points: InkPoint[],
  baseWidth: number,
  tool: InkTool,
  noTaper = false
): SkPath {
  const hit = outlineCache.get(stroke);
  if (hit) return hit;
  const built = buildStrokeOutline(points, baseWidth, tool, true, noTaper);
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
  fineliner: 1,
  calligraphy: 1,
  brush: 0.96,
};

/** Highlighters read as noticeably broader than the nominal nib width. */
export function effectiveWidth(tool: InkTool, width: number): number {
  return tool === 'highlighter' ? width * 2.4 : width;
}

/** The wet stroke: same geometry, no exit taper, never simplified. */
export function buildLiveOutline(points: InkPoint[], baseWidth: number, tool: InkTool): SkPath {
  return buildStrokeOutline(points, baseWidth, tool, false);
}
