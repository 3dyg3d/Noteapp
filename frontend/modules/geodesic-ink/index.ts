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
    /** Flat [x, y, t, p, w, x, y, t, p, w, ...] in world units. */
    points: number[];
  };
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
  onStroke: (e: NativeStrokeEvent) => void;
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
