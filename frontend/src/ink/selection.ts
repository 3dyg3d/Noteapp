/**
 * Geometry for moving, resizing and rotating selected items, and for copy /
 * paste. Pure functions over plain data, so they can be tested off-device.
 *
 * While the user drags, the selected items are only DRAWN through a matrix;
 * nothing is rebuilt. When they let go, the matrix is applied to the points
 * once (bakeItems). That keeps dragging a large selection smooth.
 */

export interface P {
  x: number;
  y: number;
}

/** Affine transform: x' = a·x + c·y + e,  y' = b·x + d·y + f. */
export interface Mat {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Just the item fields this module touches; the screen's own types satisfy it. */
export interface StrokeLike {
  kind: 'stroke';
  tool: string;
  color: string;
  width: number;
  points: P[]; // other point fields (t, p, w, ...) are carried through untouched
  shape?: string;
}
export interface ShapeLike {
  kind: 'shape';
  tool: string; // 'line' | 'rect' | 'ellipse'
  color: string;
  width: number;
  start: P;
  end: P;
}
/** Images and text boxes: a rectangle at (x, y), rotated by `angle` about its centre. */
export interface BoxLike {
  kind: 'image' | 'text';
  x: number;
  y: number;
  w: number;
  h: number;
  angle: number;
  fontSize?: number;
}
export type ItemLike = StrokeLike | ShapeLike | BoxLike;

export const isBox = (i: ItemLike): i is BoxLike => i.kind === 'image' || i.kind === 'text';

/** Corners of a box, rotation applied. */
export function boxCorners(b: BoxLike): P[] {
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const cs = Math.cos(b.angle || 0), sn = Math.sin(b.angle || 0);
  return [
    [-b.w / 2, -b.h / 2],
    [b.w / 2, -b.h / 2],
    [b.w / 2, b.h / 2],
    [-b.w / 2, b.h / 2],
  ].map(([u, v]) => ({ x: cx + u * cs - v * sn, y: cy + u * sn + v * cs }));
}

/** Is a world point inside a (rotated) box? */
export function boxContains(b: BoxLike, p: P): boolean {
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const cs = Math.cos(-(b.angle || 0)), sn = Math.sin(-(b.angle || 0));
  const dx = p.x - cx, dy = p.y - cy;
  const u = dx * cs - dy * sn, v = dx * sn + dy * cs;
  return Math.abs(u) <= b.w / 2 && Math.abs(v) <= b.h / 2;
}

export const IDENTITY: Mat = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export function apply(m: Mat, p: P): P {
  return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
}

/** m1 after m2 (apply m2 first). */
export function multiply(m1: Mat, m2: Mat): Mat {
  return {
    a: m1.a * m2.a + m1.c * m2.b,
    b: m1.b * m2.a + m1.d * m2.b,
    c: m1.a * m2.c + m1.c * m2.d,
    d: m1.b * m2.c + m1.d * m2.d,
    e: m1.a * m2.e + m1.c * m2.f + m1.e,
    f: m1.b * m2.e + m1.d * m2.f + m1.f,
  };
}

export const translate = (dx: number, dy: number): Mat => ({ a: 1, b: 0, c: 0, d: 1, e: dx, f: dy });

/** Uniform scale about an anchor point. */
export function scaleAbout(anchor: P, s: number): Mat {
  return multiply(translate(anchor.x, anchor.y), multiply({ a: s, b: 0, c: 0, d: s, e: 0, f: 0 }, translate(-anchor.x, -anchor.y)));
}

export function rotateAbout(center: P, angle: number): Mat {
  const cs = Math.cos(angle);
  const sn = Math.sin(angle);
  return multiply(translate(center.x, center.y), multiply({ a: cs, b: sn, c: -sn, d: cs, e: 0, f: 0 }, translate(-center.x, -center.y)));
}

/** For Skia's `matrix` prop (row-major 3x3). */
export function toSkia(m: Mat): number[] {
  return [m.a, m.c, m.e, m.b, m.d, m.f, 0, 0, 1];
}

/** How much a transform scales lengths (geometric mean of its axes). */
export function lengthScale(m: Mat): number {
  return Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
}

function isAxisAligned(m: Mat): boolean {
  return Math.abs(m.b) < 1e-6 && Math.abs(m.c) < 1e-6;
}

/** Bounds of one item including its line width. */
export function itemBounds(it: ItemLike, effectiveWidth: (tool: string, w: number) => number): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  if (isBox(it)) {
    for (const p of boxCorners(it)) {
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  const pts = it.kind === 'stroke' ? it.points : [it.start, it.end];
  for (const p of pts) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  // Variable-width pens can swell past their nominal width; allow for it.
  const pad = (it.kind === 'stroke' ? effectiveWidth(it.tool, it.width) * 1.4 : it.width) / 2;
  return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + 2 * pad, h: y1 - y0 + 2 * pad };
}

export function unionBounds(rects: Rect[]): Rect | null {
  if (!rects.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Outline of a rectangle or ellipse shape as a closed polyline (for rotation). */
function shapeOutline(s: ShapeLike): P[] {
  const x0 = Math.min(s.start.x, s.end.x), x1 = Math.max(s.start.x, s.end.x);
  const y0 = Math.min(s.start.y, s.end.y), y1 = Math.max(s.start.y, s.end.y);
  if (s.tool === 'rect') {
    const out: P[] = [];
    const corners = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }, { x: x0, y: y0 }];
    for (let i = 0; i < 4; i++) {
      const a = corners[i], b = corners[i + 1];
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 1.5));
      for (let k = 0; k < steps; k++) out.push({ x: a.x + ((b.x - a.x) * k) / steps, y: a.y + ((b.y - a.y) * k) / steps });
    }
    out.push(corners[4]);
    return out;
  }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = (x1 - x0) / 2, ry = (y1 - y0) / 2;
  const m = Math.max(24, Math.ceil((Math.PI * (rx + ry)) / 1.5));
  const out: P[] = [];
  for (let k = 0; k <= m; k++) {
    const t = (2 * Math.PI * k) / m;
    out.push({ x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t) });
  }
  return out;
}

/**
 * Apply a transform to an item for good. Stroke widths scale with the
 * selection. A rectangle or ellipse that is rotated can no longer be stored
 * as two corners, so it becomes an even-width stroke of the same outline.
 */
export function bakeItem(it: ItemLike, m: Mat): ItemLike {
  const s = lengthScale(m);
  if (isBox(it)) {
    // Move the centre, scale the size, add the rotation.
    const c = apply(m, { x: it.x + it.w / 2, y: it.y + it.h / 2 });
    const w = it.w * s, h = it.h * s;
    return {
      ...it,
      x: c.x - w / 2,
      y: c.y - h / 2,
      w,
      h,
      angle: (it.angle || 0) + Math.atan2(m.b, m.a),
      ...(it.fontSize ? { fontSize: it.fontSize * s } : {}),
    };
  }
  if (it.kind === 'stroke') {
    return {
      ...it,
      width: it.width * s,
      points: it.points.map((p) => ({ ...p, ...apply(m, p) })),
    };
  }
  if (it.tool === 'line' || isAxisAligned(m)) {
    return { ...it, width: it.width * s, start: apply(m, it.start), end: apply(m, it.end) };
  }
  const pts = shapeOutline(it).map((p) => ({ ...apply(m, p), t: 0, p: 0.5, w: 1 }));
  pts.forEach((p, i) => (p.t = i * 4));
  return {
    kind: 'stroke',
    tool: 'fineliner',
    color: it.color,
    width: it.width * s,
    points: pts,
    shape: it.tool === 'rect' ? 'rectangle' : 'ellipse',
  };
}

/** Deep copy (clipboard). Points are copied so later edits never alias. */
export function cloneItem(it: ItemLike): ItemLike {
  if (isBox(it)) return { ...it };
  if (it.kind === 'stroke') return { ...it, points: it.points.map((p) => ({ ...p })) };
  return { ...it, start: { ...it.start }, end: { ...it.end } };
}

/** Handle positions for a selection box (world units). */
export function handles(r: Rect, rotateOffset: number) {
  return {
    corners: [
      { x: r.x, y: r.y },
      { x: r.x + r.w, y: r.y },
      { x: r.x + r.w, y: r.y + r.h },
      { x: r.x, y: r.y + r.h },
    ],
    rotate: { x: r.x + r.w / 2, y: r.y - rotateOffset },
    center: { x: r.x + r.w / 2, y: r.y + r.h / 2 },
  };
}

/** Snap an angle to the nearest 15° when within 4°. */
export function snapAngle(a: number): number {
  const step = Math.PI / 12;
  const near = Math.round(a / step) * step;
  return Math.abs(a - near) < (4 * Math.PI) / 180 ? near : a;
}
