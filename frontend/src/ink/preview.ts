/**
 * Card-sized preview of a handwriting document.
 *
 * The home screen used to render thumbnails by parsing each note's full
 * `drawing_data`, which meant the notes list downloaded every stroke of every
 * handwritten note and JSON-parsed it once per card, on every screen focus.
 * A page of dense handwriting is megabytes; twenty of them is a cold start
 * measured in seconds.
 *
 * A preview is generated once at save time and stored alongside the note. It is
 * capped hard, so the list payload stays bounded no matter how much is written.
 */

import { InkPoint } from './stroke';

/** Hard ceiling on a serialised preview. Beyond this we drop detail, not size. */
const MAX_PREVIEW_BYTES = 8 * 1024;
const MAX_STROKES = 60;
const MAX_POINTS_PER_STROKE = 14;
/** Coordinates are rounded to this many decimals; a thumbnail needs no more. */
const PRECISION = 1;

export interface PreviewDoc {
  /** Schema version, so the renderer can evolve without breaking old notes. */
  v: 1;
  /** Page width and height in document units, for aspect-correct scaling. */
  w: number;
  h: number;
  paper?: string;
  /** `[color, width, x0, y0, x1, y1, ...]` — flat, because JSON keys dominate size. */
  s: (string | number)[][];
}

interface PreviewStrokeInput {
  kind?: string;
  color?: string;
  width?: number;
  points?: InkPoint[];
  start?: { x: number; y: number };
  end?: { x: number; y: number };
}

function round(n: number): number {
  const f = Math.pow(10, PRECISION);
  return Math.round(n * f) / f;
}

/** Evenly sample at most `max` points, always keeping the first and last. */
function decimate(points: InkPoint[], max: number): InkPoint[] {
  if (points.length <= max) return points;
  const out: InkPoint[] = [];
  const step = (points.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)]);
  return out;
}

export function buildPreview(
  items: PreviewStrokeInput[],
  pageWidth: number,
  pageHeight: number,
  paper?: string
): string | null {
  if (!items?.length || pageWidth <= 0 || pageHeight <= 0) return null;

  // Only the first page appears on a card, so anything below it is dead weight.
  const onFirstPage = items.filter((it) => {
    const ys =
      it.kind === 'shape'
        ? [it.start?.y ?? 0, it.end?.y ?? 0]
        : (it.points ?? []).map((p) => p.y);
    return ys.length === 0 || Math.min(...ys) < pageHeight;
  });

  const build = (strokeCap: number, pointCap: number): PreviewDoc => ({
    v: 1,
    w: round(pageWidth),
    h: round(pageHeight),
    ...(paper ? { paper } : {}),
    s: onFirstPage.slice(0, strokeCap).map((it) => {
      const flat: (string | number)[] = [it.color ?? '#000', round(it.width ?? 2)];
      if (it.kind === 'shape' && it.start && it.end) {
        flat.push(round(it.start.x), round(it.start.y), round(it.end.x), round(it.end.y));
      } else {
        for (const p of decimate(it.points ?? [], pointCap)) {
          flat.push(round(p.x), round(p.y));
        }
      }
      return flat;
    }),
  });

  // Shed detail until it fits, rather than storing something unbounded.
  let strokeCap = MAX_STROKES;
  let pointCap = MAX_POINTS_PER_STROKE;
  let json = JSON.stringify(build(strokeCap, pointCap));
  while (json.length > MAX_PREVIEW_BYTES && (strokeCap > 8 || pointCap > 4)) {
    strokeCap = Math.max(8, Math.floor(strokeCap * 0.7));
    pointCap = Math.max(4, Math.floor(pointCap * 0.7));
    json = JSON.stringify(build(strokeCap, pointCap));
  }
  return json.length > MAX_PREVIEW_BYTES ? null : json;
}

export function parsePreview(raw?: string | null): PreviewDoc | null {
  if (!raw) return null;
  try {
    const doc = JSON.parse(raw);
    // Anything not matching the expected shape is treated as absent rather than
    // allowed to throw inside a list cell and take the grid down with it.
    if (doc?.v !== 1 || !Array.isArray(doc.s) || typeof doc.w !== 'number') return null;
    return doc as PreviewDoc;
  } catch {
    return null;
  }
}
