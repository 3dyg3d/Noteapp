/**
 * Native low-latency wet ink (Android). See android/src/main/java/.../InkView.kt.
 *
 * `NativeInkView` is null when the native module isn't in the build (web, or an
 * APK built before the module existed), and the drawing screen then keeps
 * using the JavaScript ink path.
 */
import type { ComponentType } from 'react';
import { Platform, type ViewProps } from 'react-native';
import { requireNativeViewManager, requireOptionalNativeModule } from 'expo-modules-core';

export interface NativeStrokeEvent {
  nativeEvent: {
    id: number;
    tool: string;
    /** Flat per-point values in world units: [x, y, t, p, w] or, with stride 6, [x, y, t, p, w, tilt]. */
    points: number[];
    stride?: number;
    /** Present when the stroke was snapped to a shape. */
    shape?: string;
  };
}

export interface NativeEraseEvent {
  /** Flat [x, y, x, y, ...] in world units, along the pen's path. */
  nativeEvent: { points: number[]; start?: boolean };
}

export interface NativeSelectEvent {
  /** 'rect' gives the two corners; 'lasso' the outline. Flat [x, y, ...] in world units. */
  nativeEvent: { kind: 'rect' | 'lasso' | string; points: number[] };
}

export interface NativePenButtonEvent {
  nativeEvent: { action: 'undo' | 'redo' | string };
}

export interface NativeInkViewProps extends ViewProps {
  inkEnabled: boolean;
  tool: string;
  /** #RRGGBB or #AARRGGBB (Android order). */
  inkColor: string;
  baseWidth: number;
  /** [scale, tx, ty]: world = (screen - t) / scale. */
  viewTransform: number[];
  /** [pageWidth, pageHeight, pageStride, pageCount]. */
  pages: number[];
  /** Draw the wet stroke straight into the on-screen buffer (Android 10+). */
  frontBuffer: boolean;
  /** Strokes with id <= this are drawn by JS now; the native layer drops them. */
  committedId: number;
  /** Hold the pen still at the end of a stroke to snap it to a clean shape. */
  shapeSnap: boolean;
  /** What a stylus touch does: 'ink' | 'erase' | 'lasso' | 'rect' | 'none'. */
  mode: string;
  /** Colour of the selection outline. */
  accentColor: string;
  /** [enabled 0/1, centreX, centreY, angleDegrees, halfThickness] in screen dp. */
  ruler: number[];
  /** S Pen side button: 'none' | 'eraser' | 'undo' | 'redo'. */
  buttonAction: string;
  /** Hover cursor diameter in world units; 0 hides it. */
  cursorWidth: number;
  eraserWidth: number;
  onStroke: (e: NativeStrokeEvent) => void;
  onErase: (e: NativeEraseEvent) => void;
  onPenButton: (e: NativePenButtonEvent) => void;
  onSelect: (e: NativeSelectEvent) => void;
}

function load(): ComponentType<NativeInkViewProps> | null {
  if (Platform.OS !== 'android') return null;
  try {
    if (!requireOptionalNativeModule('GeodesicInk')) return null;
    return requireNativeViewManager('GeodesicInk') as ComponentType<NativeInkViewProps>;
  } catch {
    return null;
  }
}

export const NativeInkView = load();

/**
 * Colours as Android's parser wants them. CSS #RRGGBBAA becomes #AARRGGBB;
 * rgb()/rgba() become hex. Anything unrecognised falls back to near-black.
 */
export function toAndroidColor(c: string): string {
  const s = (c || '').trim();
  let m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) return '#' + m[1].split('').map((ch) => ch + ch).join('');
  if (/^#[0-9a-f]{6}$/i.test(s)) return s;
  m = /^#([0-9a-f]{6})([0-9a-f]{2})$/i.exec(s);
  if (m) return `#${m[2]}${m[1]}`;
  m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(s);
  if (m) {
    const h = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
    const a = m[4] === undefined ? 1 : Number(m[4]);
    return `#${h(a * 255)}${h(Number(m[1]))}${h(Number(m[2]))}${h(Number(m[3]))}`;
  }
  return '#1A1A1C';
}

export interface PdfPage {
  /** Page size in PDF points. */
  width: number;
  height: number;
  /** JPEG data URI. */
  data: string;
}

/**
 * Render a PDF (content:// or file:// URI) to page images, on the device.
 * Null when the native module isn't in this build.
 */
export async function renderPdf(uri: string, maxWidth = 1600, quality = 82): Promise<{ pages: PdfPage[]; truncatedFrom?: number } | null> {
  if (Platform.OS !== 'android') return null;
  const mod = requireOptionalNativeModule<{ renderPdf(u: string, w: number, q: number): Promise<any[]> }>('GeodesicInk');
  if (!mod?.renderPdf) return null;
  const raw = await mod.renderPdf(uri, maxWidth, quality);
  const pages = raw.filter((p) => typeof p?.data === 'string') as PdfPage[];
  const t = raw.find((p) => typeof p?.truncated === 'number');
  return { pages, truncatedFrom: t?.truncated };
}

/**
 * Export a note (PDF) or one page (PNG) on the device. Returns the file path,
 * or null when the native module isn't in this build.
 */
export async function exportDoc(doc: object): Promise<string | null> {
  if (Platform.OS !== 'android') return null;
  const mod = requireOptionalNativeModule<{ exportDoc(json: string): Promise<string> }>('GeodesicInk');
  if (!mod?.exportDoc) return null;
  return mod.exportDoc(JSON.stringify(doc));
}
