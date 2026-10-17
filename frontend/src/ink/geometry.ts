/**
 * Pure ink geometry: no Skia, no React, so it can be tested off-device.
 *
 * What changed from the first version, and why each one was visible on paper:
 *
 *  1. Width is decided once, when a sample is captured, and stored on the
 *     point (`w`). Before, width was recomputed from speed between neighbouring
 *     samples at render time. Commit simplifies the stroke (drops redundant
 *     samples), which changes the spacing between neighbours, which changed the
 *     computed speed, which changed the width. Every stroke visibly fattened or
 *     thinned in places the moment the pen lifted.
 *
 *  2. Tapers are measured in distance along the stroke, not as a fraction of
 *     the sample count. A fraction of the count moves as the count grows: the
 *     start of a word kept re-tapering while you were still writing it, and the
 *     wet end of the line was always pinched to a point that crawled along
 *     behind the nib ("worm" effect).
 *
 *  3. The end taper is applied only once the stroke is finished. While the pen
 *     is down the wet end is a round cap at full width, like real ink under a
 *     nib.
 *
 *  4. Pressure goes through a curve. Digitisers report most ordinary writing in
 *     the bottom third of the range, so a linear map left the pens' dynamic
 *     range mostly unused.
 *
 *  5. Positions can be passed through a One Euro filter (adaptive low-pass):
 *     strong smoothing when the pen moves slowly, where digitiser jitter shows
 *     as fuzz, almost none when it moves fast, where smoothing would show as
 *     lag and rounded corners.
 */

export interface InkPoint {
  x: number;
  y: number;
  /** Monotonic milliseconds. Sub-millisecond resolution where available. */
  t: number;
  /** Normalised stylus pressure 0..1. Undefined for finger/mouse input. */
  p?: number;
  /**
   * Width factor (multiplier of the nominal half width) fixed at capture time.
   * Absent on strokes written before it existed; those are annotated on load.
   */
  w?: number;
}

export type InkTool = 'pen' | 'fountain' | 'marker' | 'highlighter' | 'pencil';

export interface ToolProfile {
  /** Width multiplier at minimum pressure / maximum speed. */
  minScale: number;
  /** Width multiplier at maximum pressure / minimum speed. */
  maxScale: number;
  /** 0 = ignore pressure, 1 = pressure fully drives width. */
  pressureWeight: number;
  /** 0 = ignore speed, 1 = speed fully drives width. */
  speedWeight: number;
  /** Length of the entry taper, in multiples of the nominal width. */
  taperStart: number;
  /** Length of the exit taper, in multiples of the nominal width. */
  taperEnd: number;
  /** How much of the previous width carries into the next sample (0..1). */
  smoothing: number;
  /** Pressure curve exponent. Below 1 lifts light pressure. */
  pressureGamma: number;
}

export const PROFILES: Record<InkTool, ToolProfile> = {
  // A ballpoint: modest swell, short crisp ends.
  pen: { minScale: 0.78, maxScale: 1.18, pressureWeight: 0.85, speedWeight: 0.15, taperStart: 2.2, taperEnd: 1.4, smoothing: 0.5, pressureGamma: 0.7 },
  // The expressive one: wide range, long entry and exit.
  fountain: { minScale: 0.3, maxScale: 1.8, pressureWeight: 0.7, speedWeight: 0.3, taperStart: 4.5, taperEnd: 3.5, smoothing: 0.45, pressureGamma: 0.8 },
  marker: { minScale: 0.95, maxScale: 1.05, pressureWeight: 0.4, speedWeight: 0, taperStart: 0.4, taperEnd: 0.4, smoothing: 0.8, pressureGamma: 1 },
  // Flat and constant, or overlapping passes look blotchy.
  highlighter: { minScale: 1, maxScale: 1, pressureWeight: 0, speedWeight: 0, taperStart: 0, taperEnd: 0, smoothing: 1, pressureGamma: 1 },
  pencil: { minScale: 0.65, maxScale: 1.15, pressureWeight: 0.85, speedWeight: 0.15, taperStart: 2, taperEnd: 1.5, smoothing: 0.5, pressureGamma: 0.75 },
};

export function profileFor(tool: InkTool): ToolProfile {
  return PROFILES[tool] ?? PROFILES.pen;
}

export function isConstantWidth(tool: InkTool): boolean {
  const p = profileFor(tool);
  return p.minScale === 1 && p.maxScale === 1 && p.taperStart === 0 && p.taperEnd === 0;
}

/** Speed, in world px/ms, treated as "fast" for width purposes. */
const FAST_SPEED = 2.2;
/** Angle (radians) above which a vertex is treated as a corner and not smoothed. */
const CORNER_THRESHOLD = Math.PI / 2.2;
/** Samples looked back over when estimating speed, so one jittery timestamp can't spike it. */
const SPEED_WINDOW = 3;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const round3 = (v: number) => Math.round(v * 1000) / 1000;
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(b.x - a.x, b.y - a.y);

/**
 * Fix the width factor of `points[i]`, given that every earlier point already
 * has one. Called once per captured sample, so live and committed strokes use
 * the same numbers.
 */
export function annotateWidth(points: InkPoint[], i: number, tool: InkTool): void {
  const prof = profileFor(tool);
  const cur = points[i];
  const range = prof.maxScale - prof.minScale;

  let speedTerm = 1;
  if (i > 0) {
    const j = Math.max(0, i - SPEED_WINDOW);
    let len = 0;
    for (let k = j + 1; k <= i; k++) len += dist(points[k - 1], points[k]);
    const dt = Math.max(1, cur.t - points[j].t);
    speedTerm = 1 - clamp01(len / dt / FAST_SPEED);
  }
  // No reported pressure means finger or mouse: a neutral mid weight.
  const pressureTerm = cur.p === undefined ? 0.55 : Math.pow(clamp01(cur.p), prof.pressureGamma);
  const total = prof.pressureWeight + prof.speedWeight || 1;
  const mix = (pressureTerm * prof.pressureWeight + speedTerm * prof.speedWeight) / total;
  const target = prof.minScale + range * mix;

  const prev = i > 0 ? points[i - 1].w : undefined;
  const w = prev === undefined ? target : prev + (target - prev) * (1 - prof.smoothing);
  cur.w = round3(w);
}

/** Copies of `points` with a width factor on each (for strokes saved without one). */
export function withWidths(points: InkPoint[], tool: InkTool): InkPoint[] {
  if (points.length > 0 && points.every((p) => typeof p.w === 'number')) return points;
  const out = points.map((p) => ({ ...p, w: undefined as number | undefined }));
  for (let i = 0; i < out.length; i++) annotateWidth(out, i, tool);
  return out;
}

/**
 * Drop samples that carry no shape information, measured by position and by
 * width factor (a straight stroke that swells is still information).
 */
export function simplify(points: InkPoint[], tolerance = 0.25, widthTolerance = 0.025): InkPoint[] {
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
    let worst = -1;
    let worstIdx = -1;
    for (let i = lo + 1; i < hi; i++) {
      const p = points[i];
      let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      let err = Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)) / tolerance;
      if (a.w !== undefined && b.w !== undefined && p.w !== undefined) {
        err = Math.max(err, Math.abs(p.w - (a.w + (b.w - a.w) * t)) / widthTolerance);
      } else if (a.p !== undefined && b.p !== undefined && p.p !== undefined) {
        err = Math.max(err, Math.abs(p.p - (a.p + (b.p - a.p) * t)) / 0.06);
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
 * The points to store for a finished stroke: simplified, except inside the
 * entry and exit tapers. The width there follows a curve in distance along
 * the stroke, and dropping samples from a tip straightens that curve, so the
 * tips would visibly change shape on pen-up.
 */
export function commitPoints(points: InkPoint[], tool: InkTool, baseWidth: number): InkPoint[] {
  const n = points.length;
  if (n <= 2) return points.slice();
  const prof = profileFor(tool);
  const s = new Array<number>(n);
  s[0] = 0;
  for (let i = 1; i < n; i++) s[i] = s[i - 1] + dist(points[i - 1], points[i]);
  const L = s[n - 1];
  const head = Math.min(prof.taperStart * baseWidth, L * 0.4);
  const tail = Math.min(prof.taperEnd * baseWidth, L * 0.4);
  let a = 0;
  while (a < n - 1 && s[a] < head) a++;
  let b = n - 1;
  while (b > a && L - s[b] < tail) b--;
  return [...points.slice(0, a), ...simplify(points.slice(a, b + 1)), ...points.slice(b + 1)];
}

/**
 * The points stored for a finished stroke: every captured sample, rounded.
 *
 * Strokes used to be simplified here (redundant samples dropped). The curve
 * is drawn as a spline through the stored samples, and a spline through fewer
 * samples bends differently, so the stroke visibly re-shaped itself a moment
 * after the pen lifted, when the saved copy replaced the one drawn live.
 * Keeping every sample makes the saved stroke identical to what was drawn.
 * Rounding (0.01 px, 0.001 for pressure and width) keeps the stored size down
 * without any visible change.
 */
export function storePoints(points: InkPoint[]): InkPoint[] {
  if (points.length === 0) return [];
  const t0 = points[0].t;
  const r = (v: number, k: number) => Math.round(v * k) / k;
  return points.map((p) => {
    const out: InkPoint = { x: r(p.x, 100), y: r(p.y, 100), t: r(p.t - t0, 10) };
    if (p.p !== undefined) out.p = r(p.p, 1000);
    if (p.w !== undefined) out.w = r(p.w, 1000);
    return out;
  });
}

/** Ease-out from a thin tip to full width. */
function taperEase(u: number): number {
  const v = clamp01(u);
  return 0.16 + 0.84 * (v * (2 - v));
}

/** Per-point taper multiplier by distance from each end. */
export function taperFactors(points: InkPoint[], baseWidth: number, tool: InkTool, finished: boolean): number[] {
  const prof = profileFor(tool);
  const n = points.length;
  const s = new Array<number>(n);
  s[0] = 0;
  for (let i = 1; i < n; i++) s[i] = s[i - 1] + dist(points[i - 1], points[i]);
  const L = s[n - 1] || 0;
  const startLen = Math.min(prof.taperStart * baseWidth, L * 0.4);
  const endLen = finished ? Math.min(prof.taperEnd * baseWidth, L * 0.4) : 0;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    let k = 1;
    if (startLen > 0 && s[i] < startLen) k *= taperEase(s[i] / startLen);
    if (endLen > 0 && L - s[i] < endLen) k *= taperEase((L - s[i]) / endLen);
    out[i] = k;
  }
  return out;
}

export interface XY {
  x: number;
  y: number;
}

/** Unit normals at each sample, averaged across adjacent segments. */
export function normals(points: XY[]): { nx: number; ny: number }[] {
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
    const len = Math.hypot(nx, ny);
    // Opposite segments (a hairpin) cancel out: fall back to the incoming one.
    out.push(len < 1e-6 ? a : { nx: nx / len, ny: ny / len });
  }
  return out;
}

export function corners(points: XY[]): boolean[] {
  return points.map((b, i) => {
    const a = points[i - 1];
    const c = points[i + 1];
    if (!a || !c) return false;
    const a1 = Math.atan2(b.y - a.y, b.x - a.x);
    const a2 = Math.atan2(c.y - b.y, c.x - b.x);
    let d = Math.abs(a2 - a1);
    if (d > Math.PI) d = 2 * Math.PI - d;
    return d > CORNER_THRESHOLD;
  });
}

export interface Outline {
  right: XY[];
  left: XY[];
  /** Points around the far end, from right[n-1] to left[n-1] (exclusive). */
  endCap: XY[];
  /** Points around the start, from left[0] to right[0] (exclusive). */
  startCap: XY[];
  corners: boolean[];
  halfWidths: number[];
}

const CAP_STEPS = 6;

/**
 * Both sides of a variable-width stroke plus round caps. `points` must already
 * carry width factors (see annotateWidth / withWidths).
 */
export function outline(points: InkPoint[], baseWidth: number, tool: InkTool, finished: boolean): Outline {
  const n = points.length;
  const taper = taperFactors(points, baseWidth, tool, finished);
  const nrm = normals(points);
  const half = baseWidth / 2;
  const hw = points.map((p, i) => Math.max(0.15, half * (p.w ?? 1) * taper[i]));
  const right: XY[] = [];
  const left: XY[] = [];
  for (let i = 0; i < n; i++) {
    const { nx, ny } = nrm[i];
    right.push({ x: points[i].x + nx * hw[i], y: points[i].y + ny * hw[i] });
    left.push({ x: points[i].x - nx * hw[i], y: points[i].y - ny * hw[i] });
  }
  const cap = (c: XY, nx: number, ny: number, r: number, sign: 1 | -1): XY[] => {
    // Direction of travel is (ny, -nx). Sweep from +n through ±d to -n.
    const dx = ny * sign;
    const dy = -nx * sign;
    const nsx = nx * sign;
    const nsy = ny * sign;
    const out: XY[] = [];
    for (let k = 1; k < CAP_STEPS; k++) {
      const th = (Math.PI * k) / CAP_STEPS;
      const cx = nsx * Math.cos(th) + dx * Math.sin(th);
      const cy = nsy * Math.cos(th) + dy * Math.sin(th);
      out.push({ x: c.x + cx * r, y: c.y + cy * r });
    }
    return out;
  };
  const endCap = cap(points[n - 1], nrm[n - 1].nx, nrm[n - 1].ny, hw[n - 1], 1);
  const startCap = cap(points[0], nrm[0].nx, nrm[0].ny, hw[0], -1);
  return { right, left, endCap, startCap, corners: corners(points), halfWidths: hw };
}

/**
 * One Euro filter (Casiez et al. 2012), applied to x and y together.
 * `minCutoff` (Hz) sets smoothing at rest; `beta` how quickly it relaxes with
 * speed (in px/s), so fast strokes keep their shape and slow ones lose jitter.
 */
export class OneEuro2D {
  private x = 0;
  private y = 0;
  private dx = 0;
  private dy = 0;
  private t = -1;
  constructor(
    // Tuned on synthetic 240 Hz input with 0.3 px digitiser noise: slow
    // strokes lose ~60% of their jitter; lag stays under ~0.75 px at any
    // writing speed. Stronger settings trade that for visible trailing.
    private minCutoff = 5,
    private beta = 0.2,
    private dCutoff = 1
  ) {}

  reset(): void {
    this.t = -1;
  }

  private static alpha(cutoff: number, dtSec: number): number {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dtSec);
  }

  filter(x: number, y: number, tMs: number): XY {
    if (this.t < 0) {
      this.x = x;
      this.y = y;
      this.dx = 0;
      this.dy = 0;
      this.t = tMs;
      return { x, y };
    }
    const dt = Math.max(0.0005, (tMs - this.t) / 1000);
    this.t = tMs;
    const ad = OneEuro2D.alpha(this.dCutoff, dt);
    this.dx += ad * ((x - this.x) / dt - this.dx);
    this.dy += ad * ((y - this.y) / dt - this.dy);
    const speed = Math.hypot(this.dx, this.dy);
    const a = OneEuro2D.alpha(this.minCutoff + this.beta * speed, dt);
    this.x += a * (x - this.x);
    this.y += a * (y - this.y);
    return { x: this.x, y: this.y };
  }
}
