/**
 * Keeps a native stored-ink view (NativeDryView) in step with the note.
 *
 * The native side holds its own copy of every stroke, keyed by a number. Each
 * sync sends the full drawing order (cheap: numbers only) and point data only
 * for strokes the view doesn't hold yet: a freshly loaded note, a stroke
 * brought back by undo, or one that was moved or cut by the eraser (those are
 * new objects, so new ids).
 *
 * Strokes written with the native pen already exist on the native side under
 * the pen's own id, so they're registered here instead of being sent back.
 */
import { syncDry } from '@/modules/geodesic-ink';
import { InkPoint, InkTool, withWidths } from './geometry';

export interface DryStrokeLike {
  kind: 'stroke';
  tool: string;
  color: string;
  width: number;
  points: InkPoint[];
  shape?: string;
}

const STRIDE = 6;
const ids = new WeakMap<object, number>();
// The native pen numbers its strokes from 1; these never meet them.
let nextId = 1_000_000_000;

export function strokeId(s: object): number {
  let id = ids.get(s);
  if (id === undefined) {
    id = nextId++;
    ids.set(s, id);
  }
  return id;
}

/** A stroke the native pen wrote: it already knows it by this id. */
export function adoptNativeId(s: object, id: number): void {
  ids.set(s, id);
}

export class DrySync {
  /** What the native view holds (as far as we know). */
  private held = new Set<number>();
  private drops: number[] = [];

  constructor(
    readonly group: string,
    private readonly toColor: (c: string) => string
  ) {}

  /** The native view is new and empty. */
  reset(): void {
    this.held.clear();
    this.drops = [];
  }

  /** The native view has this stroke already (the pen wrote it there). */
  holds(id: number): void {
    this.held.add(id);
  }

  /** A pen stroke the note didn't keep: remove it there. */
  drop(id: number): void {
    this.held.delete(id);
    this.drops.push(id);
  }

  sync(strokes: DryStrokeLike[], hidden: Set<object>): void {
    const order: number[] = [];
    const hiddenIds: number[] = [];
    const adds: { id: number; tool: string; color: string; width: number; shape?: boolean; n: number }[] = [];
    const addPts: InkPoint[][] = [];
    let total = 0;
    const next = new Set<number>();
    for (const s of strokes) {
      const id = strokeId(s);
      order.push(id);
      next.add(id);
      if (hidden.has(s)) hiddenIds.push(id);
      if (this.held.has(id) || !s.points.length) continue;
      const pts = withWidths(s.points, s.tool as InkTool);
      adds.push({
        id,
        tool: s.tool,
        color: this.toColor(s.color),
        width: s.width,
        ...(s.shape ? { shape: true } : {}),
        n: pts.length,
      });
      addPts.push(pts);
      total += pts.length;
    }
    const data = new Float32Array(total * STRIDE);
    let o = 0;
    for (const pts of addPts) {
      for (const p of pts) {
        data[o] = p.x;
        data[o + 1] = p.y;
        data[o + 2] = p.t ?? 0;
        data[o + 3] = p.p ?? 0.55;
        data[o + 4] = p.w ?? 0; // 0: work it out natively
        data[o + 5] = p.a ?? 0;
        o += STRIDE;
      }
    }
    const meta = JSON.stringify({ order, hidden: hiddenIds, drops: this.drops, adds });
    this.drops = [];
    this.held = next;
    syncDry(this.group, meta, data);
  }
}
