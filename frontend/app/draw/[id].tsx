import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  Platform,
  TextInput,
  ActivityIndicator,
  Alert,
  Modal,
  useWindowDimensions,
  StatusBar,
  AppState,
} from 'react-native';
import type { DimensionValue, ViewStyle } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Ruler, { RulerState, rulerProject, rulerEdgeDistance, rulerEdgeSign, rulerContains, RULER_H } from '@/src/components/Ruler';
import RulerSettingsMenu from '@/src/components/RulerSettingsMenu';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { Canvas, Path, Skia, SkPath, Group, Circle, DashPathEffect, Paragraph, Image as SkiaImage, type SkImage, type SkParagraph } from '@shopify/react-native-skia';
import {
  type Mat,
  type Rect as SelRect,
  bakeItem,
  boxCorners,
  boxContains,
  cloneItem,
  handles as selHandles,
  itemBounds,
  lengthScale,
  rotateAbout,
  scaleAbout,
  snapAngle,
  toSkia,
  translate,
  unionBounds,
} from '@/src/ink/selection';
import InkStroke from '@/src/ink/InkStroke';
import LiveStrokeLayer, { LiveStrokeHandle } from '@/src/ink/LiveStrokeLayer';
import {
  NativeInkView,
  toAndroidColor,
  type NativeStrokeEvent,
  type NativeEraseEvent,
  type NativePenButtonEvent,
  type NativeSelectEvent,
  exportDoc,
} from '@/modules/geodesic-ink';
import * as Sharing from 'expo-sharing';
import { InkPoint, InkTool, inkNow, storePoints, annotateWidth, OneEuro2D, effectiveWidth } from '@/src/ink/stroke';
import { buildPreview } from '@/src/ink/preview';
import type { SaveStatus } from '@/src/hooks/usePatchQueue';
import { onNoteRenamed } from '@/src/state/noteEvents';
import { StorageKeys } from '@/src/state/storageKeys';
import { GestureDetector, Gesture, PointerType } from 'react-native-gesture-handler';
import { useSharedValue } from 'react-native-reanimated';

import { useTheme } from '@/src/theme/ThemeContext';
import { spacing, radius, typeScale, withAlpha, CANVAS_COLORS } from '@/src/theme/tokens';
import { NotesApi, LabelsApi, FoldersApi, Note, Label, Folder } from '@/src/api/client';
import * as ImagePicker from 'expo-image-picker';
import { displayTitle } from '@/src/notes/display';
import { useAppSettings, haptic, GestureAction, ToolbarPosition, type PageSetup } from '@/src/state/useAppSettings';
import { useOpenTabs } from '@/src/state/useOpenTabs';
import OpenTabsStrip from '@/src/components/OpenTabsStrip';
import SkiaPaper from '@/src/components/SkiaPaper';
import PaperPreview from '@/src/components/PaperPreview';
import SaveIndicator from '@/src/components/SaveIndicator';
import { labelColors } from '@/src/theme/tokens';

// ---------- Types ----------
type PenTool = 'pen' | 'fountain' | 'marker' | 'highlighter' | 'pencil' | 'fineliner' | 'calligraphy' | 'brush';
type ShapeTool = 'line' | 'rect' | 'ellipse';
type Tool = PenTool | ShapeTool | 'eraser';

interface Pt { x: number; y: number; t: number }
interface StrokeData {
  kind: 'stroke';
  tool: PenTool;
  color: string;
  width: number;
  /**
   * `p` is normalised stylus pressure where the digitiser reported it. Absent
   * for finger and mouse input, in which case width falls back to a velocity
   * model. Documents written before pressure capture simply have no `p`, and
   * render exactly as they did.
   */
  points: InkPoint[];
  /** Set when the stroke was snapped to a clean shape ("circle", "rectangle", ...). */
  shape?: string;
}
interface ShapeData {
  kind: 'shape';
  tool: ShapeTool;
  color: string;
  width: number;
  start: { x: number; y: number };
  end: { x: number; y: number };
}
/** A picture on the page. `ref` indexes the note's `images` (JPEG data URIs). */
interface ImageItem {
  kind: 'image';
  ref: number;
  x: number;
  y: number;
  w: number;
  h: number;
  angle: number;
}
/** A typed text box on the page; `h` is the laid-out height, kept for hit tests. */
interface TextItem {
  kind: 'text';
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fontSize: number;
  color: string;
  angle: number;
}
type Item = StrokeData | ShapeData | ImageItem | TextItem;

/** The y used to decide which page an item belongs to. */
function itemHomeY(it: Item): number {
  if (it.kind === 'stroke') return it.points[0]?.y ?? 0;
  if (it.kind === 'shape') return it.start.y;
  return it.y + it.h / 2;
}

/** Move an item vertically (page reordering, deleting, inserting). */
function shiftItem(it: Item, dy: number): Item {
  if (it.kind === 'stroke') return { ...it, points: it.points.map((p) => ({ ...p, y: p.y + dy })) };
  if (it.kind === 'shape') return { ...it, start: { ...it.start, y: it.start.y + dy }, end: { ...it.end, y: it.end.y + dy } };
  return { ...it, y: it.y + dy };
}

/** Push down everything at or below `boundary` (inserting a page). */
function shiftBelow(it: Item, boundary: number, dy: number): Item {
  if (it.kind === 'stroke') return { ...it, points: it.points.map((p) => (p.y >= boundary ? { ...p, y: p.y + dy } : p)) };
  if (it.kind === 'shape') {
    return {
      ...it,
      start: { x: it.start.x, y: it.start.y >= boundary ? it.start.y + dy : it.start.y },
      end: { x: it.end.x, y: it.end.y >= boundary ? it.end.y + dy : it.end.y },
    };
  }
  return it.y >= boundary ? { ...it, y: it.y + dy } : it;
}

/** Cached text layout: one paragraph per (text, size, colour, width). */
const paragraphCache = new Map<string, SkParagraph>();
function textParagraph(text: string, fontSize: number, color: string, width: number): SkParagraph {
  const key = `${fontSize}|${color}|${Math.round(width)}|${text}`;
  const hit = paragraphCache.get(key);
  if (hit) return hit;
  const b = Skia.ParagraphBuilder.Make();
  b.pushStyle({ color: Skia.Color(color), fontSize, fontFamilies: ['sans-serif'] });
  b.addText(text.length ? text : ' ');
  const para = b.build();
  para.layout(Math.max(10, width));
  if (paragraphCache.size > 300) paragraphCache.clear();
  paragraphCache.set(key, para);
  return para;
}

/**
 * Copied ink. Module-level so it survives switching notes: copy on one page,
 * paste on another. Cleared only by the next copy.
 */
let inkClipboard: Item[] = [];

/** Indices of items with any point inside a rectangle (two corners) or lasso polygon. */
function selectionHits(items: Item[], kind: 'rect' | 'lasso', outline: { x: number; y: number }[]): number[] {
  let inside: (x: number, y: number) => boolean;
  if (kind === 'rect') {
    if (outline.length < 2) return [];
    const [a, b] = [outline[0], outline[outline.length - 1]];
    const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x);
    const minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);
    inside = (x, y) => x >= minX && x <= maxX && y >= minY && y <= maxY;
  } else {
    if (outline.length < 3) return [];
    inside = (x, y) => {
      let inPoly = false;
      for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
        const xi = outline[i].x, yi = outline[i].y, xj = outline[j].x, yj = outline[j].y;
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inPoly = !inPoly;
      }
      return inPoly;
    };
  }
  const hit: number[] = [];
  items.forEach((it, idx) => {
    const pts =
      it.kind === 'stroke'
        ? it.points
        : it.kind === 'shape'
        ? [it.start, it.end, { x: it.start.x, y: it.end.y }, { x: it.end.x, y: it.start.y }]
        : [...boxCorners(it), { x: it.x + it.w / 2, y: it.y + it.h / 2 }];
    if (pts.some((p) => inside(p.x, p.y))) hit.push(idx);
  });
  return hit;
}

type Paper = 'blank' | 'ruled' | 'narrow' | 'grid' | 'dotted' | 'cornell' | 'planner' | 'todo' | 'engineering' | 'graph';
type PaperSize = 'a4' | 'a5' | 'letter' | 'index' | 'custom';

interface DrawingDoc {
  paper: Paper;
  paperSize?: PaperSize;
  customSize?: { w: number; h: number }; // pixel dimensions used when paperSize === 'custom'
  /** Per page: index into the note's images used as that page's background (an imported PDF page), or null. */
  pageBackgrounds?: (number | null)[];
  pageTemplates?: (string | null)[];
  pageBookmarks?: boolean[];
  orientation?: 'portrait' | 'landscape';
  paperColor?: string;
  canvasColor?: string;
  lineSpacing?: number; // pixel spacing for ruled / grid / dotted templates
  pageCount?: number;   // number of stacked pages in this note
  docVersion?: number;  // 1 = pre-gap (contiguous world y), 2 = gap-inclusive world y
  items: Item[];
}

// Ratio = width / height of the page in PORTRAIT
const PAPER_SIZES: Record<Exclude<PaperSize, 'custom'>, { ratio: number; label: string }> = {
  a4:     { ratio: 1 / 1.4142, label: 'A4' },
  a5:     { ratio: 1 / 1.4142, label: 'A5' },
  letter: { ratio: 8.5 / 11,   label: 'Letter' },
  index:  { ratio: 5 / 3,      label: 'Index card' },
};

const PAPER_COLORS: { id: string; light: string; dark: string }[] = [
  { id: 'white',  light: '#FBFAF6', dark: '#1a1a1c' },
  { id: 'cream',  light: '#F4ECDA', dark: '#2a2520' },
  { id: 'yellow', light: '#FFF4C4', dark: '#33301f' },
  { id: 'mint',   light: '#E1F0E0', dark: '#1f2a23' },
  { id: 'sky',    light: '#DCE6F0', dark: '#1f2630' },
  { id: 'rose',   light: '#F5DDDD', dark: '#2a1f1f' },
  { id: 'gray',   light: '#ECECEC', dark: '#222226' },
  { id: 'black',  light: '#0a0a0a', dark: '#0a0a0a' },
];

// ---------- Constants ----------
// Full palette shown in tool popovers (long-press / re-tap tool).
const PALETTE = ['#1A1A1C', '#FFFFFF', '#B85C5C', '#D4A352', '#7B8C73', '#6E7A8A', '#8B7AA8', '#638C61', '#E11D48', '#2563EB', '#059669', '#DB2777'];
// Quick colors shown as inline chips on the main toolbar — the four everyday colors.
// These are DEFAULTS; the user can long-press a slot to reassign it via the grid picker.
const DEFAULT_QUICK_COLORS = ['#E11D48' /* red */, '#2563EB' /* blue */, '#1A1A1C' /* black */, '#FFFFFF' /* white */, '#059669' /* green */, '#D4A352' /* amber */];

// A Photoshop-style grid palette (8 columns × 8 rows) used everywhere the user
// picks a color. Rows are: grayscale, red, orange, yellow, green, blue, purple, brown.
const COLOR_GRID: string[][] = [
  ['#000000','#333333','#4D4D4D','#666666','#808080','#B3B3B3','#CCCCCC','#FFFFFF'],
  ['#7F0000','#B30000','#E30000','#FF3B30','#FF6961','#FFB3AB','#FFD9D6','#FFECEB'],
  ['#7F3F00','#B36200','#E38800','#FF9500','#FFB759','#FFD59A','#FFE6C2','#FFF2E0'],
  ['#7F6500','#B38F00','#E3B800','#FFCC00','#FFE066','#FFEE9C','#FFF6C7','#FFFBE6'],
  ['#00532A','#00753E','#009F55','#34C759','#69D97C','#A5E9B3','#CDF1D5','#EAF9EC'],
  ['#003E7A','#0057B7','#0075FF','#007AFF','#4C9DFF','#8CBFFF','#C4DDFF','#E4EFFF'],
  ['#3C0072','#5A00A6','#7D2AE8','#AF52DE','#C387E8','#D7ADEF','#E9CFF6','#F5E7FA'],
  ['#3D1F00','#5A2E00','#7B4200','#A66324','#C4864A','#D9AA79','#E9C9A8','#F6E5D2'],
];

// Continuous-slider ranges per tool (in points). Users can pick any value in [min, max].
const WIDTH_RANGE: Record<Tool, { min: number; max: number }> = {
  pen:         { min: 0.5, max: 12 },
  fountain:    { min: 1,   max: 14 },
  marker:      { min: 2,   max: 22 },
  highlighter: { min: 4,   max: 36 },
  pencil:      { min: 0.5, max: 8  },
  fineliner:   { min: 0.3, max: 6  },
  calligraphy: { min: 2,   max: 20 },
  brush:       { min: 2,   max: 30 },
  eraser:      { min: 4,   max: 60 },
  line:        { min: 1,   max: 12 },
  rect:        { min: 1,   max: 12 },
  ellipse:     { min: 1,   max: 12 },
};

const DEFAULT_WIDTHS: Record<Tool, number> = {
  pen: 3, fountain: 5, marker: 10, highlighter: 20, pencil: 2, eraser: 24,
  fineliner: 1.2, calligraphy: 7, brush: 8,
  line: 3, rect: 3, ellipse: 3,
};

// ---------- Tool families ----------
// The toolbar shows FAMILY buttons; the popover picks a VARIANT for families that
// have more than one. The `tool` state still holds a concrete internal drawing tool
// (see the Tool type above); family+variant just drive the UI and select the
// internal tool.
type ToolFamily = 'pen' | 'pencil' | 'marker' | 'tape' | 'select' | 'laser' | 'eraser';

const FAMILY_ORDER: ToolFamily[] = ['pen', 'pencil', 'marker', 'tape', 'select', 'laser', 'eraser'];

const FAMILY_META: Record<ToolFamily, { label: string; icon: any; lib?: 'ion' | 'mci' }> = {
  pen:    { label: 'Pen',    icon: 'fountain-pen-tip', lib: 'mci' },
  pencil: { label: 'Pencil', icon: 'pencil',           lib: 'mci' },
  marker: { label: 'Marker', icon: 'marker',           lib: 'mci' },
  tape:   { label: 'Tape',   icon: 'format-color-highlight', lib: 'mci' },
  select: { label: 'Select', icon: 'selection',        lib: 'mci' },
  laser:  { label: 'Laser',  icon: 'laser-pointer',    lib: 'mci' },
  eraser: { label: 'Eraser', icon: 'eraser',           lib: 'mci' },
};

const FAMILY_VARIANTS: Record<ToolFamily, { key: string; label: string; icon: any; lib?: 'ion' | 'mci' }[]> = {
  pen:    [ { key: 'fountain',    label: 'Fountain',    icon: 'fountain-pen', lib: 'mci' },
            { key: 'ballpoint',   label: 'Ballpoint',   icon: 'pen',          lib: 'mci' },
            { key: 'fineliner',   label: 'Fineliner',   icon: 'draw-pen',     lib: 'mci' },
            { key: 'calligraphy', label: 'Calligraphy', icon: 'feather',      lib: 'mci' },
            { key: 'brush',       label: 'Brush',       icon: 'brush',        lib: 'mci' } ],
  pencil: [ { key: 'pencil', label: 'Pencil', icon: 'pencil-outline', lib: 'mci' } ],
  marker: [ { key: 'flat',  label: 'Flat tip',  icon: 'marker',        lib: 'mci' },
            { key: 'round', label: 'Round tip', icon: 'brush-variant', lib: 'mci' } ],
  tape:   [ { key: 'tape', label: 'Tape', icon: 'format-color-highlight', lib: 'mci' } ],
  select: [ { key: 'rect',  label: 'Rectangle', icon: 'select-drag', lib: 'mci' },
            { key: 'lasso', label: 'Lasso',     icon: 'lasso',       lib: 'mci' } ],
  laser:  [ { key: 'line', label: 'Line laser', icon: 'ray-start-arrow', lib: 'mci' },
            { key: 'spot', label: 'Spot laser', icon: 'circle-slice-8',  lib: 'mci' } ],
  eraser: [ { key: 'stroke', label: 'Stroke erase', icon: 'eraser',        lib: 'mci' },
            { key: 'area',   label: 'Area erase',   icon: 'eraser-variant', lib: 'mci' } ],
};

// Convert a (family, variant) pair to the concrete internal drawing tool the
// stroke pipeline knows about. Select and Laser both currently map to 'pen' since
// their drawing behavior is stubbed — the family+variant is still stored so the UI
// reflects the choice.
function familyVariantToTool(f: ToolFamily, v: string): Tool {
  if (f === 'pen') {
    if (v === 'fountain' || v === 'fineliner' || v === 'calligraphy' || v === 'brush') return v;
    return 'pen';
  }
  if (f === 'pencil') return 'pencil';
  if (f === 'marker') return 'marker';
  if (f === 'tape')   return 'highlighter';
  if (f === 'eraser') return 'eraser';
  // select / laser — stubbed; use 'pen' internally (draws nothing until wired).
  return 'pen';
}

// ---------- Helpers ----------
// Ink geometry lives in src/ink. See src/ink/stroke.ts for why strokes are
// filled outlines rather than stroked polylines.

/** World-space distance below which a new sample carries no new information. */
const MIN_SAMPLE_DISTANCE = 0.25;



/**
 * Normalised stylus pressure, when the digitiser reports it.
 *
 * react-native-gesture-handler exposes `stylusData` on pan gestures (2.16+, and
 * this project is on 2.28). The app already detected *that* a stylus was in use
 * for palm rejection but never read the pressure, which is why every tool drew
 * at a constant width and the handwriting read as marker rather than pen.
 */
function stylusPressure(e: unknown): number | undefined {
  const stylus = (e as { stylusData?: { pressure?: number } })?.stylusData;
  const raw = stylus?.pressure;
  if (typeof raw !== 'number' || Number.isNaN(raw)) return undefined;
  // Android reports 0..1 but can exceed 1 on some digitisers.
  return Math.max(0, Math.min(1, raw));
}

function buildPathFromPoints(points: { x: number; y: number }[]): SkPath {
  const p = Skia.Path.Make();
  if (points.length === 0) return p;
  p.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    p.quadTo(a.x, a.y, mx, my);
  }
  const last = points[points.length - 1];
  p.lineTo(last.x, last.y);
  return p;
}

function buildShapePath(s: ShapeData): SkPath {
  const p = Skia.Path.Make();
  const { start, end, tool } = s;
  if (tool === 'line') {
    p.moveTo(start.x, start.y);
    p.lineTo(end.x, end.y);
  } else if (tool === 'rect') {
    const x = Math.min(start.x, end.x);
    const y = Math.min(start.y, end.y);
    const w = Math.abs(end.x - start.x);
    const h = Math.abs(end.y - start.y);
    p.addRRect({ rect: { x, y, width: w, height: h }, rx: 6, ry: 6 });
  } else if (tool === 'ellipse') {
    const x = Math.min(start.x, end.x);
    const y = Math.min(start.y, end.y);
    const w = Math.abs(end.x - start.x);
    const h = Math.abs(end.y - start.y);
    p.addOval({ x, y, width: w, height: h });
  }
  return p;
}

// Distance from point to a segment (for eraser hit testing)
function distPtSeg(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy || 1;
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = a.x + t * dx;
  const cy = a.y + t * dy;
  return Math.hypot(p.x - cx, p.y - cy);
}

// ---------- Main component ----------
export default function DrawScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { colors, isDark } = useTheme();
  const insets = useSafeAreaInsets();
  const { width: winWidth, height: winHeight } = useWindowDimensions();

  const [note, setNote] = useState<Note | null>(null);
  const [loading, setLoading] = useState(true);

  // Doc & history
  const [items, setItems] = useState<Item[]>([]);
  const [paper, setPaper] = useState<Paper>('blank');
  const [paperSize, setPaperSize] = useState<PaperSize>('a4');
  const [customSize, setCustomSize] = useState<{ w: number; h: number } | null>(null);
  // Imported PDF pages, one per page (index into the note's images), or null.
  const [pageBackgrounds, setPageBackgrounds] = useState<(number | null)[]>([]);
  // Per page: a paper template that overrides the note's (null = same as note),
  // and whether the page is bookmarked.
  const [pageTemplates, setPageTemplates] = useState<(Paper | null)[]>([]);
  const [pageBookmarks, setPageBookmarks] = useState<boolean[]>([]);
  /** Apply the same reshaping (delete / move / insert a page) to every per-page list. */
  const remapPageMeta = (fn: <T>(arr: T[], blank: T) => T[]) => {
    setPageBackgrounds((a) => fn(a, null));
    setPageTemplates((a) => fn(a, null));
    setPageBookmarks((a) => fn(a, false));
  };
  const [orientation, setOrientation] = useState<'portrait' | 'landscape'>('portrait');
  const [paperColorId, setPaperColorId] = useState<string>('white');
  const [lineSpacing, setLineSpacing] = useState<number | undefined>(undefined);
  // Starts from the app-wide default. A note that already has its own canvas
  // colour saved overrides this on load (see `doc.canvasColor` below), so
  // changing the global default never rewrites existing notes.
  const [canvasColorHex, setCanvasColorHex] = useState<string>('#d4d4d4');
  // Viewport = the actual on-screen container size. pageDims = the effective page size,
  // derived from paperSize / orientation / customSize (fitting into viewport width).
  const [viewport, setViewport] = useState<{ w: number; h: number }>({ w: 1024, h: 1366 });
  const pageDims = useMemo<{ w: number; h: number }>(() => {
    if (viewport.w <= 0 || viewport.h <= 0) return { w: 1024, h: 1366 };
    // ratio = width / height in the current orientation
    let ratio: number;
    if (paperSize === 'custom' && customSize) {
      ratio = customSize.w / Math.max(1, customSize.h);
    } else if (paperSize !== 'custom') {
      const portraitRatio = PAPER_SIZES[paperSize].ratio;
      ratio = orientation === 'landscape' ? 1 / portraitRatio : portraitRatio;
    } else {
      // custom size not set yet — fall back to A4 portrait
      const portraitRatio = PAPER_SIZES.a4.ratio;
      ratio = orientation === 'landscape' ? 1 / portraitRatio : portraitRatio;
    }
    // "Contain" fit: choose the largest w,h that fit inside the viewport while preserving
    // ratio (w/h). This makes A4/Letter look like a real document floating in the canvas
    // rather than being stretched to fill the viewport width.
    const margin = 0.96; // small breathing room
    const vRatio = viewport.w / Math.max(1, viewport.h);
    let w: number;
    let h: number;
    if (vRatio > ratio) {
      // Viewport is wider than the paper — constrain by height.
      h = viewport.h * margin;
      w = h * ratio;
    } else {
      // Viewport narrower than or equal to the paper — constrain by width.
      w = viewport.w * margin;
      h = w / ratio;
    }
    return { w, h };
  }, [viewport.w, viewport.h, paperSize, customSize, orientation]);
  const historyRef = useRef<{ undo: Item[][]; redo: Item[][] }>({ undo: [], redo: [] });

  // ---------- Ruler (declared here so pan gesture below can reference the refs) ----------
  const [rulerEnabled, setRulerEnabled] = useState(false);
  const [showRulerAngleInput, setShowRulerAngleInput] = useState(false);
  const [rulerAngleDraft, setRulerAngleDraft] = useState('0');
  const [showRulerMenu, setShowRulerMenu] = useState(false);
  const [rulerState, setRulerState] = useState<RulerState>({
    x: 300, y: 300, angle: 0, unit: 'cm', scaleWithPaper: true, lengthPx: 340,
  });
  const snapToRulerRef = useRef<boolean>(false);
  // Which edge the current stroke is locked to (+1 = bottom, -1 = top). Captured
  // at the first snap so a hand tremor across the ruler centre doesn't flip the line.
  const snapEdgeRef = useRef<1 | -1>(1);
  const rulerSnapWorld = (screenX: number, screenY: number) => {
    if (!rulerEnabled) return null;
    const d = rulerEdgeDistance(rulerState, scale, { x: screenX, y: screenY }, viewport);
    // Snap if the pen begins within ~40px of the nearest ruler edge. The 40px band
    // covers ~1 cm of finger/pen slop and matches how a real ruler feels: place the
    // pen roughly at the edge and your line locks to that edge.
    if (d > 40) return null;
    snapEdgeRef.current = rulerEdgeSign(rulerState, { x: screenX, y: screenY });
    return rulerProject(rulerState, scale, { x: screenX, y: screenY }, viewport, snapEdgeRef.current);
  };

  // ---------- Laser + Select state ----------
  // Laser strokes fade out over ~2s.
  const [laserStrokes, setLaserStrokes] = useState<{ id: number; pts: Pt[]; t0: number }[]>([]);
  const laserIdRef = useRef(0);
  const [laserSpot, setLaserSpot] = useState<{ x: number; y: number } | null>(null);
  // Selection: indices of items currently selected + active marquee/lasso path.
  const [selectedIdx, setSelectedIdx] = useState<number[]>([]);
  // Live move / resize / rotate of the selection. While dragging, the selected
  // items are only drawn through this matrix; it is applied to their points
  // once, on release.
  const [selXform, setSelXform] = useState<Mat | null>(null);
  const selXformRef = useRef<Mat | null>(null);
  const selDragRef = useRef<
    | null
    | { kind: 'move' | 'scale' | 'rotate'; start: { x: number; y: number }; anchor: { x: number; y: number } }
  >(null);
  const [clipCount, setClipCount] = useState(inkClipboard.length);
  // Zoom pad: a magnified strip at the bottom for writing small text neatly.
  // (x, y) is the top-left of the window it shows, in world units; w its width.
  const [zoomPad, setZoomPad] = useState<null | { x: number; y: number; w: number }>(null);
  const [padCommittedId, setPadCommittedId] = useState(0);
  const padOpenRef = useRef(false);
  padOpenRef.current = !!zoomPad;
  // Text tool: tap the page to add a text box, tap one to edit it.
  const [textMode, setTextMode] = useState(false);
  const [textEdit, setTextEdit] = useState<
    null | { index: number | null; x: number; y: number; w: number; fontSize: number; color: string; text: string; angle: number }
  >(null);
  const [marquee, setMarquee] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const [lassoPath, setLassoPath] = useState<Pt[] | null>(null);

  // Laser fade tick — periodically expire strokes older than 2s.
  useEffect(() => {
    if (laserStrokes.length === 0) return;
    const t = setInterval(() => {
      setLaserStrokes((prev) => prev.filter((s) => Date.now() - s.t0 < 2200));
    }, 400);
    return () => clearInterval(t);
  }, [laserStrokes.length]);

  // Tool state
  const [tool, setTool] = useState<Tool>('pen');
  const [color, setColor] = useState<string>('#1A1A1C');

  // Family / variant state — drives the toolbar UI and resolves to `tool`.
  const [family, setFamily] = useState<ToolFamily>('pen');
  const [variantByFamily, setVariantByFamily] = useState<Record<ToolFamily, string>>({
    pen: 'fountain', pencil: 'pencil', marker: 'round', tape: 'tape',
    select: 'rect', laser: 'line', eraser: 'stroke',
  });

  // User-customizable quick colors on the toolbar. Six slots; tap opens the grid
  // picker to reassign that slot's color (the newly picked color also becomes the
  // currently-active drawing color).
  const [quickColors, setQuickColors] = useState<string[]>(DEFAULT_QUICK_COLORS);
  const [recentColors, setRecentColors] = useState<string[]>([]); // last picks — most recent first, max 8
  const [favoriteColors, setFavoriteColors] = useState<string[]>([]); // user-pinned colors, max 12
  const [pickerFor, setPickerFor] = useState<{ slot: number | null } | null>(null);
  const [pickerAnchor, setPickerAnchor] = useState<{ x: number; y: number } | null>(null); // anchor for the grid picker Modal
  useEffect(() => {
    AsyncStorage.getItem(StorageKeys.quickColors).then((raw) => {
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed) && parsed.length >= 4) {
            // Pad up to 6 if the user has old 4-slot data saved.
            const padded = [...parsed];
            while (padded.length < 6) padded.push(DEFAULT_QUICK_COLORS[padded.length] || '#000000');
            setQuickColors(padded.slice(0, 6));
          }
        } catch {}
      }
    });
    AsyncStorage.getItem(StorageKeys.recentColors).then((raw) => {
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) setRecentColors(parsed.slice(0, 8));
        } catch {}
      }
    });
    AsyncStorage.getItem(StorageKeys.favoriteColors).then((raw) => {
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) setFavoriteColors(parsed.slice(0, 12));
        } catch {}
      }
    });
  }, []);
  const setQuickColorSlot = useCallback((slot: number, hex: string) => {
    setQuickColors((prev) => {
      const next = prev.slice();
      next[slot] = hex;
      AsyncStorage.setItem(StorageKeys.quickColors, JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, []);
  const pushRecentColor = useCallback((hex: string) => {
    setRecentColors((prev) => {
      const filtered = prev.filter((c) => c.toLowerCase() !== hex.toLowerCase());
      const next = [hex, ...filtered].slice(0, 8);
      AsyncStorage.setItem(StorageKeys.recentColors, JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, []);
  const toggleFavoriteColor = useCallback((hex: string) => {
    setFavoriteColors((prev) => {
      const has = prev.some((c) => c.toLowerCase() === hex.toLowerCase());
      const next = has
        ? prev.filter((c) => c.toLowerCase() !== hex.toLowerCase())
        : [hex, ...prev].slice(0, 12);
      AsyncStorage.setItem(StorageKeys.favoriteColors, JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, []);

  const [widths, setWidths] = useState<Record<Tool, number>>(DEFAULT_WIDTHS);
  // Persist per-tool widths across sessions.
  useEffect(() => {
    AsyncStorage.getItem(StorageKeys.toolWidths).then((raw) => {
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') {
            setWidths((prev) => ({ ...prev, ...parsed }));
          }
        } catch {}
      }
    });
  }, []);
  const setToolWidth = useCallback((t: Tool, v: number) => {
    setWidths((prev) => {
      const next = { ...prev, [t]: v };
      AsyncStorage.setItem(StorageKeys.toolWidths, JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, []);
  const [showPaperMenu, setShowPaperMenu] = useState(false);
  const [showSubCanvasColor, setShowSubCanvasColor] = useState(false);
  /**
   * Chrome visibility.
   *   'normal'     — header + tabs + toolbar
   *   'immersive'  — toolbar only; header and tab strip hidden
   *   'zen'        — nothing but the page
   * Zen leaves a single small restore button, or the app becomes a trap.
   */
  const [chrome, setChrome] = useState<'normal' | 'immersive' | 'zen'>('normal');
  /** Toolbar visibility, toggled independently of the fullscreen level. */
  const [toolbarHidden, setToolbarHidden] = useState(false);
  const hideHeader = chrome !== 'normal';
  const hideToolbar = chrome === 'zen' || toolbarHidden;
  // Sub-menus opened from the main kebab menu
  const [showSubColor, setShowSubColor] = useState(false);
  const [showSubTemplate, setShowSubTemplate] = useState(false);
  const [showSubSize, setShowSubSize] = useState(false);
  const [showSubSpacing, setShowSubSpacing] = useState(false);
  const [showSubToolbar, setShowSubToolbar] = useState(false);
  const [showToolPalette, setShowToolPalette] = useState(false);
  const [showToolOpts, setShowToolOpts] = useState(false);
  const [toolOptAnchor, setToolOptAnchor] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [expandedColors, setExpandedColors] = useState(false); // in-popover grid palette toggle
  const [showTitleEdit, setShowTitleEdit] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [titleAnchor, setTitleAnchor] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

  // Labels state (loaded once when the screen mounts; refreshed when the picker
  // opens so any labels created elsewhere show up here too).
  const [labels, setLabels] = useState<Label[]>([]);
  const [showLabelPicker, setShowLabelPicker] = useState(false);
  const [labelDraftName, setLabelDraftName] = useState('');
  // Folder picker — mirrors the text-editor's "Move to folder" so users can
  // relocate a handwritten note without leaving the canvas.
  const [folders, setFolders] = useState<Folder[]>([]);
  const [showFolderPicker, setShowFolderPicker] = useState(false);

  // Zoom (panning removed) — translation is derived to keep canvas centered while zooming.
  const [scale, setScale] = useState(1);
  const [scrollY, setScrollY] = useState(0); // vertical scroll across multi-page canvas
  const [scrollX, setScrollX] = useState(0); // horizontal pan (world coords, only valid when page overflows viewport)
  const [overscrollY, setOverscrollY] = useState(0); // damped bounce past last page (pull-to-add-page)
  const scrollYStartRef = useRef(0);
  const scrollXStartRef = useRef(0);
  const overscrollRef = useRef(0);
  const scaleStartRef = useRef(1);
  const MAX_SCALE = 16;
  const MIN_SCALE = 0.5;

  // Multi-page support
  const [pageCount, setPageCount] = useState(1);

  // Visible gap between adjacent pages (world coords). Strokes are stored with their
  // gap-inclusive world Y so a stroke on page N has y ≥ N * (basePageH + PAGE_GAP).
  // Existing notes (v1 no-gap, v2 gap=32) are migrated at load — see loader below.
  const PAGE_GAP = 11;
  const basePageH = pageDims.h;
  const pageStrideY = basePageH + PAGE_GAP;
  const totalPageH = pageStrideY * pageCount - PAGE_GAP;
  // Horizontal: center the page when it fits in the viewport; when zoomed in such that the
  // page overflows the viewport, allow the user to pan sideways within bounds so neither
  // side edge is dragged out of view.
  const pageOnScreenW = pageDims.w * scale;
  const canPanX = pageOnScreenW > viewport.w + 0.5;
  // Natural (centered) horizontal translation. Works for both cases:
  //  - When page fits: positive value, adds side margins.
  //  - When page overflows: negative value, means the page's left edge is off-screen and
  //    the page is centered with equal overflow on both sides.
  const naturalTx = (viewport.w - pageOnScreenW) / 2;
  // maxAbsSX: how far (in world coords) the user can shift from centered before an edge leaves viewport.
  const maxAbsSX = canPanX ? (pageOnScreenW - viewport.w) / (2 * scale) : 0;
  const clampedScrollX = Math.max(-maxAbsSX, Math.min(maxAbsSX, scrollX));
  const tx = naturalTx - clampedScrollX * scale;
  const topPad = spacing.md; // small breathing room above the page
  // Add overscroll pull-past-end so the paper visibly bounces up during a scroll-past-last-page.
  const ty = topPad - scrollY * scale - overscrollY;

  // App settings (haptics + gestures + toolbar)
  const { settings, update } = useAppSettings();
  const toolbarPos: ToolbarPosition = settings.toolbarPosition || 'left';
  /** Width of the vertical toolbar. Popovers offset by this so they never sit on top of it. */
  const VERTICAL_TOOLBAR_W = 60;
  const isVerticalToolbar = toolbarPos === 'left' || toolbarPos === 'right';

  /**
   * Popover placement on wide screens.
   *
   * Full-width bottom sheets are a phone idiom. On a tablet they stretch a
   * short list of folders across 1200pt and put it at the opposite end of the
   * screen from the three-dots button that opened it. Above `WIDE_MIN` these
   * become panels hanging under that button instead, offset clear of a
   * right-docked toolbar.
   */
  const WIDE_MIN = 700;
  const isWideScreen = winWidth >= WIDE_MIN;
  const sidePanelStyle = (maxH: DimensionValue = '70%'): ViewStyle =>
    isWideScreen
      ? {
          position: 'absolute' as const,
          top: insets.top + 48,
          right: (toolbarPos === 'right' ? 60 : 0) + 8,
          width: 320,
          maxHeight: maxH,
          borderRadius: radius.lg,
          padding: spacing.lg,
          backgroundColor: colors.surface,
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 10 },
          shadowOpacity: 0.28,
          shadowRadius: 24,
          elevation: 16,
        }
      : {
          position: 'absolute' as const,
          left: 0,
          right: 0,
          bottom: 0,
          padding: spacing.lg,
          paddingBottom: insets.bottom + spacing.lg,
          borderTopLeftRadius: radius.lg,
          borderTopRightRadius: radius.lg,
          backgroundColor: colors.surface,
          maxHeight: maxH,
        };
  const { openTab, renameTab } = useOpenTabs();

  // Ref mirrors of settings so gesture handlers always read the latest value
  // (avoids stale closures that made palm rejection unreliable).
  const palmRejectionRef = useRef(settings.palmRejection);
  palmRejectionRef.current = settings.palmRejection;
  const autoAddPageRef = useRef(settings.autoAddPage);
  autoAddPageRef.current = settings.autoAddPage;
  // Worklet-readable mirror so the synchronous onTouchesDown callback (running on the UI
  // thread) can reject finger touches BEFORE the Pan activates on the native side.
  const palmRejectionSV = useSharedValue(settings.palmRejection ? 1 : 0);
  useEffect(() => {
    palmRejectionSV.value = settings.palmRejection ? 1 : 0;
  }, [settings.palmRejection, palmRejectionSV]);

  // Active drawing state (refs to avoid re-renders per touch)
  const livePtsRef = useRef<InkPoint[]>([]);
  const inkFilterRef = useRef(new OneEuro2D());
  // Native wet ink (Android). When active it owns stylus pen strokes; the JS
  // pan below stands aside for them. Fingers, other tools and the ruler still
  // go through JS.
  const [nativeCommittedId, setNativeCommittedId] = useState(0);
  const nativeModeRef = useRef<'ink' | 'erase' | 'lasso' | 'rect' | 'none'>('none');
  /** The current JS pan gesture is being handled natively; ignore it. */
  const jsSkipRef = useRef(false);
  const lastRawRef = useRef<InkPoint | null>(null);
  // Imperative handle to the wet-ink layer; see src/ink/LiveStrokeLayer.tsx.
  const liveStrokeRef = useRef<LiveStrokeHandle | null>(null);
  const liveShapeRef = useRef<{ start: Pt; end: Pt } | null>(null);
  const [liveTick, setLiveTick] = useState(0);

  // Save debounce
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ----- Load -----
  useEffect(() => {
    let cancelled = false;
    idRef.current = id as string;
    dirtyRef.current = false;
    loadedShapeRef.current = null;
    setSaveStatus('idle');
    setLoading(true);
    setNote(null);
    setItems([]);
    historyRef.current = { undo: [], redo: [] };
    // Reset every per-note setting to its default BEFORE applying the loaded
    // document. Switching tabs between two handwritten notes reuses this
    // screen, so anything the next note doesn't specify used to carry over from
    // the previous one: page count, line spacing, orientation, canvas colour.
    setPaper('blank');
    setPageBackgrounds([]);
    setPageTemplates([]);
    setPageBookmarks([]);
    setPaperSize('a4');
    setCustomSize(null);
    setOrientation('portrait');
    setPaperColorId('white');
    setLineSpacing(undefined);
    setPageCount(1);
    setCanvasColorHex(settings.defaultCanvasColor || '#d4d4d4');
    (async () => {
      try {
        const [n, ls, fs] = await Promise.all([
          NotesApi.get(id as string),
          LabelsApi.list().catch(() => [] as Label[]),
          FoldersApi.list().catch(() => [] as Folder[]),
        ]);
        if (cancelled) return;
        setNote(n);
        imagesRef.current = Array.isArray(n.images) ? n.images : [];
        decodedRef.current.clear();
        setLabels(ls);
        setFolders(fs);
        openTab({ id: n.id, title: displayTitle(n), type: 'handwriting' });
        if (n.drawing_data) {
          try {
            const doc: DrawingDoc = JSON.parse(n.drawing_data);
            // Migrate legacy world-Y coordinates:
            //   v1 (or missing): contiguous coords, no gap. Add PAGE_GAP × pageIdx.
            //   v2: gap-inclusive coords with an OLD gap of 32. Rescale to the new gap.
            //   v3+: leave as-is.
            let loadedItems: Item[] = doc.items || [];
            const legacyBaseH = pageDims.h || 800;
            const OLD_GAP_V2 = 32;
            const currentVersion = doc.docVersion ?? 1;
            if (currentVersion < 2) {
              // v1 → v3: strokes stored without gaps. Add PAGE_GAP per completed page.
              loadedItems = loadedItems.map((it) => {
                if (it.kind === 'stroke') {
                  return {
                    ...it,
                    points: it.points.map((p) => ({
                      ...p,
                      y: p.y + PAGE_GAP * Math.floor(p.y / Math.max(1, legacyBaseH)),
                    })),
                  } as Item;
                }
                if (it.kind !== 'shape') return it;
                const sIdx = Math.floor(it.start.y / Math.max(1, legacyBaseH));
                const eIdx = Math.floor(it.end.y / Math.max(1, legacyBaseH));
                return {
                  ...it,
                  start: { x: it.start.x, y: it.start.y + PAGE_GAP * sIdx },
                  end: { x: it.end.x, y: it.end.y + PAGE_GAP * eIdx },
                } as Item;
              });
            } else if (currentVersion === 2) {
              // v2 → v3: rescale from OLD_GAP_V2 to the current PAGE_GAP.
              const oldStride = legacyBaseH + OLD_GAP_V2;
              const newStride = legacyBaseH + PAGE_GAP;
              const remap = (y: number) => {
                const pageIdx = Math.floor(y / Math.max(1, oldStride));
                const localY = y - pageIdx * oldStride;
                return pageIdx * newStride + Math.min(localY, legacyBaseH);
              };
              loadedItems = loadedItems.map((it) => {
                if (it.kind === 'stroke') {
                  return { ...it, points: it.points.map((p) => ({ ...p, y: remap(p.y) })) } as Item;
                }
                if (it.kind !== 'shape') return it;
                return {
                  ...it,
                  start: { x: it.start.x, y: remap(it.start.y) },
                  end: { x: it.end.x, y: remap(it.end.y) },
                } as Item;
              });
            }
            setItems(loadedItems);
            setPaper(doc.paper || 'blank');
            if (doc.paperSize) {
              // Legacy notes may have paperSize === 'fit' — coerce to A4.
              // Legacy docs really do hold 'fit' on disk even though the current
              // PaperSize union has no such member, so compare as a raw string.
              const raw = doc.paperSize as string;
              const s = (raw === 'fit' ? 'a4' : raw) as PaperSize;
              setPaperSize(s);
            }
            if (doc.customSize) setCustomSize(doc.customSize);
            setPageBackgrounds(Array.isArray(doc.pageBackgrounds) ? doc.pageBackgrounds : []);
            setPageTemplates(Array.isArray(doc.pageTemplates) ? (doc.pageTemplates as (Paper | null)[]) : []);
            setPageBookmarks(Array.isArray(doc.pageBookmarks) ? doc.pageBookmarks : []);
            if (doc.orientation) setOrientation(doc.orientation);
            if (doc.paperColor) setPaperColorId(doc.paperColor);
            // Per-note colour wins; otherwise fall back to the app default.
            setCanvasColorHex(doc.canvasColor || settings.defaultCanvasColor || '#d4d4d4');
            if (typeof doc.lineSpacing === 'number') setLineSpacing(doc.lineSpacing);
            if (typeof doc.pageCount === 'number') setPageCount(Math.max(1, doc.pageCount));
          } catch {}
        }
      } catch (e) {
        console.warn(e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      // Leaving this note (tab switch reuses the screen): write anything
      // pending to THIS note before the next one's state replaces it.
      void flushSave(id as string);
    };
  }, [id]);

  // ----- Persist (debounced) -----
  // A rename made from the tab strip updates this open screen's title too.
  useEffect(
    () => onNoteRenamed((nid, title) => {
      setNote((prev) => (prev && prev.id === nid ? { ...prev, title } : prev));
    }),
    []
  );

  // ----- Saving -----
  //
  // The document to save is read from `docRef` at WRITE time, not captured when
  // a change is made. The previous version took values as arguments and read
  // the rest (line spacing, canvas colour, page count) from its closure, which
  // still held the values from before the change — so line spacing and canvas
  // colour edits were written with their OLD values and appeared to revert.
  //
  // Writes are debounced, serialised, flushed when the app backgrounds, when
  // the screen unmounts and before switching to another note, and a failure is
  // reported as an error rather than showing "Saved".
  const docRef = useRef<{
    items: Item[];
    paper: Paper;
    paperSize: PaperSize;
    customSize: { w: number; h: number } | null;
    pageBackgrounds: (number | null)[];
    pageTemplates: (Paper | null)[];
    pageBookmarks: boolean[];
    orientation: 'portrait' | 'landscape';
    paperColorId: string;
    canvasColorHex: string;
    lineSpacing: number | undefined;
    pageCount: number;
  } | null>(null);
  docRef.current = {
    items,
    paper,
    paperSize,
    customSize,
    pageBackgrounds,
    pageTemplates,
    pageBookmarks,
    orientation,
    paperColorId,
    canvasColorHex,
    lineSpacing,
    pageCount,
  };
  const idRef = useRef(id as string);
  const dirtyRef = useRef(false);
  const pendingTitleRef = useRef<string | undefined>(undefined);
  const writeChainRef = useRef<Promise<void>>(Promise.resolve());
  const mountedRef = useRef(true);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');

  /** Write the current document for `noteId` now, if anything changed. */
  const flushSave = useCallback((noteId: string = idRef.current) => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    if (!dirtyRef.current || !docRef.current) return writeChainRef.current;
    dirtyRef.current = false;
    // Snapshot NOW, so a later note switch can't change what this write sends.
    const d = docRef.current;
    const title = pendingTitleRef.current;
    pendingTitleRef.current = undefined;
    const body: Partial<Note> = {
      // A small, bounded render for the notes list, so the list never has to
      // load the full document. See src/ink/preview.ts.
      preview: buildPreview(d.items as any[], pageDims.w, basePageH, d.paper),
      drawing_data: JSON.stringify({
        paper: d.paper,
        paperSize: d.paperSize,
        customSize: d.customSize ?? undefined,
        orientation: d.orientation,
        paperColor: d.paperColorId,
        canvasColor: d.canvasColorHex,
        lineSpacing: d.lineSpacing,
        pageCount: d.pageCount,
        pageBackgrounds: d.pageBackgrounds.length ? d.pageBackgrounds : undefined,
        pageTemplates: d.pageTemplates.some((t) => t) ? d.pageTemplates : undefined,
        pageBookmarks: d.pageBookmarks.some((b) => b) ? d.pageBookmarks : undefined,
        docVersion: 3,
        items: d.items,
      } as DrawingDoc),
      note_type: 'handwriting',
    };
    if (typeof title === 'string') body.title = title;

    // Serialise: each write waits for the previous one, so two saves can never
    // land out of order.
    writeChainRef.current = writeChainRef.current.then(async () => {
      if (mountedRef.current) setSaveStatus('saving');
      try {
        await NotesApi.update(noteId, body);
        if (mountedRef.current) setSaveStatus(dirtyRef.current ? 'pending' : 'saved');
      } catch (e) {
        console.warn('save', e);
        // Keep the change: mark dirty again so the next flush retries it.
        dirtyRef.current = true;
        if (typeof title === 'string' && pendingTitleRef.current === undefined) {
          pendingTitleRef.current = title;
        }
        if (mountedRef.current) {
          setSaveStatus('error');
          // One automatic retry. A transient failure (the database busy with
          // another write) should recover on its own; a persistent one stays
          // visible as "Not saved", tappable to retry.
          if (!saveTimer.current) {
            saveTimer.current = setTimeout(() => {
              saveTimer.current = null;
              void flushSave(noteId);
            }, 3000);
          }
        }
      }
    });
    return writeChainRef.current;
  }, [pageDims.w, basePageH]);

  /**
   * Mark the document changed and schedule a write.
   *
   * The arguments are kept so the many existing call sites didn't need to
   * change, but only `nextTitle` is used: everything else is read from
   * `docRef` when the write happens.
   */
  const persist = useCallback(
    (
      _items?: Item[],
      _paper?: Paper,
      _size?: PaperSize,
      _color?: string,
      nextTitle?: string,
      _reserved?: undefined,
      _canvas?: string
    ) => {
      dirtyRef.current = true;
      if (typeof nextTitle === 'string') pendingTitleRef.current = nextTitle;
      if (mountedRef.current) setSaveStatus('pending');
      if (saveTimer.current) clearTimeout(saveTimer.current);
      // 600ms after the last change. State set just before persist() has
      // rendered into docRef long before this fires.
      saveTimer.current = setTimeout(() => { void flushSave(); }, 600);
    },
    [flushSave]
  );

  // Flush when the app goes to the background: that's when Android may kill
  // the process, and anything still in the debounce window would be lost.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'background' || next === 'inactive') void flushSave();
    });
    return () => sub.remove();
  }, [flushSave]);

  // Flush on unmount (back button, closing the tab).
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      void flushSave();
    };
  }, [flushSave]);

  // Save when page count or orientation actually change.
  //
  // Compared against the values the note was loaded with: without this, the
  // load itself set pageCount, fired this effect, and saved the note — which
  // bumped its "updated" time, so merely OPENING a note moved it to the top of
  // the list.
  const loadedShapeRef = useRef<{ pageCount: number; orientation: string } | null>(null);
  useEffect(() => {
    if (loading || !note) return;
    const base = loadedShapeRef.current;
    if (base && base.pageCount === pageCount && base.orientation === orientation) return;
    loadedShapeRef.current = { pageCount, orientation };
    if (base) persist();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageCount, orientation, loading]);

  // Selection bounds. Declared up here, before the gestures are built: their
  // callbacks capture identifiers when constructed, and a const declared
  // further down would still be in its temporal dead zone then.
  const effW = (t: string, w: number) => effectiveWidth(t as InkTool, w);
  const selBounds: SelRect | null = useMemo(
    () => unionBounds(selectedIdx.map((i) => items[i]).filter(Boolean).map((it) => itemBounds(it, effW))),
    [selectedIdx, items]
  );

  const pushHistory = useCallback((prev: Item[]) => {
    historyRef.current.undo.push(prev);
    historyRef.current.redo = [];
    if (historyRef.current.undo.length > 50) historyRef.current.undo.shift();
  }, []);

  const undo = () => {
    const h = historyRef.current;
    if (!h.undo.length) return;
    const last = h.undo.pop()!;
    h.redo.push(items);
    setItems(last);
    persist(last, paper, paperSize, paperColorId);
  };
  const redo = () => {
    const h = historyRef.current;
    if (!h.redo.length) return;
    const next = h.redo.pop()!;
    h.undo.push(items);
    setItems(next);
    persist(next, paper, paperSize, paperColorId);
  };
  const clearAll = () => {
    pushHistory(items);
    setItems([]);
    persist([], paper, paperSize, paperColorId);
  };

  // ----- Gesture handlers -----
  const isShapeTool = (t: Tool): t is ShapeTool => t === 'line' || t === 'rect' || t === 'ellipse';
  const isPenTool = (t: Tool): t is PenTool =>
    t === 'pen' || t === 'fountain' || t === 'marker' || t === 'highlighter' || t === 'pencil' ||
    t === 'fineliner' || t === 'calligraphy' || t === 'brush';

  const finalizeStroke = (pts: InkPoint[], shape?: string) => {
    if (pts.length < 2 || !isPenTool(tool)) return;
    const w = widths[tool];
    // Every sample is kept: see storePoints. Simplifying here made the stroke
    // re-shape itself just after the pen lifted.
    const points = storePoints(pts);
    const stroke: StrokeData = {
      kind: 'stroke',
      tool,
      color,
      width: w,
      points,
      ...(shape ? { shape } : {}),
    };
    setItems((prev) => {
      pushHistory(prev);
      const next = [...prev, stroke];
      persist(next, paper, paperSize, paperColorId);
      return next;
    });
  };

  const finalizeShape = (start: Pt, end: Pt) => {
    if (!isShapeTool(tool)) return;
    const w = widths[tool];
    const shape: ShapeData = {
      kind: 'shape',
      tool,
      color,
      width: w,
      start: { x: start.x, y: start.y },
      end: { x: end.x, y: end.y },
    };
    setItems((prev) => {
      pushHistory(prev);
      const next = [...prev, shape];
      persist(next, paper, paperSize, paperColorId);
      return next;
    });
  };

  // Eraser mode: 'stroke' removes the whole stroke on contact; 'partial' cuts out just
  // the portion under the eraser (leaves the rest of the stroke behind).
  const [eraserMode, setEraserMode] = useState<'stroke' | 'partial'>('stroke');
  useEffect(() => {
    AsyncStorage.getItem(StorageKeys.eraserMode).then((v) => {
      if (v === 'stroke' || v === 'partial') setEraserMode(v);
    });
  }, []);
  const setEraserModePersist = useCallback((m: 'stroke' | 'partial') => {
    setEraserMode(m);
    AsyncStorage.setItem(StorageKeys.eraserMode, m).catch(() => {});
  }, []);

  /**
   * Remove (or cut) whatever the eraser disc at (x, y) touches. Pure: returns
   * the new list, or the same list when nothing was hit.
   */
  const eraseOnce = (items: Item[], x: number, y: number): Item[] => {
    const radius = widths.eraser / 2;
    let changed = false;
      const nextItems: Item[] = [];
      for (const it of items) {
        if (it.kind === 'stroke') {
          if (eraserMode === 'stroke') {
            // Whole-stroke erase: remove if ANY segment intersects the eraser disc.
            let hit = false;
            for (let i = 1; i < it.points.length; i++) {
              if (distPtSeg({ x, y }, it.points[i - 1], it.points[i]) <= radius + it.width / 2) {
                hit = true;
                break;
              }
            }
            if (hit) { changed = true; continue; }
            nextItems.push(it);
          } else {
            // Partial erase: keep only the points that are OUTSIDE the eraser disc, and
            // split the stroke into sub-strokes wherever the pointer cut through it.
            const r = radius + it.width / 2;
            const segments: InkPoint[][] = [];
            let cur: InkPoint[] = [];
            for (const p of it.points) {
              const inside = Math.hypot(p.x - x, p.y - y) <= r;
              if (inside) {
                if (cur.length >= 2) segments.push(cur);
                cur = [];
              } else {
                cur.push(p);
              }
            }
            if (cur.length >= 2) segments.push(cur);
            if (segments.length === 1 && segments[0].length === it.points.length) {
              // Nothing removed for this stroke.
              nextItems.push(it);
            } else {
              changed = true;
              // Emit one stroke per surviving segment.
              for (const seg of segments) {
                nextItems.push({ ...it, points: seg });
              }
            }
          }
        } else if (it.kind === 'shape') {
          // Shapes: only "stroke" (whole-shape) erase applies.
          const a = it.start;
          const b = it.end;
          const candidates = [
            a,
            b,
            { x: a.x, y: b.y },
            { x: b.x, y: a.y },
            { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
          ];
          let hit = false;
          for (const c of candidates) {
            if (Math.hypot(c.x - x, c.y - y) <= radius + it.width) { hit = true; break; }
          }
          if (hit) { changed = true; continue; }
          nextItems.push(it);
        } else {
          // Images and text boxes aren't erased by the pen eraser (as in
          // other note apps); select them and delete instead.
          nextItems.push(it);
        }
      }
    return changed ? nextItems : items;
  };

  const eraseAt = (x: number, y: number) => {
    setItems((prev) => {
      const next = eraseOnce(prev, x, y);
      if (next !== prev) {
        pushHistory(prev);
        persist(next, paper, paperSize, paperColorId);
      }
      return next;
    });
  };

  /**
   * Erase along a run of points in ONE state update, recording ONE undo step
   * per eraser gesture. Erasing used to update state and push an undo snapshot
   * for every single point, which was slow and, with a 50-step history,
   * quickly pushed real edits out of reach of undo.
   */
  const eraseGestureRef = useRef<{ pushed: boolean }>({ pushed: false });
  const eraseAlong = (pts: { x: number; y: number }[], startOfGesture: boolean) => {
    if (startOfGesture) eraseGestureRef.current = { pushed: false };
    setItems((prev) => {
      let cur = prev;
      for (const p of pts) cur = eraseOnce(cur, p.x, p.y);
      if (cur !== prev) {
        if (!eraseGestureRef.current.pushed) {
          pushHistory(prev);
          eraseGestureRef.current.pushed = true;
        }
        persist(cur, paper, paperSize, paperColorId);
      }
      return cur;
    });
  };

  const runGestureAction = (action: GestureAction) => {
    if (action === 'undo') { haptic.light(); undo(); }
    else if (action === 'redo') { haptic.light(); redo(); }
    else if (action === 'eraser') { haptic.medium(); setTool('eraser'); }
  };

  // Reset horizontal pan to 0 whenever the page no longer overflows the viewport, so a
  // subsequent zoom-in starts from the centered position (not from the previous pan).
  useEffect(() => {
    if (!canPanX && scrollX !== 0) setScrollX(0);
  }, [canPanX, scrollX]);

  // Clamp scrollY whenever scale or pageCount changes so we never leave the doc bounds
  // (e.g. zooming out with a large scrollY should snap back to a valid position).
  useEffect(() => {
    const visibleH = viewport.h / Math.max(0.01, scale);
    const maxScroll = Math.max(0, totalPageH - visibleH);
    if (scrollY > maxScroll) setScrollY(maxScroll);
    else if (scrollY < 0) setScrollY(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scale, pageCount, totalPageH, viewport.h]);

  // Pinch zoom (2 fingers) — and 2-finger vertical pan for scrolling across multi-page canvas.
  const pinch = Gesture.Pinch()
    .runOnJS(true)
    .onStart(() => { scaleStartRef.current = scale; })
    .onUpdate((e) => {
      const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scaleStartRef.current * e.scale));
      setScale(next);
    });

  // Currently-drawing flag (declared early because scroll gestures reference it).
  // Set to true in the drawing pan's onBegin whenever a stylus starts drawing.
  // Default to `true` so on devices that don't report pointerType, the pen still works.
  const isStylusRef = useRef<boolean>(true);
  // Shared value mirror of "is a stylus currently touching the screen". Set on the UI
  // thread from the drawing pan's onTouchesDown worklet so worklets in child components
  // (e.g. the Ruler) can consult it synchronously and refuse to pan when a pen is down.
  const penDownSV = useSharedValue(0);

  // Gesture refs — hoisted here (before the gestures that reference them) so their
  // `.withRef(...)` calls work at construction time. Passed to the Ruler so its
  // pan/rotate can run SIMULTANEOUSLY with the drawing/scroll gestures.
  const drawingPanRef = useRef<any>(null);
  const fingerScrollPanRef = useRef<any>(null);
  const twoFingerPanRef = useRef<any>(null);

  const twoFingerPanY = Gesture.Pan()
    .runOnJS(true)
    .withRef(twoFingerPanRef)
    .minPointers(2)
    .maxPointers(2)
    .averageTouches(true)
    .onTouchesDown((event, manager) => {
      'worklet';
      // Never scroll while a stylus is touching — the pen is drawing.
      // `pointerType` is a property of the touch EVENT, not of the individual
      // entries in `allTouches`. The previous code read `touches[i].pointerType`,
      // which is always `undefined`, so this comparison was permanently false
      // and the guard never fired.
      if (event.pointerType === PointerType.STYLUS) { manager.fail(); return; }
    })
    .onTouchesMove((event, manager) => {
      'worklet';
      // `pointerType` is a property of the touch EVENT, not of the individual
      // entries in `allTouches`. The previous code read `touches[i].pointerType`,
      // which is always `undefined`, so this comparison was permanently false
      // and the guard never fired.
      if (event.pointerType === PointerType.STYLUS) { manager.fail(); return; }
    })
    .onStart(() => {
      scrollYStartRef.current = scrollY;
      scrollXStartRef.current = scrollX;
    })
    .onUpdate((e) => {
      // Runtime guard: pen must never move the paper.
      if (isStylusRef.current) return;
      // Vertical scroll — scrollY can go up to totalPageH minus visible window.
      const visibleH = viewport.h / Math.max(0.01, scale);
      const maxScroll = Math.max(0, totalPageH - visibleH);
      const nextY = Math.max(0, Math.min(maxScroll, scrollYStartRef.current - e.translationY / Math.max(0.5, scale)));
      setScrollY(nextY);

      // Horizontal pan — ONLY when the page overflows viewport (edges are off-screen).
      // Clamped so the paper cannot be dragged out of view.
      const pageOnW = pageDims.w * scale;
      if (pageOnW > viewport.w + 0.5) {
        const maxAbs = (pageOnW - viewport.w) / (2 * scale);
        const nextX = Math.max(-maxAbs, Math.min(maxAbs, scrollXStartRef.current - e.translationX / Math.max(0.5, scale)));
        setScrollX(nextX);
      }
    });

  const twoTap = Gesture.Tap()
    .runOnJS(true)
    .numberOfTaps(1)
    .minPointers(2)
    // A tap is short and still. Without these limits any pinch-zoom shorter
    // than half a second counted as a 2-finger tap and ran its action
    // (undo, by default), so writing vanished when you zoomed.
    .maxDuration(250)
    .maxDistance(12)
    .onEnd((_e, success) => {
      if (success) runGestureAction(settings.gestureTwoFingerTap);
    });

  const threeTap = Gesture.Tap()
    .runOnJS(true)
    .numberOfTaps(1)
    .minPointers(3)
    // A tap is short and still. Without these limits any pinch-zoom shorter
    // than half a second counted as a 3-finger tap and ran its action
    // (undo, by default), so writing vanished when you zoomed.
    .maxDuration(250)
    .maxDistance(12)
    .onEnd((_e, success) => {
      if (success) runGestureAction(settings.gestureThreeFingerTap);
    });

  const composedGesture = Gesture.Simultaneous(pinch, twoFingerPanY);
  const tapsGesture = Gesture.Exclusive(threeTap, twoTap);

  // ----- Overscroll (pull-past-end to auto-add page) -----
  // `overscrollY` is the damped screen-space distance the user has dragged BEYOND the last
  // page. It is added to `ty` so the paper visibly bounces up during the pull. When the
  // user releases past the threshold, a new page is auto-added.
  const OVERSCROLL_ADD_THRESHOLD = 100;   // px pulled past the end (after damping) needed to trigger add (relaxed from 140)
  const OVERSCROLL_MAX = 180;             // absolute cap on damped overscroll
  const OVERSCROLL_DAMP = 0.35;           // moderate resistance (was 0.28 — stiffer)

  // 1-finger finger-drag on the paper → scroll vertically (always), horizontally only
  // when the paper edges are off-screen. Rejects stylus so the drawing gesture takes
  // over for the pen. Also handles overscroll for pull-to-add-page.
  const fingerScrollPan = Gesture.Pan()
    .runOnJS(true)
    .withRef(fingerScrollPanRef)
    .minDistance(2)
    .maxPointers(1)
    .onTouchesDown((event, manager) => {
      'worklet';
      // Only activate finger-scroll when palm rejection is ON (i.e. touch is not used for drawing).
      // When palm rejection is OFF the user has explicitly opted into touch-drawing.
      if (palmRejectionSV.value !== 1) {
        manager.fail();
        return;
      }
      // Fail if ANY stylus is present in the touch batch — the pen is drawing (possibly
      // with a resting palm/finger on the screen too). We must never scroll during drawing.
      // `pointerType` is a property of the touch EVENT, not of the individual
      // entries in `allTouches`. The previous code read `touches[i].pointerType`,
      // which is always `undefined`, so this comparison was permanently false
      // and the guard never fired.
      if (event.pointerType === PointerType.STYLUS) { manager.fail(); return; }
      if (event.pointerType !== PointerType.TOUCH) { manager.fail(); return; }
    })
    .onTouchesMove((event, manager) => {
      'worklet';
      // Recheck as new touches arrive mid-scroll (e.g. pen goes down after a finger).
      // `pointerType` is a property of the touch EVENT, not of the individual
      // entries in `allTouches`. The previous code read `touches[i].pointerType`,
      // which is always `undefined`, so this comparison was permanently false
      // and the guard never fired.
      if (event.pointerType === PointerType.STYLUS) { manager.fail(); return; }
    })
    .onStart(() => {
      scrollYStartRef.current = scrollY;
      scrollXStartRef.current = scrollX;
      overscrollRef.current = 0;
      setOverscrollY(0);
    })
    .onUpdate((e) => {
      // Runtime guard: if the pen is currently drawing (set by the drawing pan's
      // onBegin), do nothing — the pen must never move the paper.
      if (isStylusRef.current) return;
      // Vertical scroll with damped overscroll past the bottom edge.
      const visibleH = viewport.h / Math.max(0.01, scale);
      const maxScroll = Math.max(0, totalPageH - visibleH);
      const rawY = scrollYStartRef.current - e.translationY / Math.max(0.5, scale);
      if (rawY > maxScroll) {
        // Overscrolled past the last page — apply damping and expose overscroll for add-page.
        const rawOver = (rawY - maxScroll) * scale;
        const damped = Math.min(OVERSCROLL_MAX, rawOver * OVERSCROLL_DAMP);
        setScrollY(maxScroll);
        overscrollRef.current = damped;
        setOverscrollY(damped);
      } else if (rawY < 0) {
        setScrollY(0);
        overscrollRef.current = 0;
        setOverscrollY(0);
      } else {
        setScrollY(rawY);
        overscrollRef.current = 0;
        setOverscrollY(0);
      }

      // Horizontal pan — ONLY when the page overflows the viewport (edges off-screen).
      const pageOnW = pageDims.w * scale;
      if (pageOnW > viewport.w + 0.5) {
        const maxAbs = (pageOnW - viewport.w) / (2 * scale);
        const nextX = Math.max(-maxAbs, Math.min(maxAbs, scrollXStartRef.current - e.translationX / Math.max(0.5, scale)));
        setScrollX(nextX);
      }
    })
    .onEnd(() => {
      // If pulled far enough past the bottom, add a page and jump so the new page top is visible.
      if (overscrollRef.current > OVERSCROLL_ADD_THRESHOLD) {
        haptic.success();
        setPageCount((c) => c + 1);
        setScrollY((prev) => prev + basePageH * 0.25);
      }
      overscrollRef.current = 0;
      setOverscrollY(0);
    })
    .onFinalize(() => {
      overscrollRef.current = 0;
      setOverscrollY(0);
    });

  // Convert screen-space gesture coords to world coords accounting for zoom only (no pan).
  const toWorld = (x: number, y: number) => ({
    x: (x - tx) / scale,
    y: (y - ty) / scale,
  });

  // Track whether the active touch is from a stylus / S-Pen vs a finger.
  // Set from React Native PointerEvent (onStartShouldSetResponderCapture) before the
  // RNGH gesture begins, then consulted in every gesture callback so palm rejection
  // works. (The ref itself was hoisted above the scroll gestures — see earlier
  // declaration.)

  // (drawingPanRef / fingerScrollPanRef / twoFingerPanRef are hoisted above with
  // penDownSV so their .withRef(...) usages don't hit a TDZ error at construction.)
  const pan = Gesture.Pan()
    .runOnJS(true)
    .withRef(drawingPanRef)
    .minDistance(0)
    .maxPointers(1)
    .onTouchesDown((event, manager) => {
      'worklet';
      // RNGH exposes `event.pointerType` as a numeric enum (see PointerType.ts):
      //   0 = TOUCH, 1 = STYLUS, 2 = MOUSE, 3 = KEY, 4 = OTHER
      // We reject touch (finger) input synchronously when palm rejection is on so that
      // the gesture never activates and no stroke is created.
      const pt = (event as any).pointerType;
      // Mirror the "pen is currently down" flag so child worklets (e.g. the Ruler's
      // pan gesture) can synchronously refuse when the pen is touching the screen.
      if (pt === 1) penDownSV.value = 1;
      if (palmRejectionSV.value !== 1) return;
      if (pt === 0) {
        // Finger — reject before the gesture can begin.
        manager.fail();
      }
    })
    .onBegin((e) => {
      // Mirror pointerType on the JS side so palm rejection still works if the worklet
      // path is bypassed for any reason. 0 = TOUCH (finger).
      const pt = (e as any).pointerType;
      // Default to allowing when pointerType is undefined (older devices) — but
      // still explicitly block when we know it's a finger.
      isStylusRef.current = pt !== 0;
      // The native layer owns stylus touches in its modes (ink, erase,
      // lasso, rect); stand aside for the whole gesture so nothing happens twice.
      jsSkipRef.current =
        (nativeModeRef.current !== 'none' && pt === 1) ||
        // Touches in the zoom pad's strip belong to the pad, not the page above.
        (padOpenRef.current && e.y > viewport.h - (170 + 44));
      if (jsSkipRef.current) {
        livePtsRef.current = [];
        clearLive();
        return;
      }
      if (palmRejectionRef.current && !isStylusRef.current) {
        livePtsRef.current = [];
        liveShapeRef.current = null;
        clearLive();
        return;
      }
      // A touch on the page while a text box is open saves it, nothing more.
      if (textEdit) {
        jsSkipRef.current = true;
        commitTextEdit();
        return;
      }
      // Text tool: a touch opens the editor, on an existing box or a new one.
      if (textMode) {
        const w0 = toWorld(e.x, e.y);
        jsSkipRef.current = true;
        let found = -1;
        for (let i = items.length - 1; i >= 0; i--) {
          const it = items[i];
          if (it.kind === 'text' && boxContains(it, w0)) { found = i; break; }
        }
        if (found >= 0) {
          const t = items[found] as TextItem;
          setTextEdit({ index: found, x: t.x, y: t.y, w: t.w, fontSize: t.fontSize, color: t.color, text: t.text, angle: t.angle });
        } else {
          setTextEdit({ index: null, x: w0.x, y: w0.y - 12, w: Math.min(320, pageDims.w - w0.x - 8), fontSize: 18, color, text: '', angle: 0 });
        }
        return;
      }
      // A drag left over from a cancelled gesture must not linger.
      if (selDragRef.current) {
        selDragRef.current = null;
        selXformRef.current = null;
        setSelXform(null);
      }
      // Selection showing: grab a handle or the box, or dismiss it.
      if (selectedIdx.length > 0) {
        const w0 = toWorld(e.x, e.y);
        const grab = selBounds ? hitSelection(selBounds, w0) : null;
        if (grab) {
          selDragRef.current = grab;
          return;
        }
        setSelectedIdx([]);
        // Outside the selection: with a pen, this touch only dismisses it.
        // With the select tool it goes on to start a new selection.
        if (family !== 'select') {
          jsSkipRef.current = true;
          return;
        }
      }
      // Ruler snap: if the pen begins near the ruler edge, project this stroke onto it.
      snapToRulerRef.current = false;
      if (rulerEnabled) {
        const proj = rulerSnapWorld(e.x, e.y);
        if (proj) {
          snapToRulerRef.current = true;
          const w = toWorld(proj.x, proj.y);
          if (isPenTool(tool)) {
            beginInk(w.x, w.y, stylusPressure(e));
            setLiveTick((n) => n + 1);
            return;
          }
        }
      }
      const w = toWorld(e.x, e.y);
      // ----- Laser -----
      if (family === 'laser') {
        if (variantByFamily.laser === 'spot') {
          setLaserSpot({ x: e.x, y: e.y });
        } else {
          const id = ++laserIdRef.current;
          setLaserStrokes((prev) => [...prev, { id, pts: [{ x: w.x, y: w.y, t: Date.now() }], t0: Date.now() }]);
        }
        return;
      }
      // ----- Select -----
      if (family === 'select') {
        setSelectedIdx([]);
        if (variantByFamily.select === 'rect') {
          setMarquee({ x1: w.x, y1: w.y, x2: w.x, y2: w.y });
        } else {
          setLassoPath([{ x: w.x, y: w.y, t: Date.now() }]);
        }
        return;
      }
      // Reject touches that started outside the page area (left/right margins, above/below pages, or in a gap between pages).
      const inGap = (() => {
        const pageIdx = Math.floor(w.y / pageStrideY);
        if (pageIdx < 0 || pageIdx >= pageCount) return true;
        const localY = w.y - pageIdx * pageStrideY;
        return localY > basePageH; // between two pages
      })();
      if (w.x < 0 || w.x > pageDims.w || w.y < 0 || w.y > totalPageH || inGap) {
        livePtsRef.current = [];
        liveShapeRef.current = null;
        clearLive();
        return;
      }
      if (isPenTool(tool)) {
        beginInk(w.x, w.y, stylusPressure(e));
        setLiveTick((n) => n + 1);
      } else if (isShapeTool(tool)) {
        const p: Pt = { x: w.x, y: w.y, t: Date.now() };
        liveShapeRef.current = { start: p, end: p };
        setLiveTick((n) => n + 1);
      } else if (tool === 'eraser') {
        eraseAt(w.x, w.y);
      }
    })
    .onUpdate((e) => {
      if (jsSkipRef.current) return;
      if (selDragRef.current) {
        const m = selectionDragMatrix(selDragRef.current, toWorld(e.x, e.y));
        selXformRef.current = m;
        setSelXform(m);
        return;
      }
      if (palmRejectionRef.current && !isStylusRef.current) return;
      // Ruler snap logic — the ruler acts as a physical barrier laid on the
      // paper. Two cases lock the current stroke to a ruler edge:
      //  (a) The stroke STARTED near an edge (snapToRulerRef already true).
      //  (b) The pen mid-stroke crosses INTO the ruler's rectangle — we
      //      snap from that point on, choosing whichever edge is nearer.
      // Once locked we stick to a single edge (snapEdgeRef) so a hand tremor
      // across the ruler centre can't flip the line to the other side.
      let px = e.x;
      let py = e.y;
      if (rulerEnabled) {
        if (!snapToRulerRef.current && rulerContains(rulerState, { x: e.x, y: e.y }, viewport)) {
          snapToRulerRef.current = true;
          snapEdgeRef.current = rulerEdgeSign(rulerState, { x: e.x, y: e.y });
        }
        if (snapToRulerRef.current) {
          const proj = rulerProject(rulerState, scale, { x: e.x, y: e.y }, viewport, snapEdgeRef.current);
          px = proj.x;
          py = proj.y;
        }
      }
      const w = toWorld(px, py);
      // Laser update
      if (family === 'laser') {
        if (variantByFamily.laser === 'spot') {
          setLaserSpot({ x: e.x, y: e.y });
        } else {
          setLaserStrokes((prev) => {
            if (prev.length === 0) return prev;
            const last = prev[prev.length - 1];
            return [...prev.slice(0, -1), { ...last, pts: [...last.pts, { x: w.x, y: w.y, t: Date.now() }] }];
          });
        }
        return;
      }
      // Selection update
      if (family === 'select') {
        if (variantByFamily.select === 'rect') {
          setMarquee((prev) => (prev ? { ...prev, x2: w.x, y2: w.y } : prev));
        } else {
          setLassoPath((prev) => (prev ? [...prev, { x: w.x, y: w.y, t: Date.now() }] : prev));
        }
        return;
      }
      if (isPenTool(tool)) {
        // A fine distance gate; redundant points are removed properly at
        // commit by the simplification pass, which measures shape error.
        if (!extendInk(w.x, w.y, stylusPressure(e))) return;
        pushLive();
      } else if (isShapeTool(tool) && liveShapeRef.current) {
        liveShapeRef.current.end = { x: w.x, y: w.y, t: inkNow() };
        setLiveTick((n) => n + 1);
      } else if (tool === 'eraser') {
        eraseAt(w.x, w.y);
      }
    })
    .onEnd(() => {
      if (jsSkipRef.current) return;
      if (selDragRef.current) {
        const m = selXformRef.current;
        selDragRef.current = null;
        selXformRef.current = null;
        setSelXform(null);
        if (m) commitSelectionTransform(m);
        return;
      }
      if (palmRejectionRef.current && !isStylusRef.current) {
        livePtsRef.current = [];
        liveShapeRef.current = null;
        clearLive();
        setLiveTick((n) => n + 1);
        return;
      }
      // Laser: nothing to persist. Spot laser dot disappears when finger lifts.
      if (family === 'laser') {
        if (variantByFamily.laser === 'spot') setLaserSpot(null);
        return;
      }      // Selection: finalize hit test against items.
      if (family === 'select') {
        const inside = (x: number, y: number) => {
          if (variantByFamily.select === 'rect') {
            if (!marquee) return false;
            const minX = Math.min(marquee.x1, marquee.x2);
            const maxX = Math.max(marquee.x1, marquee.x2);
            const minY = Math.min(marquee.y1, marquee.y2);
            const maxY = Math.max(marquee.y1, marquee.y2);
            return x >= minX && x <= maxX && y >= minY && y <= maxY;
          }
          // Lasso ray-cast polygon test
          if (!lassoPath || lassoPath.length < 3) return false;
          let inPoly = false;
          for (let i = 0, j = lassoPath.length - 1; i < lassoPath.length; j = i++) {
            const xi = lassoPath[i].x, yi = lassoPath[i].y;
            const xj = lassoPath[j].x, yj = lassoPath[j].y;
            const intersect = ((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi);
            if (intersect) inPoly = !inPoly;
          }
          return inPoly;
        };
        const outline =
          variantByFamily.select === 'rect'
            ? marquee ? [{ x: marquee.x1, y: marquee.y1 }, { x: marquee.x2, y: marquee.y2 }] : []
            : lassoPath ?? [];
        void inside;
        setSelectedIdx(selectionHits(items, variantByFamily.select === 'rect' ? 'rect' : 'lasso', outline));
        setMarquee(null);
        setLassoPath(null);
        return;
      }
      // Auto-add a page when the last stroke approaches the bottom of the current pages.
      if (autoAddPageRef.current && isPenTool(tool) && livePtsRef.current.length > 0) {
        const last = livePtsRef.current[livePtsRef.current.length - 1];
        // Bottom of last page (world y) = totalPageH. Trigger when close to it.
        if (last && last.y > totalPageH - 120) {
          setPageCount((c) => c + 1);
          setScrollY(pageCount * pageStrideY);
        }
      }
      if (isPenTool(tool)) {
        closeInk();
        finalizeStroke(livePtsRef.current);
        livePtsRef.current = [];
        setLiveTick((n) => n + 1);
      } else if (isShapeTool(tool) && liveShapeRef.current) {
        finalizeShape(liveShapeRef.current.start, liveShapeRef.current.end);
        liveShapeRef.current = null;
        setLiveTick((n) => n + 1);
      }
    })
    .onFinalize(() => {
      'worklet';
      // Always release the "pen is down" flag when the gesture ends OR is cancelled
      // (e.g. system interrupt, another gesture claiming the touch). Without this,
      // once the pen touched once, the Ruler would stay blocked forever.
      penDownSV.value = 0;
    });

  const finalGesture = Gesture.Simultaneous(pan, composedGesture, fingerScrollPan, tapsGesture);

  // What the native layer does with the stylus. Select and Laser map to the
  // 'pen' tool internally, so the family must be checked first, or the stylus
  // would ink while you meant to select. The ruler is handled natively too.
  const nativeAvailable = !!NativeInkView && settings.nativeInk !== false;
  // With a selection showing, every touch may be a move / resize / rotate,
  // so JavaScript takes them all until the selection is dismissed.
  const nativeMode: 'ink' | 'erase' | 'lasso' | 'rect' | 'none' =
    !nativeAvailable || selectedIdx.length > 0 || textMode || !!textEdit
    ? 'none'
    : family === 'select'
    ? variantByFamily.select === 'lasso' ? 'lasso' : 'rect'
    : family === 'laser'
    ? 'none'
    : tool === 'eraser'
    ? 'erase'
    : isPenTool(tool)
    ? 'ink'
    : 'none';
  const nativeInkActive = nativeMode === 'ink';
  nativeModeRef.current = nativeMode;

  /**
   * A stroke finished on the native layer. Its points are already in world
   * units, filtered, with widths fixed, exactly as the JS path produces them,
   * so it commits through the same code. The native layer keeps drawing it
   * until the committed copy has had time to render, then drops it.
   */
  /** Eraser tool, or S Pen button held while writing: erase along the pen's path. */
  const onNativeErase = (e: NativeEraseEvent) => {
    const p = e.nativeEvent.points;
    const pts: { x: number; y: number }[] = [];
    for (let i = 0; i + 1 < p.length; i += 2) pts.push({ x: p[i], y: p[i + 1] });
    eraseAlong(pts, !!e.nativeEvent.start);
  };
  /** Lasso / rectangle drawn natively: select what it encloses. */
  const onNativeSelect = (e: NativeSelectEvent) => {
    const p = e.nativeEvent.points;
    const outline: { x: number; y: number }[] = [];
    for (let i = 0; i + 1 < p.length; i += 2) outline.push({ x: p[i], y: p[i + 1] });
    setSelectedIdx(selectionHits(items, e.nativeEvent.kind === 'rect' ? 'rect' : 'lasso', outline));
    setMarquee(null);
    setLassoPath(null);
  };
  /** S Pen button clicked (hovering, or as the pen lands) mapped to undo/redo. */
  const onNativePenButton = (e: NativePenButtonEvent) => {
    const a = e.nativeEvent.action;
    if (a === 'undo' || a === 'redo') runGestureAction(a);
  };

  const onNativeStroke = (e: NativeStrokeEvent) => handleNativeStroke(e, setNativeCommittedId);
  /** Strokes from the zoom pad: same commit, then move the pad along if the line is filling up. */
  const onPadStroke = (e: NativeStrokeEvent) => {
    handleNativeStroke(e, setPadCommittedId);
    const flat = e.nativeEvent.points;
    const stride = e.nativeEvent.stride ?? 5;
    let maxX = -Infinity;
    for (let i = 0; i < flat.length; i += stride) maxX = Math.max(maxX, flat[i]);
    setZoomPad((zp) => (zp && maxX > zp.x + zp.w * 0.72 ? advancePad(zp, 1) : zp));
  };
  function handleNativeStroke(e: NativeStrokeEvent, setCommitted: React.Dispatch<React.SetStateAction<number>>) {
    const { id, points: flat } = e.nativeEvent;
    // [x, y, t, p, w] per point, plus tilt when stride is 6.
    const stride = e.nativeEvent.stride ?? 5;
    const pts: InkPoint[] = [];
    for (let i = 0; i + stride - 1 < flat.length; i += stride) {
      const pt: InkPoint = { x: flat[i], y: flat[i + 1], t: flat[i + 2], p: flat[i + 3], w: flat[i + 4] };
      if (stride >= 6 && flat[i + 5]) pt.a = flat[i + 5];
      pts.push(pt);
    }
    if (pts.length >= 2) {
      const last = pts[pts.length - 1];
      if (autoAddPageRef.current && last.y > totalPageH - 120) {
        setPageCount((c) => c + 1);
        setScrollY(pageCount * pageStrideY);
      }
      finalizeStroke(pts, e.nativeEvent.shape);
    }
    // Two frames for the committed stroke to reach the screen, plus margin.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => setTimeout(() => setCommitted((c) => Math.max(c, id)), 32))
    );
  }

  // ----- Render strokes -----
  // Committed strokes render through <InkStroke />, which caches its SkPath
  // against the stroke object and is memoized on that identity. Rebuilding a
  // path per render, per stroke, per frame was the main reason ink lagged
  // further behind the pen the more you had already written.
  const renderStroke = (s: StrokeData, key: string) => (
    <InkStroke
      key={key}
      stroke={s}
      points={s.points as InkPoint[]}
      tool={s.tool as InkTool}
      color={s.color}
      width={s.width}
      shape={s.shape}
    />
  );

  /** Save (or remove, if emptied) the text box being edited. */
  function commitTextEdit(remove = false) {
    const t = textEdit;
    setTextEdit(null);
    if (!t) return;
    const text = remove ? '' : t.text.replace(/\s+$/, '');
    const w = Math.max(40, t.w);
    setItems((prev) => {
      const next = [...prev];
      if (!text) {
        if (t.index === null) return prev;
        pushHistory(prev);
        next.splice(t.index, 1);
      } else {
        const h = textParagraph(text, t.fontSize, t.color, w).getHeight();
        const item: TextItem = { kind: 'text', text, x: t.x, y: t.y, w, h, fontSize: t.fontSize, color: t.color, angle: t.angle };
        pushHistory(prev);
        if (t.index === null) next.push(item);
        else next[t.index] = item;
      }
      persist(next, paper, paperSize, paperColorId);
      return next;
    });
  }

  // ----- Zoom pad -----
  const PAD_H = 170;
  const PAD_MARGIN = 16;
  const padScale = zoomPad ? viewport.w / Math.max(20, zoomPad.w) : 1;
  const padWindowH = PAD_H / padScale;
  /**
   * Move the pad's window: forward along the line, back, or to the start of
   * the next line (wrapping past the right edge of the page).
   */
  function advancePad(zp: { x: number; y: number; w: number }, dir: 1 | -1 | 0): { x: number; y: number; w: number } {
    const winH = PAD_H / (viewport.w / Math.max(20, zp.w));
    const lineStep = paper === 'ruled' || paper === 'narrow' ? Math.max(winH * 0.6, (lineSpacing ?? (paper === 'ruled' ? 32 : 20)) * 2) : winH * 0.75;
    if (dir === 0) return { ...zp, x: PAD_MARGIN, y: zp.y + lineStep };
    const nx = zp.x + dir * zp.w * 0.55;
    if (dir === 1 && nx + zp.w * 0.3 > pageDims.w) return { ...zp, x: PAD_MARGIN, y: zp.y + lineStep };
    return { ...zp, x: Math.max(0, Math.min(pageDims.w - zp.w * 0.5, nx)) };
  }
  function openZoomPad() {
    const visibleTop = scrollY;
    setZoomPad({ x: PAD_MARGIN, y: visibleTop + 40, w: pageDims.w * 0.4 });
  }
  // Keep the pad's window in view on the page above it.
  useEffect(() => {
    if (!zoomPad) return;
    const visibleH = (viewport.h - PAD_H - 44) / Math.max(0.01, scale);
    if (zoomPad.y < scrollY || zoomPad.y + padWindowH > scrollY + visibleH) {
      setScrollY(Math.max(0, zoomPad.y - visibleH * 0.3));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomPad?.y]);

  // ----- Export / share -----
  const [exporting, setExporting] = useState(false);
  /**
   * PDF: every page, ink as vectors, imported PDF pages behind it.
   * PNG: the page in the middle of the screen, 2400 px wide.
   */
  async function exportNote(format: 'pdf' | 'png') {
    setShowPaperMenu(false);
    if (exporting) return;
    setExporting(true);
    try {
      const visibleMid = scrollY + viewport.h / Math.max(0.01, scale) / 2;
      const current = Math.max(0, Math.min(pageCount - 1, Math.floor(visibleMid / pageStrideY)));
      const outW = paperSize === 'custom' && customSize ? customSize.w : orientation === 'landscape' ? 842 : 595;
      const path = await exportDoc({
        format,
        name: note?.title || 'Note',
        pageW: pageDims.w,
        pageH: basePageH,
        stride: pageStrideY,
        pages: format === 'pdf' ? Array.from({ length: pageCount }, (_, i) => i) : [current],
        paper,
        paperColor,
        lineColor: paperLine,
        lineSpacing: lineSpacing ?? null,
        outW,
        pngWidth: 2400,
        items,
        images: imagesRef.current,
        backgrounds: pageBackgrounds,
        pageTemplates,
      });
      if (!path) {
        Alert.alert('Export', 'Exporting needs the latest app build.');
        return;
      }
      await Sharing.shareAsync(`file://${path}`, {
        mimeType: format === 'pdf' ? 'application/pdf' : 'image/png',
        dialogTitle: format === 'pdf' ? 'Share PDF' : 'Share page',
      });
    } catch (err) {
      Alert.alert('Export failed', err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  }

  // ----- Images and text boxes on the page -----
  // Image data lives in the note's `images` column (JPEG data URIs), the same
  // place text notes keep theirs, so it is in backups and never re-written
  // by the drawing autosave. Items point at it by index; the list only grows.
  const imagesRef = useRef<string[]>([]);
  const decodedRef = useRef<Map<number, SkImage | null>>(new Map());
  const imageFor = (ref: number): SkImage | null => {
    const cache = decodedRef.current;
    if (cache.has(ref)) return cache.get(ref)!;
    const uri = imagesRef.current[ref];
    let img: SkImage | null = null;
    if (uri) {
      const b64 = uri.slice(uri.indexOf(',') + 1);
      try {
        img = Skia.Image.MakeImageFromEncoded(Skia.Data.fromBase64(b64));
      } catch {
        img = null;
      }
    }
    cache.set(ref, img);
    return img;
  };

  const renderBox = (it: ImageItem | TextItem, key: string) => {
    const origin = { x: it.x + it.w / 2, y: it.y + it.h / 2 };
    const rot = it.angle ? [{ rotate: it.angle }] : undefined;
    if (it.kind === 'image') {
      const img = imageFor(it.ref);
      return (
        <Group key={key} origin={origin} transform={rot}>
          {img ? (
            <SkiaImage image={img} x={it.x} y={it.y} width={it.w} height={it.h} fit="fill" />
          ) : (
            <Path
              path={(() => { const pp = Skia.Path.Make(); pp.addRect({ x: it.x, y: it.y, width: it.w, height: it.h }); return pp; })()}
              color="#999"
              style="stroke"
              strokeWidth={1}
            />
          )}
        </Group>
      );
    }
    return (
      <Group key={key} origin={origin} transform={rot}>
        <Paragraph paragraph={textParagraph(it.text, it.fontSize, it.color, it.w)} x={it.x} y={it.y} width={it.w} />
      </Group>
    );
  };

  function renderItem(it: Item, key: string) {
    if (it.kind === 'stroke') return renderStroke(it, key);
    if (it.kind === 'shape') return renderShape(it, key);
    return renderBox(it, key);
  }

  /** Thinner / thicker for lines; text boxes change font size instead; images don't. */
  function resizeLine(it: Item, f: number): Item {
    if (it.kind === 'stroke' || it.kind === 'shape') return { ...it, width: it.width * f };
    if (it.kind === 'text') {
      const fontSize = Math.max(4, it.fontSize * f);
      const h = textParagraph(it.text, fontSize, it.color, it.w).getHeight();
      return { ...it, fontSize, h };
    }
    return it;
  }

  /** Pick a picture from the gallery and drop it in the middle of the view, selected. */
  async function insertImage() {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) return;
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        base64: true,
        quality: 0.6,
      });
      const asset = res.canceled ? null : res.assets[0];
      if (!asset?.base64) return;
      const ref = imagesRef.current.length;
      imagesRef.current = [...imagesRef.current, `data:image/jpeg;base64,${asset.base64}`];
      decodedRef.current.delete(ref);
      if (note) NotesApi.update(note.id, { images: imagesRef.current }).catch((err) => console.warn('image save failed', err));
      const aspect = asset.width && asset.height ? asset.height / asset.width : 0.75;
      const w = Math.min(pageDims.w * 0.6, (asset.width || 600) / 2);
      const h = w * aspect;
      const c = toWorld(viewport.w / 2, viewport.h / 2);
      const item: ImageItem = { kind: 'image', ref, x: c.x - w / 2, y: c.y - h / 2, w, h, angle: 0 };
      const index = items.length;
      setItems((prev) => {
        pushHistory(prev);
        const next = [...prev, item];
        persist(next, paper, paperSize, paperColorId);
        return next;
      });
      setSelectedIdx([index]);
      haptic.success();
    } catch (err) {
      console.warn('insert image failed', err);
    }
  }

  const renderShape = (s: ShapeData, key: string) => {
    const path = buildShapePath(s);
    return (
      <Path
        key={key}
        path={path}
        color={s.color}
        style="stroke"
        strokeWidth={s.width}
        strokeCap="round"
        strokeJoin="round"
      />
    );
  };

  // Live preview.
  //
  // Pen strokes are pushed straight into <LiveStrokeLayer /> through a ref, so a
  // pen sample repaints one path instead of re-rendering this screen. Shapes
  // still go through state: they update once per drag, not once per sample, so
  // the extra render is not on the hot path.
  // Declared with `function`, not `const`, deliberately.
  //
  // The gesture objects below are constructed during render, *above* this point,
  // and their callbacks call these. Reanimated's babel plugin lifts gesture
  // callbacks into worklets, which capture referenced identifiers by value at
  // construction time. A `const` arrow declared further down is still in its
  // temporal dead zone at that moment, so the worklet captured `undefined` and
  // the first pen stroke died with "C is not a function (it is undefined)".
  //
  // Function declarations are hoisted and initialised before any of this runs,
  // so there is nothing left to capture too early.
  /**
   * Start / extend the wet stroke. Positions go through an adaptive low-pass
   * filter (strong when slow, where digitiser jitter shows as fuzz; almost
   * none when fast, where it would show as lag). Each sample's width is fixed
   * here, once, so the committed stroke draws exactly what was on screen.
   * Function declarations for the same TDZ reason as pushLive below.
   */
  function beginInk(x: number, y: number, p: number | undefined) {
    inkFilterRef.current.reset();
    const t = inkNow();
    const f = inkFilterRef.current.filter(x, y, t);
    livePtsRef.current = [{ x: f.x, y: f.y, t, p }];
    annotateWidth(livePtsRef.current as InkPoint[], 0, tool as InkTool);
    lastRawRef.current = { x, y, t, p };
  }
  /** Returns false when the sample was too close to the last one to keep. */
  function extendInk(x: number, y: number, p: number | undefined): boolean {
    const pts = livePtsRef.current as InkPoint[];
    const last = pts[pts.length - 1];
    if (!last) return false;
    const t = inkNow();
    lastRawRef.current = { x, y, t, p };
    const f = inkFilterRef.current.filter(x, y, t);
    if (Math.hypot(f.x - last.x, f.y - last.y) < MIN_SAMPLE_DISTANCE) return false;
    pts.push({ x: f.x, y: f.y, t, p });
    annotateWidth(pts, pts.length - 1, tool as InkTool);
    return true;
  }
  /** The filter trails the pen slightly; end the line where the pen lifted. */
  function closeInk() {
    const pts = livePtsRef.current as InkPoint[];
    const raw = lastRawRef.current;
    const last = pts[pts.length - 1];
    if (raw && last && Math.hypot(raw.x - last.x, raw.y - last.y) > MIN_SAMPLE_DISTANCE) {
      pts.push({ x: raw.x, y: raw.y, t: Math.max(raw.t, last.t + 0.5), p: raw.p });
      annotateWidth(pts, pts.length - 1, tool as InkTool);
    }
    lastRawRef.current = null;
  }

  function pushLive() {
    if (!isPenTool(tool)) {
      liveStrokeRef.current?.set(null);
      return;
    }
    const pts = livePtsRef.current;
    liveStrokeRef.current?.set(
      pts.length >= 2
        ? { points: pts as InkPoint[], tool: tool as InkTool, color, width: widths[tool] }
        : null
    );
  }

  function clearLive() {
    liveStrokeRef.current?.set(null);
  }

  // ----- Selection: bounds, handles, transforms, clipboard -----
  /** Handle sizes are in screen points, so convert to world at the current zoom. */
  const HANDLE_R = 9;
  const ROTATE_OFFSET = 30;

  function hitSelection(r: SelRect, w: { x: number; y: number }) {
    const h = selHandles(r, ROTATE_OFFSET / scale);
    const reach = 22 / scale; // generous: easy to grab with a finger
    if (Math.hypot(w.x - h.rotate.x, w.y - h.rotate.y) <= reach) {
      return { kind: 'rotate' as const, start: w, anchor: h.center };
    }
    for (let k = 0; k < 4; k++) {
      const c = h.corners[k];
      if (Math.hypot(w.x - c.x, w.y - c.y) <= reach) {
        return { kind: 'scale' as const, start: w, anchor: h.corners[(k + 2) % 4] };
      }
    }
    const pad = 8 / scale;
    if (w.x >= r.x - pad && w.x <= r.x + r.w + pad && w.y >= r.y - pad && w.y <= r.y + r.h + pad) {
      return { kind: 'move' as const, start: w, anchor: h.center };
    }
    return null;
  }

  function selectionDragMatrix(
    d: { kind: 'move' | 'scale' | 'rotate'; start: { x: number; y: number }; anchor: { x: number; y: number } },
    cur: { x: number; y: number }
  ): Mat {
    if (d.kind === 'move') return translate(cur.x - d.start.x, cur.y - d.start.y);
    if (d.kind === 'scale') {
      const d0 = Math.hypot(d.start.x - d.anchor.x, d.start.y - d.anchor.y) || 1;
      const d1 = Math.hypot(cur.x - d.anchor.x, cur.y - d.anchor.y);
      return scaleAbout(d.anchor, Math.max(0.05, d1 / d0));
    }
    const a0 = Math.atan2(d.start.y - d.anchor.y, d.start.x - d.anchor.x);
    const a1 = Math.atan2(cur.y - d.anchor.y, cur.x - d.anchor.x);
    return rotateAbout(d.anchor, snapAngle(a1 - a0));
  }

  /** Apply a finished drag to the selected items' points, as one undo step. */
  function commitSelectionTransform(m: Mat) {
    const moved = Math.abs(m.e) + Math.abs(m.f) > 1e-3 || Math.abs(m.a - 1) + Math.abs(m.b) + Math.abs(m.c) + Math.abs(m.d - 1) > 1e-4;
    if (!moved) return;
    const sel = new Set(selectedIdx);
    setItems((prev) => {
      pushHistory(prev);
      const next = prev.map((it, i) => (sel.has(i) ? (bakeItem(it, m) as Item) : it));
      persist(next, paper, paperSize, paperColorId);
      return next;
    });
  }

  function editSelected(fn: (it: Item) => Item) {
    const sel = new Set(selectedIdx);
    setItems((prev) => {
      pushHistory(prev);
      const next = prev.map((it, i) => (sel.has(i) ? fn(it) : it));
      persist(next, paper, paperSize, paperColorId);
      return next;
    });
  }

  function copySelection() {
    // Images carry their picture data, so they can be pasted into another note.
    inkClipboard = selectedIdx
      .map((i) => items[i])
      .filter(Boolean)
      .map((it) => {
        const c = cloneItem(it) as Item;
        return c.kind === 'image' ? ({ ...c, _data: imagesRef.current[c.ref] } as Item) : c;
      });
    setClipCount(inkClipboard.length);
    haptic.success();
  }

  function deleteSelection() {
    const sel = new Set(selectedIdx);
    setItems((prev) => {
      pushHistory(prev);
      const next = prev.filter((_, idx) => !sel.has(idx));
      persist(next, paper, paperSize, paperColorId);
      return next;
    });
    setSelectedIdx([]);
  }

  /** Add copies of `src` moved by `m`, and select them. */
  function insertItems(src: Item[], m: Mat) {
    if (!src.length) return;
    // Pictures from another note (or a deleted one) are added to this note's images.
    let imagesChanged = false;
    const local = src.map((it) => {
      const data = (it as { _data?: string })._data;
      if (it.kind !== 'image' || !data) return it;
      let ref = imagesRef.current.indexOf(data);
      if (ref < 0) {
        ref = imagesRef.current.length;
        imagesRef.current = [...imagesRef.current, data];
        imagesChanged = true;
      }
      const { _data, ...rest } = it as ImageItem & { _data?: string };
      void _data;
      return { ...rest, ref } as Item;
    });
    if (imagesChanged && note) {
      NotesApi.update(note.id, { images: imagesRef.current }).catch((err) => console.warn('image save failed', err));
    }
    const added = local.map((it) => bakeItem(cloneItem(it), m) as Item);
    const start = items.length;
    setItems((prev) => {
      pushHistory(prev);
      const next = [...prev, ...added];
      persist(next, paper, paperSize, paperColorId);
      return next;
    });
    setSelectedIdx(added.map((_, k) => start + k));
  }

  /** Paste into the middle of what's on screen, wherever the copy came from. */
  function pasteClipboard() {
    const b = unionBounds(inkClipboard.map((it) => itemBounds(it, effW)));
    if (!b) return;
    const c = toWorld(viewport.w / 2, viewport.h / 2);
    insertItems(inkClipboard, translate(c.x - (b.x + b.w / 2), c.y - (b.y + b.h / 2)));
    haptic.success();
  }

  function duplicateSelection() {
    const src = selectedIdx.map((i) => items[i]).filter(Boolean);
    insertItems(src, translate(18 / scale, 18 / scale));
  }

  const livePreview =
    isShapeTool(tool) && liveShapeRef.current
      ? renderShape(
          {
            kind: 'shape',
            tool,
            color,
            width: widths[tool],
            start: liveShapeRef.current.start,
            end: liveShapeRef.current.end,
          },
          'live-shape'
        )
      : null;

  // Paper background colors.
  // We honor whatever the user picked verbatim — if `paperColorId` is a hex value
  // (newly-created notes store the hex directly), use it. Otherwise fall back to the
  // legacy lookup. This avoids the theme switching the picked color into something
  // else (the cream→dark-brown bug).
  const paperColor = (() => {
    if (paperColorId.startsWith('#')) return paperColorId;
    const entry = PAPER_COLORS.find((c) => c.id === paperColorId);
    if (entry) return entry.light;
    return isDark ? '#0a0a0a' : '#FBFAF6';
  })();
  // Auto-pick a readable line color based on the paper's perceived brightness.
  const paperLuminance = (() => {
    const hex = paperColor.replace('#', '');
    if (hex.length < 6) return 1;
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  })();
  const isDarkPaper = paperLuminance < 0.45;
  const paperLine = isDarkPaper ? '#5a5a5e' : '#C9C2B0';

  /**
   * A paper change made inside a note becomes the starting page for the next
   * new note, so "+" on the home screen opens the paper the user actually uses.
   */
  const rememberSetup = (patch: Partial<PageSetup>) => {
    update({
      lastPageSetup: {
        paper,
        paperSize,
        customSize: paperSize === 'custom' && customSize ? customSize : undefined,
        orientation,
        paperColor: paperColorId,
        lineSpacing,
        ...patch,
      },
    });
  };
  const handleSetPaper = (p: Paper) => {
    setPaper(p);
    persist(items, p, paperSize, paperColorId);
    rememberSetup({ paper: p });
  };
  const handleSetSize = (s: PaperSize) => {
    setPaperSize(s);
    persist(items, paper, s, paperColorId);
    rememberSetup({ paperSize: s });
  };
  const handleSetColor = (c: string) => {
    setPaperColorId(c);
    persist(items, paper, paperSize, c);
    rememberSetup({ paperColor: c });
  };
  /**
   * Canvas colour, saved with the note.
   *
   * The picker previously called `setCanvasColorHex` alone. Every other paper
   * setting routes through `persist()`, so canvas colour was the one that
   * looked applied, then reverted to the default the next time the note opened
   * because it was never written to the document.
   *
   * `persist` reads canvasColorHex from its closure, so the new value is passed
   * explicitly rather than relying on the state update having landed.
   */
  const handleSetCanvasColor = (hex: string) => {
    setCanvasColorHex(hex);
    persist(items, paper, paperSize, paperColorId, undefined, undefined, hex);
  };

  const handleSetLineSpacing = (val: number) => {
    setLineSpacing(val);
    persist(items, paper, paperSize, paperColorId);
    rememberSetup({ lineSpacing: val });
  };

  const updateTitle = () => {
    setShowTitleEdit(false);
    persist(items, paper, paperSize, paperColorId, titleDraft);
    if (note) {
      setNote({ ...note, title: titleDraft });
      renameTab(note.id, titleDraft || 'Untitled');
    }
  };

  const exitDelete = async () => {
    if (!note) return;
    await NotesApi.remove(note.id);
    router.back();
  };

  // ---------- Labels (bound to this handwritten note) ----------
  const noteLabels = useMemo(
    () =>
      ((note?.label_ids || [])
        .map((lid) => labels.find((l) => l.id === lid))
        .filter(Boolean) as Label[]),
    [note?.label_ids, labels]
  );

  const toggleLabelOnNote = useCallback(
    async (labelId: string) => {
      if (!note) return;
      const current = new Set(note.label_ids || []);
      if (current.has(labelId)) current.delete(labelId);
      else current.add(labelId);
      const next = Array.from(current);
      setNote((prev) => (prev ? { ...prev, label_ids: next } : prev));
      try {
        await NotesApi.update(note.id, { label_ids: next });
      } catch (e) {
        console.warn('label toggle failed', e);
      }
    },
    [note]
  );

  const createLabelFromDraw = useCallback(async () => {
    const name = labelDraftName.trim();
    if (!name || !note) return;
    try {
      const color = labelColors[labels.length % labelColors.length];
      const created = await LabelsApi.create({ name, color });
      const nextLabels = [...labels.filter((l) => l.id !== created.id), created];
      setLabels(nextLabels);
      setLabelDraftName('');
      // Auto-apply to the current note.
      const currentIds = new Set(note.label_ids || []);
      currentIds.add(created.id);
      const nextIds = Array.from(currentIds);
      setNote((prev) => (prev ? { ...prev, label_ids: nextIds } : prev));
      await NotesApi.update(note.id, { label_ids: nextIds });
    } catch (e) {
      console.warn('create label failed', e);
    }
  }, [labelDraftName, labels, note]);

  const openLabelPicker = useCallback(async () => {
    // Refresh labels list so any changes made elsewhere show up here.
    try { setLabels(await LabelsApi.list()); } catch {}
    setShowLabelPicker(true);
  }, []);

  /**
   * Folders in tree order, each with its nesting depth.
   *
   * The picker rendered `folders.map(...)` — the raw flat array — so a folder
   * three levels deep looked identical to a top-level one and you couldn't
   * tell which was inside which. Fully expanded: this is a destination
   * chooser, so everything needs to be reachable without extra taps.
   */
  const folderTree = useMemo(() => {
    const byParent = new Map<string | null, typeof folders>();
    for (const f of folders) {
      const key = f.parent_id ?? null;
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key)!.push(f);
    }
    const out: { folder: (typeof folders)[number]; depth: number }[] = [];
    const walk = (parent: string | null, depth: number) => {
      // Guard against a cycle in stored data rather than recursing forever.
      if (depth > 8) return;
      for (const f of byParent.get(parent) ?? []) {
        out.push({ folder: f, depth });
        walk(f.id, depth + 1);
      }
    };
    walk(null, 0);
    return out;
  }, [folders]);

  const openFolderPicker = useCallback(async () => {
    // Refresh so folders created elsewhere are visible in the picker.
    try { setFolders(await FoldersApi.list()); } catch {}
    setShowFolderPicker(true);
  }, []);

  const moveNoteToFolder = useCallback(async (folderId: string | null) => {
    if (!note) return;
    setNote((prev) => (prev ? { ...prev, folder_id: folderId } : prev));
    try {
      await NotesApi.update(note.id, { folder_id: folderId });
    } catch (e) {
      console.warn('move-to-folder failed', e);
    }
    setShowFolderPicker(false);
  }, [note]);

  const currentFolder = useMemo(
    () => (note?.folder_id ? folders.find((f) => f.id === note.folder_id) : undefined),
    [note?.folder_id, folders]
  );

  const handleToolTap = (t: Tool, e?: any) => {
    haptic.selection();
    if (tool === t && (isPenTool(t) || t === 'eraser')) {
      const target = e?.currentTarget;
      if (target && typeof target.measureInWindow === 'function') {
        target.measureInWindow((x: number, y: number, w: number, h: number) => {
          if (typeof x === 'number' && typeof y === 'number' && w > 0 && h > 0) {
            setToolOptAnchor({ x, y, w, h });
          } else {
            setToolOptAnchor(null);
          }
          setShowToolOpts(true);
        });
      } else {
        // Fallback: use tap coordinates with a rough size
        const px = e?.nativeEvent?.pageX;
        const py = e?.nativeEvent?.pageY;
        if (typeof px === 'number' && typeof py === 'number') {
          setToolOptAnchor({ x: px - 22, y: py - 14, w: 44, h: 28 });
        } else {
          setToolOptAnchor(null);
        }
        setShowToolOpts(true);
      }
      return;
    }
    setTool(t);
  };

  // Family-level toolbar handling. Switches to the family's remembered variant, or
  // opens the popover if the same family is re-tapped.
  const applyFamilyVariant = useCallback((f: ToolFamily, v: string) => {
    setFamily(f);
    setVariantByFamily((prev) => ({ ...prev, [f]: v }));
    setTool(familyVariantToTool(f, v));
    if (f === 'eraser') {
      setEraserModePersist(v === 'area' ? 'partial' : 'stroke');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleFamilyTap = (f: ToolFamily, e?: any) => {
    haptic.selection();
    if (family === f) {
      const target = e?.currentTarget;
      if (target && typeof target.measureInWindow === 'function') {
        target.measureInWindow((x: number, y: number, w: number, h: number) => {
          if (typeof x === 'number' && typeof y === 'number' && w > 0 && h > 0) {
            setToolOptAnchor({ x, y, w, h });
          } else {
            setToolOptAnchor(null);
          }
          setShowToolOpts(true);
        });
      } else {
        const px = e?.nativeEvent?.pageX;
        const py = e?.nativeEvent?.pageY;
        if (typeof px === 'number' && typeof py === 'number') {
          setToolOptAnchor({ x: px - 22, y: py - 14, w: 44, h: 28 });
        } else {
          setToolOptAnchor(null);
        }
        setShowToolOpts(true);
      }
      return;
    }
    applyFamilyVariant(f, variantByFamily[f]);
  };

  const resetZoom = () => {
    setScale(1);
  };

  // ---------- Zoom presets ----------
  const [zoomPresets, setZoomPresets] = useState<{ name: string; scale: number }[]>([]);
  const [showZoomMenu, setShowZoomMenu] = useState(false);
  const [showPagesPanel, setShowPagesPanel] = useState(false);
  // Long-press menu for one page in the pages panel, and the bookmark filter.
  const [pageMenu, setPageMenu] = useState<number | null>(null);
  const [onlyMarked, setOnlyMarked] = useState(false);
  // Fixed compact thumbnail size for the page sorter (three columns on typical panel widths).
  const pageThumbSize = 0.15;

  // Pages panel helpers — operate on world-y coordinates (gap-inclusive) so items align.
  const deletePage = useCallback((pageIdx: number) => {
    if (pageCount <= 1) return;
    haptic.warning();
    setItems((prev) => {
      pushHistory(prev);
      const next: Item[] = [];
      for (const it of prev) {
        const home = Math.floor(itemHomeY(it) / pageStrideY);
        if (home === pageIdx) continue; // drop
        next.push(home > pageIdx ? shiftItem(it, -pageStrideY) : it);
      }
      persist(next, paper, paperSize, paperColorId);
      return next;
    });
    remapPageMeta(<T,>(arr: T[], blank: T): T[] => {
      const n = [...arr];
      if (pageIdx < n.length) n.splice(pageIdx, 1);
      return n;
    });
    setPageCount((c) => Math.max(1, c - 1));
    setScrollY((s) => Math.max(0, Math.min(s, (pageCount - 2) * pageStrideY)));
  }, [pageCount, pageStrideY, paper, paperSize, paperColorId, persist]);

  const movePage = useCallback((fromIdx: number, direction: -1 | 1) => {
    const toIdx = fromIdx + direction;
    if (toIdx < 0 || toIdx >= pageCount) return;
    haptic.selection();
    const a = Math.min(fromIdx, toIdx);
    const b = Math.max(fromIdx, toIdx);
    const delta = (b - a) * pageStrideY;
    setItems((prev) => {
      pushHistory(prev);
      const next = prev.map((it) => {
        const home = Math.floor(itemHomeY(it) / pageStrideY);
        if (home === a) return shiftItem(it, delta);
        if (home === b) return shiftItem(it, -delta);
        return it;
      });
      persist(next, paper, paperSize, paperColorId);
      return next;
    });
    remapPageMeta(<T,>(arr: T[], blank: T): T[] => {
      const n = [...arr];
      while (n.length <= b) n.push(blank);
      const t = n[a];
      n[a] = n[b];
      n[b] = t;
      return n;
    });
  }, [pageCount, pageStrideY, paper, paperSize, paperColorId, persist]);

  const insertPageAfter = useCallback((pageIdx: number) => {
    haptic.success();
    const boundary = (pageIdx + 1) * pageStrideY;
    setItems((prev) => {
      pushHistory(prev);
      const next = prev.map((it) => shiftBelow(it, boundary, pageStrideY));
      persist(next, paper, paperSize, paperColorId);
      return next;
    });
    remapPageMeta(<T,>(arr: T[], blank: T): T[] => {
      const n = [...arr];
      if (pageIdx + 1 <= n.length) n.splice(pageIdx + 1, 0, blank);
      return n;
    });
    setPageCount((c) => c + 1);
  }, [pageStrideY, paper, paperSize, paperColorId, persist]);

  /** Copy a page's ink, text and pictures to a new page right after it. */
  const duplicatePage = (pageIdx: number) => {
    haptic.success();
    const boundary = (pageIdx + 1) * pageStrideY;
    setItems((prev) => {
      pushHistory(prev);
      const copies = prev
        .filter((it) => Math.floor(itemHomeY(it) / pageStrideY) === pageIdx)
        .map((it) => shiftItem(cloneItem(it) as Item, pageStrideY));
      const next = [...prev.map((it) => shiftBelow(it, boundary, pageStrideY)), ...copies];
      persist(next, paper, paperSize, paperColorId);
      return next;
    });
    remapPageMeta(<T,>(arr: T[], blank: T): T[] => {
      const n = [...arr];
      while (n.length <= pageIdx) n.push(blank);
      // The copy keeps the page's paper and PDF background, not its bookmark.
      const copied = typeof blank === 'boolean' ? blank : n[pageIdx];
      n.splice(pageIdx + 1, 0, copied);
      return n;
    });
    setPageCount((c) => c + 1);
  };

  /** Set one page's paper (null = same as the note) or bookmark, and save. */
  const setPageMeta = (pageIdx: number, change: { template?: Paper | null; bookmark?: boolean }) => {
    if ('template' in change) {
      setPageTemplates((a) => {
        const n = [...a];
        while (n.length <= pageIdx) n.push(null);
        n[pageIdx] = change.template ?? null;
        return n;
      });
    }
    if ('bookmark' in change) {
      setPageBookmarks((a) => {
        const n = [...a];
        while (n.length <= pageIdx) n.push(false);
        n[pageIdx] = !!change.bookmark;
        return n;
      });
    }
    persist(items, paper, paperSize, paperColorId);
  };

  const jumpToPage = useCallback((pageIdx: number) => {
    haptic.selection();
    const maxScroll = Math.max(0, totalPageH - basePageH);
    setScrollY(Math.max(0, Math.min(pageIdx * pageStrideY, maxScroll)));
  }, [pageStrideY, totalPageH, basePageH]);

  const [zoomMenuAnchor, setZoomMenuAnchor] = useState<{ x: number; y: number } | null>(null);
  const [savingPreset, setSavingPreset] = useState(false);
  const [presetNameDraft, setPresetNameDraft] = useState('');

  useEffect(() => {
    AsyncStorage.getItem(StorageKeys.zoomPresets).then((raw) => {
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) setZoomPresets(parsed.slice(0, 12));
        } catch {}
      }
    });
  }, []);

  const persistZoomPresets = useCallback((next: { name: string; scale: number }[]) => {
    setZoomPresets(next);
    AsyncStorage.setItem(StorageKeys.zoomPresets, JSON.stringify(next)).catch(() => {});
  }, []);

  const saveCurrentZoomAs = (name: string) => {
    const label = (name || `${Math.round(scale * 100)}%`).trim().slice(0, 24);
    if (!label) return;
    const filtered = zoomPresets.filter((p) => p.name.toLowerCase() !== label.toLowerCase());
    persistZoomPresets([...filtered, { name: label, scale: Number(scale.toFixed(3)) }].slice(0, 12));
  };

  const removePreset = (name: string) => {
    persistZoomPresets(zoomPresets.filter((p) => p.name !== name));
  };
  const renamePreset = (oldName: string, newName: string) => {
    const label = newName.trim().slice(0, 24);
    if (!label) return;
    if (zoomPresets.some((p) => p.name.toLowerCase() === label.toLowerCase() && p.name !== oldName)) return;
    persistZoomPresets(zoomPresets.map((p) => (p.name === oldName ? { ...p, name: label } : p)));
  };
  const [renamingPreset, setRenamingPreset] = useState<string | null>(null); // preset name being edited
  const [renameDraft, setRenameDraft] = useState('');

  // ---------- Ruler preferences (state is declared above, here we just persist prefs) ----------
  // Persist ruler preferences (not position — it re-centers each time).
  useEffect(() => {
    AsyncStorage.getItem(StorageKeys.rulerPrefs).then((raw) => {
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          setRulerState((prev) => ({
            ...prev,
            unit: parsed.unit === 'in' ? 'in' : 'cm',
            scaleWithPaper: parsed.scaleWithPaper !== false,
          }));
        } catch {}
      }
    });
  }, []);
  useEffect(() => {
    AsyncStorage.setItem(StorageKeys.rulerPrefs, JSON.stringify({
      unit: rulerState.unit,
      scaleWithPaper: rulerState.scaleWithPaper,
    })).catch(() => {});
  }, [rulerState.unit, rulerState.scaleWithPaper]);

  if (loading || !note) {
    // Keep the transition minimal — just a plain matching surface, no spinner. This
    // eliminates the "flash of loading state" when switching between open tabs.
    return <View style={{ flex: 1, backgroundColor: colors.surface }} />;
  }

  // Toolbar element — adapts orientation based on toolbarPos
  /** Save the current pen (tool, colour, width) into favourite slot `k`. */
  const saveFavoritePen = (k: number) => {
    const next = [...(settings.favoritePens ?? [null, null, null, null, null])];
    while (next.length < 5) next.push(null);
    next[k] = { family, variant: variantByFamily[family], color, width: widths[tool] ?? 3 };
    update({ favoritePens: next });
    haptic.success();
  };
  const clearFavoritePen = (k: number) => {
    const next = [...(settings.favoritePens ?? [null, null, null, null, null])];
    next[k] = null;
    update({ favoritePens: next });
  };
  const lumOf = (hex: string) => {
    const h = (hex || '#000000').replace('#', '');
    if (h.length < 6) return 0;
    return (0.299 * parseInt(h.slice(0, 2), 16) + 0.587 * parseInt(h.slice(2, 4), 16) + 0.114 * parseInt(h.slice(4, 6), 16)) / 255;
  };

  const renderToolbar = () => {
    const vertical = isVerticalToolbar;
    return (
      <View
        style={[
          {
            backgroundColor: colors.surface,
          },
          vertical
            ? {
                width: VERTICAL_TOOLBAR_W,
                paddingTop: spacing.xs,
                paddingBottom: insets.bottom + spacing.xs,
                borderRightWidth: toolbarPos === 'left' ? StyleSheet.hairlineWidth : 0,
                borderLeftWidth: toolbarPos === 'right' ? StyleSheet.hairlineWidth : 0,
                borderRightColor: colors.divider,
                borderLeftColor: colors.divider,
              }
            : {
                paddingTop: toolbarPos === 'top' ? spacing.xs : 0,
                paddingBottom: toolbarPos === 'bottom' ? insets.bottom + spacing.xs : spacing.xs,
                borderTopWidth: toolbarPos === 'bottom' ? StyleSheet.hairlineWidth : 0,
                borderBottomWidth: toolbarPos === 'top' ? StyleSheet.hairlineWidth : 0,
                borderTopColor: colors.divider,
                borderBottomColor: colors.divider,
              },
        ]}
      >
        <ScrollView
          horizontal={!vertical}
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={
            vertical
              ? { alignItems: 'center', gap: 4, paddingHorizontal: 4, paddingBottom: spacing.sm }
              : { alignItems: 'center', gap: 2, paddingHorizontal: spacing.xs }
          }
          style={{ flexGrow: 1 }}
        >
          <ToolBtn
            icon="arrow-undo"
            label="Undo"
            active={false}
            onPress={() => { haptic.light(); undo(); }}
            testID="tool-undo"
          />
          <ToolBtn
            icon="arrow-redo"
            label="Redo"
            active={false}
            onPress={() => { haptic.light(); redo(); }}
            testID="tool-redo"
          />
          <Divider vertical={vertical} />
          <ToolBtn
            icon={settings.palmRejection ? 'hand-left' : 'hand-left-outline'}
            label={settings.palmRejection ? 'Pen only' : 'Touch on'}
            active={settings.palmRejection}
            onPress={() => { haptic.selection(); update({ palmRejection: !settings.palmRejection }); }}
            testID="tool-pen-mode"
          />
          <Divider vertical={vertical} />
          {/* Family buttons — one per tool family. Tap to switch family / re-tap to
              open the variant + settings popover. */}
          {FAMILY_ORDER.map((f) => (
            <ToolBtn
              key={`family-${f}`}
              icon={FAMILY_META[f].icon}
              iconLib={FAMILY_META[f].lib}
              label={FAMILY_META[f].label}
              active={family === f}
              onPress={(e) => handleFamilyTap(f, e)}
              testID={`family-${f}`}
            />
          ))}
          {/* Ruler toggle — sits alongside the tool families but is a modifier that
              can be turned on/off independently of the currently selected drawing tool. */}
          <ToolBtn
            icon="ruler"
            iconLib="mci"
            label="Ruler"
            active={rulerEnabled}
            onPress={() => {
              haptic.selection();
              if (!rulerEnabled) {
                setRulerState((prev) => ({ ...prev, x: viewport.w / 2, y: viewport.h / 2, angle: 0 }));
              }
              setRulerEnabled((v) => !v);
            }}
            testID="tool-ruler"
          />
          <ToolBtn
            icon="format-text"
            iconLib="mci"
            label="Text"
            active={textMode}
            onPress={() => {
              haptic.selection();
              if (textEdit) commitTextEdit();
              setSelectedIdx([]);
              setTextMode((v) => !v);
            }}
            testID="tool-text"
          />
          <ToolBtn
            icon="image-plus"
            iconLib="mci"
            label="Image"
            active={false}
            onPress={() => {
              haptic.selection();
              setTextMode(false);
              void insertImage();
            }}
            testID="tool-image"
          />
          {NativeInkView && settings.nativeInk !== false && (
            <ToolBtn
              icon="magnify-plus-outline"
              iconLib="mci"
              label="Zoom pad"
              active={!!zoomPad}
              onPress={() => {
                haptic.selection();
                if (zoomPad) setZoomPad(null);
                else openZoomPad();
              }}
              testID="tool-zoom-pad"
            />
          )}
          <Divider vertical={vertical} />
          {/* Favourite pens: tap an empty slot to save the current pen, tap a
              saved one to switch to it, long-press to replace or clear it. */}
          {(settings.favoritePens ?? [null, null, null, null, null]).slice(0, 5).map((fp, k) => {
            const isPen = isPenTool(tool) && family !== 'select' && family !== 'laser';
            const active =
              !!fp && fp.family === family && fp.variant === variantByFamily[family] && fp.color === color && Math.abs(fp.width - (widths[tool] ?? 0)) < 0.01;
            return (
              <Pressable
                key={`fav-${k}`}
                testID={`fav-pen-${k}`}
                accessibilityLabel={fp ? `Favourite pen ${k + 1}` : `Save current pen to slot ${k + 1}`}
                onPress={() => {
                  haptic.selection();
                  if (fp) {
                    applyFamilyVariant(fp.family as ToolFamily, fp.variant);
                    setColor(fp.color);
                    const t = familyVariantToTool(fp.family as ToolFamily, fp.variant);
                    setWidths((prev) => ({ ...prev, [t]: fp.width }));
                  } else if (isPen) {
                    saveFavoritePen(k);
                  }
                }}
                onLongPress={() => {
                  haptic.medium();
                  if (isPen && !active) saveFavoritePen(k);
                  else clearFavoritePen(k);
                }}
                delayLongPress={400}
                style={{
                  width: 30,
                  height: 30,
                  margin: 3,
                  borderRadius: 15,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: fp ? fp.color : 'transparent',
                  borderWidth: active ? 2.5 : 1,
                  borderColor: active ? colors.brand : fp ? 'rgba(0,0,0,0.2)' : colors.border,
                  borderStyle: fp ? 'solid' : 'dashed',
                }}
              >
                {fp ? (
                  <Text style={{ fontSize: 10, fontWeight: '800', color: lumOf(fp.color) < 0.5 ? '#FFF' : '#000' }}>
                    {(fp.variant || fp.family).charAt(0).toUpperCase()}
                  </Text>
                ) : (
                  <Ionicons name="add" size={14} color={colors.muted} />
                )}
              </Pressable>
            );
          })}
          <Divider vertical={vertical} />
        </ScrollView>
      </View>
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: paperColor }}>
      {/* Chrome-style tabs row with back arrow inline */}
      {/* Fullscreen means fullscreen: the system bar goes too. */}
      <StatusBar hidden={chrome !== 'normal' || settings.statusBarHidden} />

      {!hideHeader && (
      <View style={{ paddingTop: insets.top, backgroundColor: colors.surfaceSecondary }}>
        <OpenTabsStrip
          currentId={id as string}
          leftSlot={
            <Pressable
              testID="draw-back"
              onPress={() => router.back()}
              style={styles.tabsRowIcon}
              hitSlop={6}
            >
              <Ionicons name="chevron-back" size={24} color={colors.onSurface} />
            </Pressable>
          }
          rightSlot={
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
              <SaveIndicator
                status={saveStatus}
                hasUnsaved={saveStatus === 'pending' || saveStatus === 'error'}
                onRetry={() => { dirtyRef.current = true; void flushSave(); }}
                compact
              />
              <Pressable
                onPress={(e) => {
                  const px = e?.nativeEvent?.pageX;
                  const py = e?.nativeEvent?.pageY;
                  setZoomMenuAnchor({ x: typeof px === 'number' ? px : 0, y: typeof py === 'number' ? py : 60 });
                  setShowZoomMenu(true);
                }}
                onLongPress={() => { haptic.medium(); setPresetNameDraft(''); setSavingPreset(true); }}
                delayLongPress={400}
                testID="draw-zoom-pill"
                style={[styles.zoomPill, { backgroundColor: scale === 1 ? colors.surfaceSecondary : colors.brand }]}
              >
                <Text style={{ color: scale === 1 ? colors.onSurface : colors.onBrandPrimary, fontWeight: '700', fontSize: 12 }}>
                  {Math.round(scale * 100)}%
                </Text>
              </Pressable>
              <Pressable
                onPress={() => { haptic.selection(); setShowPagesPanel(true); }}
                testID="draw-pages-btn"
                style={styles.tabsRowIcon}
                hitSlop={6}
              >
                <Ionicons name="copy-outline" size={20} color={colors.onSurface} />
              </Pressable>
              {rulerEnabled && (
                <Pressable
                  onPress={() => { haptic.selection(); setShowRulerMenu(true); }}
                  testID="draw-ruler-settings-btn"
                  style={styles.tabsRowIcon}
                  hitSlop={6}
                >
                  <MaterialCommunityIcons name="ruler" size={20} color={colors.brand} />
                </Pressable>
              )}
              <Pressable onPress={() => setShowPaperMenu(true)} testID="draw-more" style={styles.tabsRowIcon} hitSlop={6}>
                <Ionicons name="ellipsis-vertical" size={22} color={colors.onSurface} />
              </Pressable>
            </View>
          }
        />
      </View>
      )}

      {!hideToolbar && toolbarPos === 'top' && renderToolbar()}

      {/* Canvas (+ optional left/right toolbars wrapping it) */}
      <View style={{ flex: 1, flexDirection: isVerticalToolbar ? 'row' : 'column' }}>
        {!hideToolbar && toolbarPos === 'left' && renderToolbar()}
        <View
          style={{ flex: 1, backgroundColor: canvasColorHex, overflow: 'hidden' }}
          onLayout={(e) => setViewport({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
        >
          {Platform.OS !== 'web' ? (
            <GestureDetector gesture={finalGesture}>
              <View style={{ flex: 1 }}>
                <Canvas style={StyleSheet.absoluteFill}>
                  <Group transform={[{ translateX: tx }, { translateY: ty }, { scale }]}>
                    {Array.from({ length: pageCount }).map((_, i) => (
                      <Group key={`page-${i}`} transform={[{ translateY: i * pageStrideY }]}>
                        <SkiaPaper
                          type={pageTemplates[i] ?? paper}
                          color={paperColor}
                          lineColor={paperLine}
                          width={pageDims.w}
                          height={basePageH}
                          lineSpacing={lineSpacing}
                        />
                        {/* Imported PDF page, fitted to the paper. */}
                        {pageBackgrounds[i] != null && (() => {
                          const img = imageFor(pageBackgrounds[i] as number);
                          return img ? (
                            <SkiaImage image={img} x={0} y={0} width={pageDims.w} height={basePageH} fit="contain" />
                          ) : null;
                        })()}
                      </Group>
                    ))}
                    {/* Clip strokes & live preview to the page bounds so nothing draws outside */}
                    <Group clip={{ x: 0, y: 0, width: pageDims.w, height: totalPageH }}>
                      {items.map((it, i) => {
                        // While a selection is being dragged it's drawn below,
                        // through the drag matrix, instead of here.
                        if (selXform && selectedIdx.includes(i)) return null;
                        // The text box being edited is shown by the editor instead.
                        if (textEdit && textEdit.index === i) return null;
                        return renderItem(it, `i${i}`);
                      })}
                      {selXform && (
                        <Group matrix={toSkia(selXform)}>
                          {selectedIdx.map((i) => {
                            const it = items[i];
                            if (!it) return null;
                            return renderItem(it, `d${i}`);
                          })}
                        </Group>
                      )}
                      {/* Wet ink. Repaints on its own, without re-rendering
                          this screen or any committed stroke. */}
                      <LiveStrokeLayer ref={liveStrokeRef} />
                      {livePreview}
                      {/* Laser strokes — bright red, ephemeral */}
                      {laserStrokes.map((s) => {
                        if (s.pts.length < 2) return null;
                        const age = Date.now() - s.t0;
                        const alpha = Math.max(0, 1 - age / 2000);
                        const p = buildPathFromPoints(s.pts);
                        return (
                          <Path
                            key={`laser-${s.id}`}
                            path={p}
                            color={`rgba(255, 40, 40, ${alpha.toFixed(2)})`}
                            strokeWidth={4}
                            style="stroke"
                          />
                        );
                      })}
                      {/* Marquee (rect select) preview */}
                      {marquee && (
                        <Path
                          path={(() => {
                            const p = Skia.Path.Make();
                            const x = Math.min(marquee.x1, marquee.x2);
                            const y = Math.min(marquee.y1, marquee.y2);
                            const w = Math.abs(marquee.x2 - marquee.x1);
                            const h = Math.abs(marquee.y2 - marquee.y1);
                            p.addRect({ x, y, width: w, height: h });
                            return p;
                          })()}
                          color={colors.brand}
                          strokeWidth={2 / scale}
                          style="stroke"
                        />
                      )}
                      {/* Lasso preview */}
                      {lassoPath && lassoPath.length > 1 && (
                        <Path
                          path={buildPathFromPoints(lassoPath)}
                          color={colors.brand}
                          strokeWidth={2 / scale}
                          style="stroke"
                        />
                      )}
                    </Group>
                    {/* Where the zoom pad is writing. */}
                    {zoomPad && (
                      <Path
                        path={(() => { const pp = Skia.Path.Make(); pp.addRect({ x: zoomPad.x, y: zoomPad.y, width: zoomPad.w, height: padWindowH }); return pp; })()}
                        color={colors.brand}
                        style="stroke"
                        strokeWidth={2 / scale}
                      />
                    )}
                    {/* Selection box and handles (drawn outside the page clip so
                        handles near the edge stay visible). */}
                    {selBounds && selectedIdx.length > 0 && (() => {
                      const h = selHandles(selBounds, ROTATE_OFFSET / scale);
                      const box = Skia.Path.Make();
                      box.addRect({ x: selBounds.x, y: selBounds.y, width: selBounds.w, height: selBounds.h });
                      const stem = Skia.Path.Make();
                      stem.moveTo(h.rotate.x, selBounds.y);
                      stem.lineTo(h.rotate.x, h.rotate.y);
                      const sw = 1.5 / scale;
                      const r = HANDLE_R / scale / lengthScale(selXform ?? { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
                      return (
                        <Group matrix={selXform ? toSkia(selXform) : undefined}>
                          <Path path={box} color={colors.brand} style="stroke" strokeWidth={sw}>
                            <DashPathEffect intervals={[6 / scale, 4 / scale]} />
                          </Path>
                          <Path path={stem} color={colors.brand} style="stroke" strokeWidth={sw} />
                          {[...h.corners, h.rotate].map((c, k) => (
                            <Group key={`h${k}`}>
                              <Circle cx={c.x} cy={c.y} r={r} color="#FFFFFF" />
                              <Circle cx={c.x} cy={c.y} r={r} color={colors.brand} style="stroke" strokeWidth={sw * 1.4} />
                            </Group>
                          ))}
                        </Group>
                      );
                    })()}
                  </Group>
                </Canvas>
                {/* Native wet ink sits over the Skia canvas. Mounted for the
                    whole session (not just while a pen tool is selected) so
                    switching tools doesn't recreate it; `inkEnabled` gates it,
                    and when off it ignores every touch. */}
                {NativeInkView && settings.nativeInk !== false && (
                  <NativeInkView
                    style={StyleSheet.absoluteFill}
                    inkEnabled={nativeInkActive}
                    mode={nativeMode}
                    accentColor={toAndroidColor(colors.brand)}
                    onSelect={onNativeSelect}
                    tool={tool}
                    inkColor={toAndroidColor(color)}
                    baseWidth={isPenTool(tool) ? widths[tool] : 2}
                    viewTransform={[scale, tx, ty]}
                    pages={[pageDims.w, basePageH, pageStrideY, pageCount]}
                    frontBuffer={settings.frontBufferInk !== false}
                    buttonAction={settings.sPenButton}
                    shapeSnap={settings.shapeSnap !== false}
                    ruler={[rulerEnabled ? 1 : 0, rulerState.x, rulerState.y, rulerState.angle, RULER_H / 2]}
                    cursorWidth={
                      isPenTool(tool)
                        ? effectiveWidth(tool as InkTool, widths[tool])
                        : tool === 'eraser'
                        ? widths.eraser
                        : 0
                    }
                    eraserWidth={widths.eraser}
                    onErase={onNativeErase}
                    onPenButton={onNativePenButton}
                    committedId={nativeCommittedId}
                    onStroke={onNativeStroke}
                  />
                )}
              </View>
            </GestureDetector>
          ) : (
            <View style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}>
              <Ionicons name="brush-outline" size={48} color={colors.brand} />
              <Text style={{ color: colors.onSurface, marginTop: spacing.md, fontWeight: '700' }}>
                Stylus / S Pen canvas
              </Text>
              <Text style={{ color: colors.muted, marginTop: 4, paddingHorizontal: spacing.xl, textAlign: 'center' }}>
                Open this note on Android or iOS in Expo Go to draw with full pressure-aware stylus support.
              </Text>
            </View>
          )}
          {/* Zoom pad: write large here, it lands small in the outlined box on the page. */}
          {zoomPad && NativeInkView && (
            <View
              style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: PAD_H + 44, backgroundColor: colors.surface, borderTopWidth: 1, borderTopColor: colors.divider }}
            >
              <View style={{ height: 44, flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.sm, gap: 4 }}>
                <SelAction icon="chevron-left" label="Back" onPress={() => setZoomPad((zp) => (zp ? advancePad(zp, -1) : zp))} colors={colors} testID="pad-back" />
                <SelAction icon="chevron-right" label="Next" onPress={() => setZoomPad((zp) => (zp ? advancePad(zp, 1) : zp))} colors={colors} testID="pad-next" />
                <SelAction icon="keyboard-return" label="New line" onPress={() => setZoomPad((zp) => (zp ? advancePad(zp, 0) : zp))} colors={colors} testID="pad-newline" />
                <View style={{ flex: 1 }} />
                <SelAction icon="magnify-minus-outline" label="Less" onPress={() => setZoomPad((zp) => (zp ? { ...zp, w: Math.min(pageDims.w, zp.w * 1.25) } : zp))} colors={colors} testID="pad-zoom-out" />
                <SelAction icon="magnify-plus-outline" label="More" onPress={() => setZoomPad((zp) => (zp ? { ...zp, w: Math.max(40, zp.w * 0.8) } : zp))} colors={colors} testID="pad-zoom-in" />
                <SelAction icon="close" label="Close" onPress={() => setZoomPad(null)} colors={colors} testID="pad-close" />
              </View>
              <View style={{ height: PAD_H, overflow: 'hidden', backgroundColor: canvasColorHex }}>
                <Canvas style={StyleSheet.absoluteFill}>
                  <Group transform={[{ translateX: -zoomPad.x * padScale }, { translateY: -zoomPad.y * padScale }, { scale: padScale }]}>
                    {Array.from({ length: pageCount }).map((_, i) => {
                      const top = i * pageStrideY;
                      if (top > zoomPad.y + padWindowH || top + basePageH < zoomPad.y) return null;
                      return (
                        <Group key={`pad-page-${i}`} transform={[{ translateY: top }]}>
                          <SkiaPaper type={pageTemplates[i] ?? paper} color={paperColor} lineColor={paperLine} width={pageDims.w} height={basePageH} lineSpacing={lineSpacing} />
                          {pageBackgrounds[i] != null && (() => {
                            const img = imageFor(pageBackgrounds[i] as number);
                            return img ? <SkiaImage image={img} x={0} y={0} width={pageDims.w} height={basePageH} fit="contain" /> : null;
                          })()}
                        </Group>
                      );
                    })}
                    <Group clip={{ x: 0, y: 0, width: pageDims.w, height: totalPageH }}>
                      {items.map((it, i) => {
                        // Only what's near the window; the rest is off-screen anyway.
                        const hy = itemHomeY(it);
                        if (hy < zoomPad.y - pageStrideY || hy > zoomPad.y + padWindowH + pageStrideY) return null;
                        return renderItem(it, `p${i}`);
                      })}
                    </Group>
                  </Group>
                </Canvas>
                <NativeInkView
                  style={StyleSheet.absoluteFill}
                  inkEnabled={nativeInkActive}
                  mode={nativeInkActive ? 'ink' : 'none'}
                  accentColor={toAndroidColor(colors.brand)}
                  onSelect={() => {}}
                  tool={tool}
                  inkColor={toAndroidColor(color)}
                  baseWidth={isPenTool(tool) ? widths[tool] : 2}
                  viewTransform={[padScale, -zoomPad.x * padScale, -zoomPad.y * padScale]}
                  pages={[pageDims.w, basePageH, pageStrideY, pageCount]}
                  frontBuffer={settings.frontBufferInk !== false}
                  buttonAction={settings.sPenButton}
                  shapeSnap={false}
                  ruler={[0, 0, 0, 0, 0]}
                  cursorWidth={isPenTool(tool) ? effectiveWidth(tool as InkTool, widths[tool]) : 0}
                  eraserWidth={widths.eraser}
                  onErase={onNativeErase}
                  onPenButton={onNativePenButton}
                  committedId={padCommittedId}
                  onStroke={onPadStroke}
                />
              </View>
            </View>
          )}
          {exporting && (
            <View pointerEvents="none" style={{ position: 'absolute', top: 12, alignSelf: 'center', backgroundColor: colors.surface, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <ActivityIndicator color={colors.brand} size="small" />
              <Text style={{ color: colors.onSurface, fontWeight: '600' }}>Exporting…</Text>
            </View>
          )}
          {/* Text box editor, placed over the box on the page at the current zoom. */}
          {textEdit && (
            <View
              style={{
                position: 'absolute',
                left: textEdit.x * scale + tx,
                top: textEdit.y * scale + ty,
                width: Math.max(80, textEdit.w * scale),
              }}
            >
              <TextInput
                testID="text-box-input"
                autoFocus
                multiline
                value={textEdit.text}
                onChangeText={(v) => setTextEdit((t) => (t ? { ...t, text: v } : t))}
                placeholder="Type here"
                placeholderTextColor={colors.muted}
                style={{
                  fontSize: textEdit.fontSize * scale,
                  lineHeight: textEdit.fontSize * scale * 1.2,
                  color: textEdit.color,
                  padding: 0,
                  minHeight: textEdit.fontSize * scale * 1.3,
                  borderWidth: 1,
                  borderStyle: 'dashed',
                  borderColor: colors.brand,
                  backgroundColor: 'rgba(255,255,255,0.35)',
                  textAlignVertical: 'top',
                }}
              />
              <View style={{ flexDirection: 'row', gap: 6, marginTop: 6, alignSelf: 'flex-start', backgroundColor: colors.surface, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 4 }}>
                <SelAction icon="format-font-size-decrease" label="Smaller" onPress={() => setTextEdit((t) => (t ? { ...t, fontSize: Math.max(6, t.fontSize / 1.15) } : t))} colors={colors} testID="text-smaller" />
                <SelAction icon="format-font-size-increase" label="Larger" onPress={() => setTextEdit((t) => (t ? { ...t, fontSize: Math.min(120, t.fontSize * 1.15) } : t))} colors={colors} testID="text-larger" />
                {textEdit.index !== null && (
                  <SelAction icon="trash-can-outline" label="Delete" destructive onPress={() => commitTextEdit(true)} colors={colors} testID="text-delete" />
                )}
                <SelAction icon="check" label="Done" onPress={() => commitTextEdit()} colors={colors} testID="text-done" />
              </View>
            </View>
          )}
          {/* Selection action bar. Scrolls sideways on narrow phones. */}
          {selectedIdx.length > 0 && !selXform && (
            <View
              style={{ position: 'absolute', left: 0, right: 0, bottom: insets.bottom + 12, alignItems: 'center' }}
              pointerEvents="box-none"
            >
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={{ maxWidth: '96%', flexGrow: 0 }}
                contentContainerStyle={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 6,
                  backgroundColor: colors.surface,
                  borderRadius: 999,
                  paddingHorizontal: 10,
                  paddingVertical: 6,
                }}
              >
                <Text style={{ color: colors.muted, fontWeight: '600', marginHorizontal: 4 }}>
                  {selectedIdx.length}
                </Text>
                <SelAction icon="content-copy" label="Copy" onPress={copySelection} colors={colors} testID="sel-copy" />
                <SelAction icon="content-cut" label="Cut" onPress={() => { copySelection(); deleteSelection(); }} colors={colors} testID="sel-cut" />
                <SelAction icon="content-duplicate" label="Duplicate" onPress={duplicateSelection} colors={colors} testID="sel-duplicate" />
                <View style={{ width: 1, height: 22, backgroundColor: colors.divider, marginHorizontal: 2 }} />
                {quickColors.slice(0, 6).map((c, k) => (
                  <Pressable
                    key={`sc${k}`}
                    testID={`sel-color-${k}`}
                    accessibilityLabel={`Recolour selection ${c}`}
                    onPress={() => { haptic.selection(); editSelected((it) => (it.kind === 'image' ? it : ({ ...it, color: c } as Item))); }}
                    style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: c, borderWidth: 1, borderColor: colors.border }}
                  />
                ))}
                <View style={{ width: 1, height: 22, backgroundColor: colors.divider, marginHorizontal: 2 }} />
                <SelAction icon="minus" label="Thinner" onPress={() => editSelected((it) => resizeLine(it, 0.8))} colors={colors} testID="sel-thinner" />
                <SelAction icon="plus" label="Thicker" onPress={() => editSelected((it) => resizeLine(it, 1.25))} colors={colors} testID="sel-thicker" />
                <View style={{ width: 1, height: 22, backgroundColor: colors.divider, marginHorizontal: 2 }} />
                <SelAction icon="trash-can-outline" label="Delete" onPress={() => { haptic.warning(); deleteSelection(); }} colors={colors} destructive testID="sel-delete" />
                <SelAction icon="check" label="Done" onPress={() => setSelectedIdx([])} colors={colors} testID="sel-clear" />
              </ScrollView>
            </View>
          )}
          {/* Paste, offered while the Select tool is active and something is copied. */}
          {selectedIdx.length === 0 && family === 'select' && clipCount > 0 && (
            <View
              style={{ position: 'absolute', left: 0, right: 0, bottom: insets.bottom + 12, alignItems: 'center' }}
              pointerEvents="box-none"
            >
              <View style={{ flexDirection: 'row', backgroundColor: colors.surface, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6 }}>
                <SelAction icon="content-paste" label={`Paste (${clipCount})`} onPress={pasteClipboard} colors={colors} testID="sel-paste" />
              </View>
            </View>
          )}

          {/* Spot laser — small red dot at the current pointer location */}
          {laserSpot && (
            <View
              pointerEvents="none"
              style={{
                position: 'absolute',
                left: laserSpot.x - 12,
                top: laserSpot.y - 12,
                width: 24,
                height: 24,
                borderRadius: 12,
                backgroundColor: 'rgba(255, 40, 40, 0.85)',
                shadowColor: '#FF2828',
                shadowOpacity: 0.8,
                shadowRadius: 12,
                elevation: 8,
              }}
            />
          )}

          {/* Add-page is now triggered by dragging past the last page with resistance (see fingerScrollPan.onEnd). */}
          {overscrollY > 8 && (
            <View
              pointerEvents="none"
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                bottom: Math.max(insets.bottom + 12, overscrollY - 8),
                alignItems: 'center',
                opacity: Math.min(1, overscrollY / 40),
              }}
            >
              <View
                style={{
                  paddingHorizontal: 14,
                  paddingVertical: 8,
                  borderRadius: 20,
                  backgroundColor: colors.surface,
                  borderWidth: 1,
                  borderColor: overscrollY >= 100 ? colors.brand : colors.border,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 6,
                  shadowColor: '#000',
                  shadowOffset: { width: 0, height: 2 },
                  shadowOpacity: 0.18,
                  shadowRadius: 6,
                  elevation: 4,
                }}
              >
                <Ionicons
                  name={overscrollY >= 100 ? 'add-circle' : 'arrow-up-circle-outline'}
                  size={16}
                  color={overscrollY >= 100 ? colors.brand : colors.muted}
                />
                <Text style={{ color: colors.onSurface, fontSize: 12, fontWeight: '600' }}>
                  {overscrollY >= 100 ? 'Release to add page' : 'Pull to add page'}
                </Text>
              </View>
            </View>
          )}

          {/* Ruler overlay — sits above the Skia canvas so it can receive its own gestures. */}
          {rulerEnabled && Platform.OS !== 'web' && (
            <Ruler
              state={rulerState}
              onChange={setRulerState}
              paperScale={scale}
              viewport={viewport}
              colors={{
                brand: colors.brand,
                onSurface: colors.onSurface,
                muted: colors.muted,
                surface: colors.surface,
              }}
              externalGestureRefs={[drawingPanRef, fingerScrollPanRef, twoFingerPanRef]}
              penDownSV={penDownSV}
            />
          )}
          {/* Vertical scroll thumb + page jump buttons removed on user request — page
              scrolling is now handled entirely via 1-finger drag on the paper (and pull-
              to-add-page at the bottom). */}
          {/* Page indicator */}
          {pageCount > 1 && (
            <View
              testID="page-indicator"
              style={{
                position: 'absolute',
                top: spacing.sm,
                right: spacing.sm,
                backgroundColor: colors.surface + 'cc',
                paddingHorizontal: spacing.sm,
                paddingVertical: 4,
                borderRadius: 12,
              }}
            >
              <Text style={{ color: colors.onSurface, fontWeight: '700', fontSize: typeScale.sm }}>
                {Math.min(pageCount, Math.floor(scrollY / Math.max(1, pageStrideY)) + 1)} / {pageCount}
              </Text>
            </View>
          )}
        </View>
        {!hideToolbar && toolbarPos === 'right' && renderToolbar()}
      </View>

      {!hideToolbar && toolbarPos === 'bottom' && renderToolbar()}

      {/* Tool options popover (tap an already-active tool again) — small card anchored near the tap */}
      {/* Escape hatch for immersive/zen.
          Bottom-trailing, not top-left: the top-left corner is where the
          vertical toolbar puts undo/redo, and the button sat on top of them.
          The bottom outer corner is empty in every toolbar position. */}
      {(chrome !== 'normal' || toolbarHidden) && (
        <Pressable
          testID="draw-exit-fullscreen"
          accessibilityRole="button"
          accessibilityLabel="Show toolbars"
          onPress={() => { haptic.selection(); setChrome('normal'); setToolbarHidden(false); }}
          style={{
            position: 'absolute',
            bottom: insets.bottom + 12,
            // Sit on the side AWAY from the toolbar so it never overlaps it.
            ...(toolbarPos === 'right' ? { left: 12 } : { right: 12 }),
            width: 36,
            height: 36,
            borderRadius: 18,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: withAlpha(colors.surface, 0.7),
          }}
          hitSlop={10}
        >
          <Ionicons name="contract-outline" size={18} color={colors.onSurface} />
        </Pressable>
      )}

      <Modal visible={showToolOpts} transparent animationType="fade" onRequestClose={() => { setShowToolOpts(false); setExpandedColors(false); }}>
        <Pressable style={{ flex: 1, backgroundColor: 'transparent' }} onPressIn={() => { setShowToolOpts(false); setExpandedColors(false); }}>
          {(() => {
            const CARD_W = 260;
            // Approximate popup height used only for overflow detection when
            // deciding whether to flip to bottom-align. Actual layout height is
            // whatever React lays out.
            const POPUP_APPROX_H = 340;
            const winW = winWidth;
            const winH = winHeight;
            const TOOLBAR_THICKNESS = 60;
            const GAP = 2;
            const EDGE_MARGIN = 8;
            const positionStyle: any = {};
            if (toolOptAnchor) {
              const rect = toolOptAnchor;
              // Justify the popover with the tool button like MS Word paragraph justification:
              //  - Vertical toolbars (left/right): default TOP-align both edges. Flip to
              //    BOTTOM-align only if popup would overflow the screen bottom.
              //  - Horizontal toolbars (top/bottom): default LEFT-align both edges. Flip to
              //    RIGHT-align only if popup would overflow the screen right.
              if (toolbarPos === 'left') {
                positionStyle.left = TOOLBAR_THICKNESS + GAP;
                const wouldOverflowBottom = rect.y + POPUP_APPROX_H > winH - insets.bottom - EDGE_MARGIN;
                if (wouldOverflowBottom) {
                  // Bottom-align: popup's bottom flush with tool's bottom
                  positionStyle.bottom = Math.max(insets.bottom + EDGE_MARGIN, winH - (rect.y + rect.h));
                } else {
                  positionStyle.top = Math.max(insets.top + EDGE_MARGIN, rect.y);
                }
              } else if (toolbarPos === 'right') {
                positionStyle.right = TOOLBAR_THICKNESS + GAP;
                const wouldOverflowBottom = rect.y + POPUP_APPROX_H > winH - insets.bottom - EDGE_MARGIN;
                if (wouldOverflowBottom) {
                  positionStyle.bottom = Math.max(insets.bottom + EDGE_MARGIN, winH - (rect.y + rect.h));
                } else {
                  positionStyle.top = Math.max(insets.top + EDGE_MARGIN, rect.y);
                }
              } else if (toolbarPos === 'top') {
                positionStyle.top = TOOLBAR_THICKNESS + GAP + insets.top;
                const wouldOverflowRight = rect.x + CARD_W > winW - EDGE_MARGIN;
                if (wouldOverflowRight) {
                  // Right-align: popup's right flush with tool's right
                  positionStyle.right = Math.max(EDGE_MARGIN, winW - (rect.x + rect.w));
                } else {
                  positionStyle.left = Math.max(EDGE_MARGIN, rect.x);
                }
              } else {
                // bottom toolbar
                positionStyle.bottom = TOOLBAR_THICKNESS + GAP + insets.bottom;
                const wouldOverflowRight = rect.x + CARD_W > winW - EDGE_MARGIN;
                if (wouldOverflowRight) {
                  positionStyle.right = Math.max(EDGE_MARGIN, winW - (rect.x + rect.w));
                } else {
                  positionStyle.left = Math.max(EDGE_MARGIN, rect.x);
                }
              }
            } else {
              positionStyle.left = Math.max(EDGE_MARGIN, (winW - CARD_W) / 2);
              positionStyle.bottom = insets.bottom + 110;
            }
            return (
              <Pressable
                testID="tool-opts-card"
                onPress={(e) => e.stopPropagation && e.stopPropagation()}
                style={[
                  styles.toolOptCard,
                  {
                    backgroundColor: colors.surface,
                    ...positionStyle,
                    width: CARD_W,
                    maxHeight: winH - insets.top - insets.bottom - 24,
                    shadowColor: '#000',
                  },
                ]}
              >
              <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 4 }}>
            <Text style={{ color: colors.onSurface, fontSize: typeScale.lg, fontWeight: '700', marginBottom: spacing.sm }}>
              {FAMILY_META[family].label} settings
            </Text>

            {/* Variant chooser — shown only for families with more than one variant. */}
            {FAMILY_VARIANTS[family].length > 1 && (
              <>
                <Text style={{ color: colors.muted, fontSize: typeScale.sm, marginBottom: 6 }}>Type</Text>
                <View style={{ flexDirection: 'row', gap: 6, marginBottom: spacing.md, flexWrap: 'wrap' }}>
                  {FAMILY_VARIANTS[family].map((v) => {
                    const active = variantByFamily[family] === v.key;
                    return (
                      <Pressable
                        key={v.key}
                        testID={`variant-${family}-${v.key}`}
                        onPress={() => { haptic.selection(); applyFamilyVariant(family, v.key); }}
                        style={{
                          flex: 1,
                          minWidth: 100,
                          flexDirection: 'row',
                          alignItems: 'center',
                          justifyContent: 'center',
                          gap: 6,
                          paddingVertical: spacing.sm,
                          paddingHorizontal: spacing.sm,
                          borderRadius: radius.md,
                          backgroundColor: active ? colors.brand : colors.surfaceSecondary,
                        }}
                      >
                        {v.lib === 'mci' ? (
                          <MaterialCommunityIcons name={v.icon} size={16} color={active ? colors.onBrandPrimary : colors.onSurface} />
                        ) : (
                          <Ionicons name={v.icon} size={16} color={active ? colors.onBrandPrimary : colors.onSurface} />
                        )}
                        <Text style={{ color: active ? colors.onBrandPrimary : colors.onSurface, fontSize: typeScale.sm, fontWeight: active ? '700' : '500' }}>
                          {v.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </>
            )}

            {(family === 'select' || family === 'laser') && (
              <View style={{ backgroundColor: colors.surfaceSecondary, padding: spacing.md, borderRadius: radius.md, marginBottom: spacing.md }}>
                <Text style={{ color: colors.muted, fontSize: typeScale.sm, textAlign: 'center' }}>
                  {family === 'select'
                    ? 'Selection is coming soon — the button is here so it matches the final layout.'
                    : 'Laser is coming soon — pointer trails / spot laser will land in the next update.'}
                </Text>
              </View>
            )}

            {family !== 'select' && family !== 'laser' && (
              <>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <Text style={{ color: colors.muted, fontSize: typeScale.sm }}>Thickness</Text>
              <Text style={{ color: colors.onSurface, fontSize: typeScale.sm, fontWeight: '600' }}>
                {(widths[tool] || 3).toFixed(1)} pt
              </Text>
            </View>
            {/* Preview + slider */}
            <View style={{ alignItems: 'center', marginBottom: 4 }}>
              <View
                style={{
                  width: Math.min(40, Math.max(4, widths[tool] || 3) * 2.5),
                  height: Math.min(20, Math.max(1, widths[tool] || 3)),
                  backgroundColor: tool === 'eraser' ? colors.divider : color,
                  borderRadius: 999,
                }}
              />
            </View>
            <ThicknessSlider
              value={widths[tool] || 3}
              min={WIDTH_RANGE[tool].min}
              max={WIDTH_RANGE[tool].max}
              onChange={(v) => setToolWidth(tool, v)}
              trackColor={colors.divider}
              fillColor={colors.brand}
              knobColor={colors.brand}
            />
            <View style={{ height: spacing.md }} />
              </>
            )}

            {family !== 'select' && family !== 'laser' && family !== 'eraser' && (
              <>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <Text style={{ color: colors.muted, fontSize: typeScale.sm }}>Color</Text>
                  {expandedColors ? (
                    <Pressable onPress={() => setExpandedColors(false)} hitSlop={6} testID="opt-collapse-colors">
                      <Text style={{ color: colors.brand, fontSize: typeScale.sm, fontWeight: '600' }}>Less</Text>
                    </Pressable>
                  ) : (
                    <Pressable onPress={() => setExpandedColors(true)} hitSlop={6} testID="opt-more-colors">
                      <Text style={{ color: colors.brand, fontSize: typeScale.sm, fontWeight: '600' }}>More colors…</Text>
                    </Pressable>
                  )}
                </View>

                {expandedColors ? (
                  // Inline full-palette grid (still inside the popover).
                  <View style={{ gap: 3, alignSelf: 'center' }}>
                    {COLOR_GRID.map((row, r) => (
                      <View key={`row-${r}`} style={{ flexDirection: 'row', gap: 3 }}>
                        {row.map((c) => {
                          const selected = c.toLowerCase() === color.toLowerCase();
                          return (
                            <Pressable
                              key={c}
                              testID={`opt-color-${c}`}
                              onPress={() => { haptic.selection(); setColor(c); }}
                              style={{
                                width: 24,
                                height: 24,
                                borderRadius: 4,
                                backgroundColor: c,
                                borderWidth: selected ? 2.5 : 1,
                                borderColor: selected ? colors.brand : 'rgba(0,0,0,0.15)',
                              }}
                            />
                          );
                        })}
                      </View>
                    ))}
                  </View>
                ) : (
                  // Default view: the 4 quick colors as chips (same set as toolbar).
                  <View style={{ flexDirection: 'row', gap: 6, marginBottom: 4 }}>
                    {quickColors.map((c, i) => (
                      <Pressable
                        key={`opt-quick-${i}`}
                        testID={`opt-quick-${i}`}
                        onPress={() => { haptic.selection(); setColor(c); }}
                        style={{
                          width: 22,
                          height: 22,
                          borderRadius: 11,
                          backgroundColor: c,
                          borderWidth: color === c ? 2 : 1,
                          borderColor: color === c ? colors.brand : 'rgba(0,0,0,0.15)',
                        }}
                      />
                    ))}
                  </View>
                )}
              </>
            )}

            {(tool === 'highlighter' || tool === 'marker' || tool === 'pencil') && (
              <Text style={{ color: colors.muted, fontSize: typeScale.sm, marginTop: spacing.md }}>
                {tool === 'highlighter'
                  ? 'Highlighter is rendered at 35% opacity for transparent strokes.'
                  : tool === 'pencil'
                  ? 'Pencil is rendered at 75% opacity to look softer.'
                  : 'Marker is fully opaque.'}
              </Text>
            )}

            {tool === 'eraser' && false && (
              <></>
            )}

            <Pressable
              onPress={() => { setShowToolOpts(false); setExpandedColors(false); }}
              testID="opt-close"
              style={[styles.btn, { backgroundColor: colors.brand, marginTop: spacing.lg }]}
            >
              <Text style={{ color: colors.onBrandPrimary, fontWeight: '700' }}>Done</Text>
            </Pressable>
              </ScrollView>
          </Pressable>
            );
          })()}
        </Pressable>
      </Modal>

      {/* Grid color picker — used both for reassigning quick-color slots (long-press)
          and for a "More…" full palette from the tool popover. */}
      <Modal
        visible={pickerFor !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setPickerFor(null)}
      >
        <Pressable style={styles.backdrop} onPress={() => setPickerFor(null)}>
          <Pressable
            onPress={(e) => e.stopPropagation && e.stopPropagation()}
            style={{
              position: 'absolute',
              // Anchor near the tapped color chip if we have a position; else center-top fallback.
              left: pickerAnchor
                ? Math.max(8, Math.min(winWidth - 240 - 8, pickerAnchor.x - 30))
                : Math.max(8, (winWidth - 240) / 2),
              top: pickerAnchor
                ? Math.max(insets.top + 8, Math.min(winHeight - 380, pickerAnchor.y - 380))
                : winHeight * 0.2,
              width: 240,
              backgroundColor: colors.surface,
              borderRadius: radius.lg,
              padding: spacing.md,
              shadowColor: '#000',
              shadowOffset: { width: 0, height: 6 },
              shadowOpacity: 0.28,
              shadowRadius: 20,
              elevation: 12,
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.md }}>
              <Text style={{ color: colors.onSurface, fontSize: typeScale.lg, fontWeight: '700' }}>
                {pickerFor?.slot !== null && pickerFor?.slot !== undefined ? `Set quick color ${(pickerFor.slot ?? 0) + 1}` : 'Pick color'}
              </Text>
              <Pressable onPress={() => setPickerFor(null)} hitSlop={8} testID="picker-close">
                <Ionicons name="close" size={22} color={colors.muted} />
              </Pressable>
            </View>

            {/* Favorites row (star to pin colors here from the grid via long-press). */}
            {favoriteColors.length > 0 && (
              <>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 4 }}>
                  <Ionicons name="star" size={12} color={colors.brand} />
                  <Text style={{ color: colors.muted, fontSize: typeScale.sm }}>Favorites</Text>
                </View>
                <View style={{ flexDirection: 'row', gap: 3, marginBottom: spacing.sm, flexWrap: 'wrap' }}>
                  {favoriteColors.map((c) => {
                    const selected = c.toLowerCase() === color.toLowerCase();
                    return (
                      <Pressable
                        key={`fav-${c}`}
                        testID={`fav-color-${c}`}
                        onPress={() => {
                          haptic.selection();
                          setColor(c);
                          pushRecentColor(c);
                          if (pickerFor && pickerFor.slot !== null && pickerFor.slot !== undefined) {
                            setQuickColorSlot(pickerFor.slot, c);
                          }
                          setPickerFor(null); setPickerAnchor(null);
                        }}
                        onLongPress={() => { haptic.warning(); toggleFavoriteColor(c); }}
                        delayLongPress={400}
                        style={{
                          width: 22,
                          height: 22,
                          borderRadius: 4,
                          backgroundColor: c,
                          borderWidth: selected ? 2 : 1,
                          borderColor: selected ? colors.brand : 'rgba(0,0,0,0.15)',
                        }}
                      />
                    );
                  })}
                </View>
              </>
            )}

            {/* Recent colors row (only if we have any). */}
            {recentColors.length > 0 && (
              <>
                <Text style={{ color: colors.muted, fontSize: typeScale.sm, marginBottom: 4 }}>Recent</Text>
                <View style={{ flexDirection: 'row', gap: 3, marginBottom: spacing.sm, flexWrap: 'wrap' }}>
                  {recentColors.map((c) => {
                    const selected = c.toLowerCase() === color.toLowerCase();
                    return (
                      <Pressable
                        key={`recent-${c}`}
                        testID={`recent-color-${c}`}
                        onPress={() => {
                          haptic.selection();
                          setColor(c);
                          pushRecentColor(c);
                          if (pickerFor && pickerFor.slot !== null && pickerFor.slot !== undefined) {
                            setQuickColorSlot(pickerFor.slot, c);
                          }
                          setPickerFor(null); setPickerAnchor(null);
                        }}
                        style={{
                          width: 22,
                          height: 22,
                          borderRadius: 4,
                          backgroundColor: c,
                          borderWidth: selected ? 2 : 1,
                          borderColor: selected ? colors.brand : 'rgba(0,0,0,0.15)',
                        }}
                      />
                    );
                  })}
                </View>
              </>
            )}

            {/* Photoshop-style grid: 8 columns × 8 rows (smaller cells) */}
            <View style={{ gap: 3 }}>
              {COLOR_GRID.map((row, r) => (
                <View key={`row-${r}`} style={{ flexDirection: 'row', gap: 3 }}>
                  {row.map((c) => {
                    const selected = c.toLowerCase() === color.toLowerCase();
                    return (
                      <Pressable
                        key={c}
                        testID={`grid-color-${c}`}
                        onPress={() => {
                          haptic.selection();
                          setColor(c);
                          pushRecentColor(c);
                          if (pickerFor && pickerFor.slot !== null && pickerFor.slot !== undefined) {
                            setQuickColorSlot(pickerFor.slot, c);
                          }
                          setPickerFor(null); setPickerAnchor(null);
                        }}
                        style={{
                          width: 22,
                          height: 22,
                          borderRadius: 4,
                          backgroundColor: c,
                          borderWidth: selected ? 2 : 1,
                          borderColor: selected ? colors.brand : 'rgba(0,0,0,0.15)',
                        }}
                      />
                    );
                  })}
                </View>
              ))}
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Ruler quick-settings menu — extracted to its own component so the huge
          draw screen stays readable. Pure view; drawing screen owns all state. */}
      <RulerSettingsMenu
        visible={showRulerMenu}
        onClose={() => setShowRulerMenu(false)}
        rulerState={rulerState}
        onChangeRuler={setRulerState}
        onOpenAngleInput={() => {
          const norm = ((rulerState.angle % 360) + 360) % 360;
          setRulerAngleDraft(String(Math.round(norm)));
          setShowRulerMenu(false);
          setShowRulerAngleInput(true);
        }}
        onHide={() => setRulerEnabled(false)}
        viewport={viewport}
        topOffset={insets.top + 56}
        colors={{
          surface: colors.surface,
          surfaceSecondary: colors.surfaceSecondary,
          onSurface: colors.onSurface,
          onBrandPrimary: colors.onBrandPrimary,
          brand: colors.brand,
          muted: colors.muted,
          divider: colors.divider,
          error: colors.error,
        }}
      />

      {/* Ruler angle — numeric input */}
      <Modal
        visible={showRulerAngleInput}
        transparent
        animationType="fade"
        onRequestClose={() => setShowRulerAngleInput(false)}
      >
        <Pressable
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', alignItems: 'center', justifyContent: 'center' }}
          onPress={() => setShowRulerAngleInput(false)}
        >
          <Pressable
            onPress={(e) => e.stopPropagation && e.stopPropagation()}
            style={{ width: 300, backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.lg }}
          >
            <Text style={{ color: colors.onSurface, fontSize: typeScale.lg, fontWeight: '700', marginBottom: spacing.sm }}>
              Ruler angle
            </Text>
            <Text style={{ color: colors.muted, fontSize: typeScale.sm, marginBottom: spacing.md }}>
              Enter an angle in degrees (0 to 359).
            </Text>
            <TextInput
              value={rulerAngleDraft}
              onChangeText={setRulerAngleDraft}
              keyboardType="numeric"
              placeholder="0"
              placeholderTextColor={colors.muted}
              autoFocus
              style={{
                borderWidth: 1,
                borderColor: colors.border,
                borderRadius: radius.sm,
                padding: spacing.sm,
                color: colors.onSurface,
                marginBottom: spacing.md,
                fontSize: typeScale.base,
              }}
              testID="ruler-angle-input"
            />
            {/* Snap-to quick chips */}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: spacing.md }}>
              {[0, 15, 30, 45, 60, 90, 135, 180, 270].map((deg) => (
                <Pressable
                  key={`snap-${deg}`}
                  onPress={() => setRulerAngleDraft(String(deg))}
                  style={{ paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999, backgroundColor: colors.surfaceSecondary }}
                >
                  <Text style={{ color: colors.onSurface, fontSize: 12, fontWeight: '600' }}>{deg}°</Text>
                </Pressable>
              ))}
            </View>
            <View style={{ flexDirection: 'row', gap: spacing.sm }}>
              <Pressable
                onPress={() => setShowRulerAngleInput(false)}
                style={{ flex: 1, paddingVertical: spacing.sm, borderRadius: radius.sm, backgroundColor: colors.surfaceSecondary, alignItems: 'center' }}
              >
                <Text style={{ color: colors.onSurface }}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  const n = parseFloat(rulerAngleDraft);
                  if (Number.isFinite(n)) {
                    setRulerState((prev) => ({ ...prev, angle: n }));
                  }
                  setShowRulerAngleInput(false);
                }}
                style={{ flex: 1, paddingVertical: spacing.sm, borderRadius: radius.sm, backgroundColor: colors.brand, alignItems: 'center' }}
                testID="ruler-angle-save"
              >
                <Text style={{ color: colors.onBrandPrimary, fontWeight: '700' }}>Set</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Long-press menu for one page: bookmark, duplicate, paper, delete. */}
      <Modal visible={pageMenu !== null} transparent animationType="fade" onRequestClose={() => setPageMenu(null)}>
        <Pressable style={styles.backdrop} onPress={() => setPageMenu(null)}>
          {pageMenu !== null && (
            <Pressable
              onPress={(e) => e.stopPropagation()}
              style={{ alignSelf: 'center', marginTop: '30%', width: 300, backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.md }}
            >
              <Text style={{ color: colors.onSurface, fontWeight: '800', fontSize: typeScale.lg, marginBottom: spacing.sm }}>
                Page {pageMenu + 1}
              </Text>
              <DrawMenuRow
                icon={pageBookmarks[pageMenu] ? 'bookmark' : 'bookmark-outline'}
                label={pageBookmarks[pageMenu] ? 'Remove bookmark' : 'Bookmark'}
                onPress={() => { haptic.selection(); setPageMeta(pageMenu, { bookmark: !pageBookmarks[pageMenu] }); setPageMenu(null); }}
                testID="page-menu-bookmark"
              />
              <DrawMenuRow
                icon="copy-outline"
                label="Duplicate page"
                onPress={() => { duplicatePage(pageMenu); setPageMenu(null); }}
                testID="page-menu-duplicate"
              />
              <Text style={{ color: colors.muted, fontSize: typeScale.sm, fontWeight: '700', marginTop: spacing.sm, marginBottom: 6 }}>
                PAPER FOR THIS PAGE
              </Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                {([null, 'blank', 'ruled', 'narrow', 'grid', 'dotted', 'cornell', 'planner', 'todo', 'engineering', 'graph'] as (Paper | null)[]).map((t) => {
                  const active = (pageTemplates[pageMenu] ?? null) === t;
                  return (
                    <Pressable
                      key={t ?? 'same'}
                      testID={`page-menu-paper-${t ?? 'same'}`}
                      onPress={() => { haptic.selection(); setPageMeta(pageMenu, { template: t }); }}
                      style={{ paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999, backgroundColor: active ? colors.brand : colors.surfaceSecondary }}
                    >
                      <Text style={{ color: active ? colors.onBrandPrimary : colors.onSurface, fontWeight: active ? '700' : '500', fontSize: typeScale.sm }}>
                        {t === null ? 'Same as note' : t.charAt(0).toUpperCase() + t.slice(1)}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              {pageCount > 1 && (
                <View style={{ marginTop: spacing.md }}>
                  <DrawMenuRow
                    icon="trash-outline"
                    label="Delete page"
                    onPress={() => { const i = pageMenu; setPageMenu(null); deletePage(i); }}
                    testID="page-menu-delete"
                  />
                </View>
              )}
            </Pressable>
          )}
        </Pressable>
      </Modal>

      {/* Pages preview panel (slides from right) — thumbnails, reorder, delete, add.
          No dark backdrop — canvas stays visible and interactive to the left of the panel. */}
      <Modal
        visible={showPagesPanel}
        transparent
        animationType="slide"
        onRequestClose={() => setShowPagesPanel(false)}
      >
        <View style={{ flex: 1, flexDirection: 'row' }} pointerEvents="box-none">
          {/* Left click-outside catcher (transparent) — taps close the panel; touches on the canvas
              still work while the panel is open because it's transparent. */}
          <Pressable style={{ flex: 1 }} onPress={() => setShowPagesPanel(false)} />
          {(() => {
            // Panel width scales up when thumbnails are large so we still get 2 columns.
            const panelWidth = Math.min(Math.max(280, 200 + pageThumbSize * 260), winWidth * 0.9);
            const innerPad = spacing.md;
            const innerW = panelWidth - innerPad * 2;
            const gap = 8;
            // Interpolate thumb size: 70 (small) .. 200 (large).
            const thumbW = Math.round(70 + pageThumbSize * 130);
            const thumbH = Math.round((thumbW / Math.max(1, pageDims.w)) * basePageH);
            // Card = thumb + border/padding (~ +16px each side). Column count from available width.
            const cardW = thumbW + 12;
            const cols = Math.max(1, Math.floor((innerW + gap) / (cardW + gap)));
            return (
              <View
                style={{
                  width: panelWidth,
                  height: '100%',
                  backgroundColor: colors.surface,
                  paddingTop: insets.top + spacing.md,
                  paddingBottom: insets.bottom + spacing.md,
                  paddingHorizontal: innerPad,
                  shadowColor: '#000',
                  shadowOffset: { width: -4, height: 0 },
                  shadowOpacity: 0.24,
                  shadowRadius: 12,
                  elevation: 16,
                }}
              >
                {/* Header */}
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.sm }}>
                  <Text style={{ color: colors.onSurface, fontSize: typeScale.lg, fontWeight: '800' }}>
                    Pages ({pageCount})
                  </Text>
                  <Pressable
                    testID="pages-only-marked"
                    accessibilityLabel={onlyMarked ? 'Show all pages' : 'Show bookmarked pages only'}
                    onPress={() => { haptic.selection(); setOnlyMarked((v) => !v); }}
                    hitSlop={8}
                    style={{ marginLeft: 'auto', marginRight: spacing.md }}
                  >
                    <Ionicons name={onlyMarked ? 'bookmark' : 'bookmark-outline'} size={20} color={onlyMarked ? colors.brand : colors.onSurface} />
                  </Pressable>
                  <Pressable onPress={() => setShowPagesPanel(false)} hitSlop={8}>
                    <Ionicons name="close" size={22} color={colors.onSurface} />
                  </Pressable>
                </View>

                {/* Fixed compact thumbnail size — chose to keep 3–4 columns visible. */}

                {/* Grid of thumbnails */}
                <ScrollView
                  style={{ flex: 1 }}
                  contentContainerStyle={{ paddingBottom: spacing.md }}
                  showsVerticalScrollIndicator={false}
                >
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap }}>
                    {Array.from({ length: pageCount }).map((_, i) => {
                      if (onlyMarked && !pageBookmarks[i]) return null;
                      const isCurrent = Math.floor(scrollY / Math.max(1, pageStrideY)) === i;
                      return (
                        <View
                          key={`page-thumb-${i}`}
                          style={{
                            width: cardW,
                            borderRadius: radius.sm,
                            borderWidth: isCurrent ? 2 : 1,
                            borderColor: isCurrent ? colors.brand : colors.border,
                            backgroundColor: colors.surfaceSecondary,
                            padding: 4,
                            alignItems: 'center',
                          }}
                        >
                          <Pressable
                            onPress={() => { jumpToPage(i); setShowPagesPanel(false); }}
                            onLongPress={() => { haptic.medium(); setPageMenu(i); }}
                            delayLongPress={350}
                            style={{
                              width: thumbW,
                              height: thumbH,
                              borderRadius: 3,
                              backgroundColor: paperColor,
                              overflow: 'hidden',
                              marginBottom: 4,
                            }}
                            testID={`page-thumb-${i}`}
                          >
                            {Platform.OS !== 'web' && (
                              <Canvas style={{ flex: 1 }}>
                                {(() => {
                                  const scaleT = thumbW / Math.max(1, pageDims.w);
                                  return (
                                    <Group transform={[{ scale: scaleT }]}>
                                      <SkiaPaper
                                        type={pageTemplates[i] ?? paper}
                                        color={paperColor}
                                        lineColor={paperLine}
                                        width={pageDims.w}
                                        height={basePageH}
                                        lineSpacing={lineSpacing}
                                      />
                                      {pageBackgrounds[i] != null && (() => {
                                        const img = imageFor(pageBackgrounds[i] as number);
                                        return img ? <SkiaImage image={img} x={0} y={0} width={pageDims.w} height={basePageH} fit="contain" /> : null;
                                      })()}
                                      <Group transform={[{ translateY: -i * pageStrideY }]}>
                                        {items
                                          .filter((it) => Math.floor(itemHomeY(it) / pageStrideY) === i)
                                          .map((it, idx) => renderItem(it, `t${i}-${idx}`))}
                                      </Group>
                                    </Group>
                                  );
                                })()}
                              </Canvas>
                            )}
                          </Pressable>
                          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                            <Text style={{ color: colors.onSurface, fontWeight: '700', fontSize: 10 }}>
                              {i + 1}
                              {pageBookmarks[i] ? ' ★' : ''}
                            </Text>
                            <View style={{ flexDirection: 'row' }}>
                              <Pressable
                                onPress={() => movePage(i, -1)}
                                disabled={i === 0}
                                hitSlop={4}
                                style={{ padding: 2, opacity: i === 0 ? 0.3 : 1 }}
                                testID={`page-move-up-${i}`}
                              >
                                <Ionicons name="chevron-back" size={12} color={colors.onSurface} />
                              </Pressable>
                              <Pressable
                                onPress={() => movePage(i, 1)}
                                disabled={i === pageCount - 1}
                                hitSlop={4}
                                style={{ padding: 2, opacity: i === pageCount - 1 ? 0.3 : 1 }}
                                testID={`page-move-down-${i}`}
                              >
                                <Ionicons name="chevron-forward" size={12} color={colors.onSurface} />
                              </Pressable>
                              <Pressable
                                onPress={() => insertPageAfter(i)}
                                hitSlop={4}
                                style={{ padding: 2 }}
                                testID={`page-insert-after-${i}`}
                              >
                                <Ionicons name="add" size={14} color={colors.brand} />
                              </Pressable>
                              <Pressable
                                onPress={() => deletePage(i)}
                                disabled={pageCount <= 1}
                                hitSlop={4}
                                style={{ padding: 2, opacity: pageCount <= 1 ? 0.3 : 1 }}
                                testID={`page-delete-${i}`}
                              >
                                <Ionicons name="trash-outline" size={12} color={colors.error} />
                              </Pressable>
                            </View>
                          </View>
                        </View>
                      );
                    })}

                    {/* Add-page card at the end (same size as thumbnails) */}
                    <Pressable
                      onPress={() => insertPageAfter(pageCount - 1)}
                      style={{
                        width: cardW,
                        borderRadius: radius.sm,
                        borderWidth: 1,
                        borderColor: colors.brand,
                        borderStyle: 'dashed',
                        alignItems: 'center',
                        justifyContent: 'center',
                        padding: 4,
                      }}
                      testID="page-add-at-end"
                    >
                      <View
                        style={{
                          width: thumbW,
                          height: thumbH,
                          borderRadius: 3,
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <Ionicons name="add-circle-outline" size={Math.max(18, thumbW * 0.25)} color={colors.brand} />
                      </View>
                      <Text style={{ color: colors.brand, fontWeight: '700', fontSize: 10, marginTop: 2 }}>Add</Text>
                    </Pressable>
                  </View>
                </ScrollView>
                {/* Column count hint */}
                <Text style={{ color: colors.muted, fontSize: 10, textAlign: 'right', marginTop: 2 }}>
                  {cols} per row
                </Text>
              </View>
            );
          })()}
        </View>
      </Modal>


      {/* Zoom presets menu (tap zoom pill) + save prompt (long-press zoom pill) */}
      <Modal visible={showZoomMenu} transparent animationType="fade" onRequestClose={() => setShowZoomMenu(false)}>
        <Pressable style={{ flex: 1, backgroundColor: 'transparent' }} onPressIn={() => setShowZoomMenu(false)}>
          <Pressable
            onPress={(e) => e.stopPropagation && e.stopPropagation()}
            style={{
              position: 'absolute',
              top: Math.min(winHeight - 300, (zoomMenuAnchor?.y ?? 60) + 16),
              right: 12,
              width: 220,
              backgroundColor: colors.surface,
              borderRadius: radius.md,
              padding: spacing.md,
              shadowColor: '#000',
              shadowOffset: { width: 0, height: 4 },
              shadowOpacity: 0.22,
              shadowRadius: 16,
              elevation: 12,
            }}
          >
            <Text style={{ color: colors.onSurface, fontWeight: '700', fontSize: typeScale.base, marginBottom: spacing.sm }}>
              Zoom
            </Text>
            {[
              { name: 'Fit / 100%', s: 1 },
              { name: '150%', s: 1.5 },
              { name: '200%', s: 2 },
              { name: '300%', s: 3 },
            ].map((p) => (
              <Pressable
                key={`z-${p.name}`}
                onPress={() => { haptic.selection(); setScale(p.s); setShowZoomMenu(false); }}
                style={{ paddingVertical: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}
              >
                <Text style={{ color: colors.onSurface, fontSize: typeScale.sm }}>{p.name}</Text>
                {Math.abs(scale - p.s) < 0.02 && <Ionicons name="checkmark" size={16} color={colors.brand} />}
              </Pressable>
            ))}
            {zoomPresets.length > 0 && (
              <>
                <View style={{ height: 1, backgroundColor: colors.divider, marginVertical: 4 }} />
                <Text style={{ color: colors.muted, fontSize: typeScale.sm, marginTop: 4 }}>SAVED</Text>
                {zoomPresets.map((p) => (
                  <View
                    key={`saved-${p.name}`}
                    style={{ paddingVertical: 6, flexDirection: 'row', alignItems: 'center', gap: 4 }}
                  >
                    <Pressable
                      onPress={() => { haptic.selection(); setScale(p.scale); setShowZoomMenu(false); }}
                      onLongPress={() => { setRenameDraft(p.name); setRenamingPreset(p.name); setShowZoomMenu(false); }}
                      delayLongPress={400}
                      style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 4 }}
                      testID={`preset-${p.name}`}
                    >
                      <Text style={{ color: colors.onSurface, fontSize: typeScale.sm }}>{p.name}</Text>
                      <Text style={{ color: colors.muted, fontSize: typeScale.sm }}>{Math.round(p.scale * 100)}%</Text>
                    </Pressable>
                    <Pressable
                      onPress={() => { setRenameDraft(p.name); setRenamingPreset(p.name); setShowZoomMenu(false); }}
                      hitSlop={8}
                      testID={`preset-rename-${p.name}`}
                      style={{ padding: 4 }}
                    >
                      <Ionicons name="pencil-outline" size={14} color={colors.muted} />
                    </Pressable>
                    <Pressable
                      onPress={() => { haptic.warning(); removePreset(p.name); }}
                      hitSlop={8}
                      testID={`preset-delete-${p.name}`}
                      style={{ padding: 4 }}
                    >
                      <Ionicons name="close" size={16} color={colors.error} />
                    </Pressable>
                  </View>
                ))}
              </>
            )}
            <View style={{ height: 1, backgroundColor: colors.divider, marginVertical: 4 }} />
            <Pressable
              onPress={() => { setShowZoomMenu(false); setPresetNameDraft(''); setSavingPreset(true); }}
              style={{ paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 6 }}
              testID="save-zoom"
            >
              <Ionicons name="bookmark-outline" size={16} color={colors.brand} />
              <Text style={{ color: colors.brand, fontSize: typeScale.sm, fontWeight: '600' }}>
                Save current ({Math.round(scale * 100)}%)
              </Text>
            </Pressable>
            <Text style={{ color: colors.muted, fontSize: 11, marginTop: 6 }}>
              Tap ✎ to rename, ✕ to delete.
            </Text>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Save preset name prompt */}
      <Modal visible={savingPreset} transparent animationType="fade" onRequestClose={() => setSavingPreset(false)}>
        <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', alignItems: 'center', justifyContent: 'center' }} onPress={() => setSavingPreset(false)}>
          <Pressable
            onPress={(e) => e.stopPropagation && e.stopPropagation()}
            style={{ width: 280, backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.lg }}
          >
            <Text style={{ color: colors.onSurface, fontSize: typeScale.lg, fontWeight: '700', marginBottom: spacing.sm }}>
              Save zoom
            </Text>
            <Text style={{ color: colors.muted, fontSize: typeScale.sm, marginBottom: spacing.md }}>
              Save current zoom ({Math.round(scale * 100)}%) as a named preset.
            </Text>
            <TextInput
              value={presetNameDraft}
              onChangeText={setPresetNameDraft}
              placeholder="e.g. Editing, Detail, Draft"
              placeholderTextColor={colors.muted}
              style={{
                borderWidth: 1,
                borderColor: colors.border,
                borderRadius: radius.sm,
                padding: spacing.sm,
                color: colors.onSurface,
                marginBottom: spacing.md,
              }}
            />
            <View style={{ flexDirection: 'row', gap: spacing.sm }}>
              <Pressable
                onPress={() => setSavingPreset(false)}
                style={{ flex: 1, paddingVertical: spacing.sm, borderRadius: radius.sm, backgroundColor: colors.surfaceSecondary, alignItems: 'center' }}
              >
                <Text style={{ color: colors.onSurface }}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={() => { saveCurrentZoomAs(presetNameDraft); setSavingPreset(false); }}
                style={{ flex: 1, paddingVertical: spacing.sm, borderRadius: radius.sm, backgroundColor: colors.brand, alignItems: 'center' }}
              >
                <Text style={{ color: colors.onBrandPrimary, fontWeight: '700' }}>Save</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Rename preset prompt */}
      <Modal
        visible={!!renamingPreset}
        transparent
        animationType="fade"
        onRequestClose={() => { setRenamingPreset(null); setRenameDraft(''); }}
      >
        <Pressable
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', alignItems: 'center', justifyContent: 'center' }}
          onPress={() => { setRenamingPreset(null); setRenameDraft(''); }}
        >
          <Pressable
            onPress={(e) => e.stopPropagation && e.stopPropagation()}
            style={{ width: 280, backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.lg }}
          >
            <Text style={{ color: colors.onSurface, fontSize: typeScale.lg, fontWeight: '700', marginBottom: spacing.sm }}>
              Rename preset
            </Text>
            <Text style={{ color: colors.muted, fontSize: typeScale.sm, marginBottom: spacing.md }}>
              New name for &quot;{renamingPreset}&quot;.
            </Text>
            <TextInput
              value={renameDraft}
              onChangeText={setRenameDraft}
              placeholder="Preset name"
              placeholderTextColor={colors.muted}
              autoFocus
              style={{
                borderWidth: 1,
                borderColor: colors.border,
                borderRadius: radius.sm,
                padding: spacing.sm,
                color: colors.onSurface,
                marginBottom: spacing.md,
              }}
              testID="rename-preset-input"
            />
            <View style={{ flexDirection: 'row', gap: spacing.sm }}>
              <Pressable
                onPress={() => { setRenamingPreset(null); setRenameDraft(''); }}
                style={{ flex: 1, paddingVertical: spacing.sm, borderRadius: radius.sm, backgroundColor: colors.surfaceSecondary, alignItems: 'center' }}
              >
                <Text style={{ color: colors.onSurface }}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  if (renamingPreset) {
                    renamePreset(renamingPreset, renameDraft);
                  }
                  setRenamingPreset(null);
                  setRenameDraft('');
                }}
                style={{ flex: 1, paddingVertical: spacing.sm, borderRadius: radius.sm, backgroundColor: colors.brand, alignItems: 'center' }}
                testID="rename-preset-save"
              >
                <Text style={{ color: colors.onBrandPrimary, fontWeight: '700' }}>Save</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Shape palette */}
      <Modal visible={showToolPalette} transparent animationType="fade" onRequestClose={() => setShowToolPalette(false)}>
        <Pressable style={styles.backdrop} onPress={() => setShowToolPalette(false)}>
          <Pressable style={[styles.sheet, { backgroundColor: colors.surface, paddingBottom: insets.bottom + spacing.lg }]}>
            <View style={styles.sheetHandle} />
            <Text style={{ color: colors.onSurface, fontSize: typeScale.lg, fontWeight: '700', marginBottom: spacing.md }}>
              Shape
            </Text>
            <View style={{ flexDirection: 'row', justifyContent: 'space-around' }}>
              <ShapeOption
                icon="remove-outline"
                label="Line"
                active={tool === 'line'}
                onPress={() => { setTool('line'); setShowToolPalette(false); }}
                testID="shape-line"
              />
              <ShapeOption
                icon="square-outline"
                label="Rectangle"
                active={tool === 'rect'}
                onPress={() => { setTool('rect'); setShowToolPalette(false); }}
                testID="shape-rect"
              />
              <ShapeOption
                icon="ellipse-outline"
                label="Ellipse"
                active={tool === 'ellipse'}
                onPress={() => { setTool('ellipse'); setShowToolPalette(false); }}
                testID="shape-ellipse"
              />
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* More menu — clean iOS-style list, anchored top-right under the kebab */}
      <Modal visible={showPaperMenu} transparent animationType="fade" onRequestClose={() => setShowPaperMenu(false)}>
        <Pressable
          style={styles.backdrop}
          // onPressIn, not onPress: starting a stroke is a drag, and Pressable
          // only fires onPress for a tap that doesn't move. The menu used to
          // stay up while you were already writing underneath it.
          onPressIn={() => setShowPaperMenu(false)}
        >
          <Pressable
            onPress={(e) => e.stopPropagation()}
            style={{
              position: 'absolute',
              top: insets.top + 40,
              // Slide clear of the toolbar when it is docked on the right,
              // otherwise the menu lands directly on top of the tools.
              right: (toolbarPos === 'right' ? VERTICAL_TOOLBAR_W : 0) + 4,
              width: 260,
              maxHeight: '80%',
              backgroundColor: colors.surface,
              borderRadius: radius.md,
              paddingVertical: spacing.sm,
              // Clip to the rounded box. maxHeight alone caps the container but
              // does nothing about children, so the last rows painted outside
              // it once the menu grew past the limit.
              overflow: 'hidden',
              shadowColor: '#000',
              shadowOffset: { width: 0, height: 10 },
              shadowOpacity: 0.22,
              shadowRadius: 24,
              elevation: 16,
            }}
          >
            <ScrollView
              showsVerticalScrollIndicator={false}
              contentContainerStyle={{ paddingBottom: spacing.xs }}
            >
              <Text
                style={{
                  color: colors.muted,
                  fontSize: typeScale.sm,
                  fontWeight: '700',
                  letterSpacing: 1.2,
                  paddingHorizontal: spacing.lg,
                  paddingTop: spacing.sm,
                  paddingBottom: spacing.xs,
                }}
              >
                PAGE
              </Text>
              <DrawMenuRow
                icon="color-palette-outline"
                label="Page color"
                valueSwatch={paperColor}
                onPress={() => { setShowPaperMenu(false); setShowSubColor(true); }}
                testID="draw-menu-color"
              />
              {/* The surface the pages sit on, as distinct from the pages
                  themselves. Previously fixed at #d4d4d4 with no way to change it. */}
              <DrawMenuRow
                icon="color-palette-outline"
                label="Canvas color"
                onPress={() => { setShowPaperMenu(false); setShowSubCanvasColor(true); }}
                testID="draw-menu-canvas-color"
              />
              <DrawMenuRow
                icon={chrome === 'normal' ? 'expand-outline' : 'contract-outline'}
                label="Full screen"
                valueText={chrome === 'normal' ? 'Off' : chrome === 'immersive' ? 'Hide top bars' : 'Hide everything'}
                onPress={() => {
                  haptic.selection();
                  setChrome((c) => (c === 'normal' ? 'immersive' : c === 'immersive' ? 'zen' : 'normal'));
                  setShowPaperMenu(false);
                }}
                testID="draw-menu-fullscreen"
              />
              <DrawMenuRow
                icon={toolbarHidden ? 'eye-outline' : 'eye-off-outline'}
                label="Toolbar"
                valueText={toolbarHidden ? 'Hidden' : 'Shown'}
                onPress={() => {
                  haptic.selection();
                  setToolbarHidden((v) => !v);
                  setShowPaperMenu(false);
                }}
                testID="draw-menu-toolbar-toggle"
              />
              <Text
                style={{
                  color: colors.muted,
                  fontSize: typeScale.sm,
                  fontWeight: '700',
                  letterSpacing: 1.2,
                  paddingHorizontal: spacing.lg,
                  paddingTop: spacing.md,
                  paddingBottom: spacing.xs,
                }}
              >
                SHARE
              </Text>
              <DrawMenuRow
                icon="document-outline"
                label="Export as PDF"
                onPress={() => { void exportNote('pdf'); }}
                testID="draw-menu-export-pdf"
              />
              <DrawMenuRow
                icon="image-outline"
                label="Share this page as image"
                onPress={() => { void exportNote('png'); }}
                testID="draw-menu-export-png"
              />
              {rulerEnabled && (
                <>
                  <DrawMenuRow
                    icon="options-outline"
                    label="Ruler unit"
                    valueText={rulerState.unit === 'cm' ? 'Centimeters' : 'Inches'}
                    onPress={() => setRulerState((prev) => ({ ...prev, unit: prev.unit === 'cm' ? 'in' : 'cm' }))}
                    testID="draw-menu-ruler-unit"
                  />
                  <DrawMenuRow
                    icon="expand-outline"
                    label="Ruler zoom"
                    valueText={rulerState.scaleWithPaper ? 'Scale with paper' : 'True dimensions'}
                    onPress={() => setRulerState((prev) => ({ ...prev, scaleWithPaper: !prev.scaleWithPaper }))}
                    testID="draw-menu-ruler-scale"
                  />
                </>
              )}
              <DrawMenuRow
                icon="grid-outline"
                label="Page template"
                valueText={paper === 'blank' ? 'Blank' : paper.charAt(0).toUpperCase() + paper.slice(1)}
                onPress={() => { setShowPaperMenu(false); setShowSubTemplate(true); }}
                testID="draw-menu-template"
              />
              <DrawMenuRow
                icon="resize-outline"
                label="Page size"
                valueText={paperSize === 'custom' ? 'Custom' : (PAPER_SIZES[paperSize]?.label || 'A4')}
                onPress={() => { setShowPaperMenu(false); setShowSubSize(true); }}
                testID="draw-menu-size"
              />
              {(paper === 'ruled' || paper === 'narrow' || paper === 'grid' || paper === 'dotted' || paper === 'cornell' || paper === 'planner' || paper === 'todo' || paper === 'engineering' || paper === 'graph') && (
                <DrawMenuRow
                  icon="reorder-four-outline"
                  label="Line spacing"
                  valueText={`${lineSpacing ?? 28}px`}
                  onPress={() => { setShowPaperMenu(false); setShowSubSpacing(true); }}
                  testID="draw-menu-spacing"
                />
              )}
              {/* Inline toolbar position picker — 4 options as a segmented row. */}
              <Text
                style={{
                  color: colors.muted,
                  fontSize: typeScale.sm,
                  fontWeight: '600',
                  paddingHorizontal: spacing.lg,
                  paddingTop: spacing.sm,
                  marginBottom: 4,
                }}
              >
                Toolbar position
              </Text>
              <View style={{ flexDirection: 'row', gap: 6, paddingHorizontal: spacing.lg, marginBottom: spacing.sm }}>
                {(['top', 'bottom', 'left', 'right'] as const).map((pos) => {
                  const active = toolbarPos === pos;
                  const icon: any =
                    pos === 'top'    ? 'align-vertical-top' :
                    pos === 'bottom' ? 'align-vertical-bottom' :
                    pos === 'left'   ? 'align-horizontal-left' : 'align-horizontal-right';
                  return (
                    <Pressable
                      key={pos}
                      testID={`toolbar-pos-${pos}`}
                      onPress={() => { haptic.selection(); update({ toolbarPosition: pos }); }}
                      style={{
                        flex: 1,
                        alignItems: 'center',
                        justifyContent: 'center',
                        paddingVertical: 8,
                        borderRadius: radius.sm,
                        backgroundColor: active ? colors.brand : colors.surfaceSecondary,
                      }}
                    >
                      <MaterialCommunityIcons name={icon} size={16} color={active ? colors.onBrandPrimary : colors.onSurface} />
                      <Text style={{ fontSize: 9, color: active ? colors.onBrandPrimary : colors.onSurface, marginTop: 2, fontWeight: '600', textTransform: 'capitalize' }}>
                        {pos}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>

              <View style={{ height: 1, backgroundColor: colors.divider, marginVertical: spacing.sm, marginHorizontal: spacing.lg }} />

              <Text
                style={{
                  color: colors.muted,
                  fontSize: typeScale.sm,
                  fontWeight: '700',
                  letterSpacing: 1.2,
                  paddingHorizontal: spacing.lg,
                  paddingBottom: spacing.xs,
                }}
              >
                NOTE
              </Text>
              <DrawMenuRow
                icon="create-outline"
                label="Rename"
                onPress={(e) => {
                  const t = e?.currentTarget;
                  const commit = (anchor: { x: number; y: number; w: number; h: number } | null) => {
                    setTitleAnchor(anchor);
                    setShowPaperMenu(false);
                    setTitleDraft(note.title);
                    setShowTitleEdit(true);
                  };
                  if (t && typeof t.measureInWindow === 'function') {
                    t.measureInWindow((x: number, y: number, w: number, h: number) => {
                      commit({ x, y, w, h });
                    });
                  } else {
                    commit(null);
                  }
                }}
                testID="draw-menu-rename"
              />
              <DrawMenuRow
                icon="folder-outline"
                label={currentFolder ? `Folder: ${currentFolder.name}` : 'Move to folder'}
                onPress={() => { setShowPaperMenu(false); openFolderPicker(); }}
                testID="draw-menu-folder"
              />
              <DrawMenuRow
                icon="pricetag-outline"
                label={noteLabels.length ? `Labels (${noteLabels.length})` : 'Add labels'}
                onPress={() => { setShowPaperMenu(false); openLabelPicker(); }}
                testID="draw-menu-labels"
              />
              <DrawMenuRow
                icon="settings-outline"
                label="Settings"
                onPress={() => { setShowPaperMenu(false); router.push('/settings'); }}
                testID="draw-menu-settings"
              />
              <DrawMenuRow
                icon="arrow-undo-outline"
                label="Undo"
                onPress={() => { setShowPaperMenu(false); undo(); }}
                testID="draw-menu-undo"
              />
              <DrawMenuRow
                icon="arrow-redo-outline"
                label="Redo"
                onPress={() => { setShowPaperMenu(false); redo(); }}
                testID="draw-menu-redo"
              />
              <DrawMenuRow
                icon="refresh"
                label="Clear canvas"
                onPress={() => { setShowPaperMenu(false); clearAll(); }}
                testID="draw-menu-clear"
              />
              <DrawMenuRow
                icon="trash-outline"
                label="Move to trash"
                destructive
                onPress={() => { setShowPaperMenu(false); exitDelete(); }}
                testID="draw-menu-delete"
              />
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      {/* SUB: Page color */}
      <Modal visible={showSubColor} transparent animationType="fade" onRequestClose={() => setShowSubColor(false)}>
        <Pressable
          style={[styles.backdrop, isWideScreen ? null : { alignItems: 'center', justifyContent: 'center', padding: spacing.lg }]}
          onPressIn={() => setShowSubColor(false)}
        >
          <Pressable
            onPress={(e) => e.stopPropagation()}
            style={{
              width: '100%',
              maxWidth: 420,
              backgroundColor: colors.surface,
              borderRadius: radius.lg,
              padding: spacing.lg,
              shadowColor: '#000',
              shadowOffset: { width: 0, height: 10 },
              shadowOpacity: 0.22,
              shadowRadius: 24,
              elevation: 16,
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: spacing.md }}>
              <Pressable onPress={() => { setShowSubColor(false); setShowPaperMenu(true); }} hitSlop={6}>
                <Ionicons name="chevron-back" size={22} color={colors.onSurface} />
              </Pressable>
              <Text style={{ flex: 1, color: colors.onSurface, fontSize: typeScale.lg, fontWeight: '700', textAlign: 'center', marginRight: 22 }}>
                Page color
              </Text>
            </View>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, justifyContent: 'center' }}>
              {PAPER_COLORS.map((c) => {
                const swatch = c.light;
                const active =
                  paperColorId === c.id ||
                  paperColorId.toLowerCase() === c.light.toLowerCase();
                return (
                  <Pressable
                    key={c.id}
                    onPress={() => { handleSetColor(c.light); haptic.selection(); }}
                    testID={`sub-color-${c.id}`}
                    style={{
                      width: 56,
                      height: 56,
                      borderRadius: 28,
                      backgroundColor: swatch,
                      borderWidth: active ? 3 : 1,
                      borderColor: active ? colors.brand : colors.border,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    {active && <Ionicons name="checkmark" size={22} color={colors.brand} />}
                  </Pressable>
                );
              })}
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* SUB: Canvas color — the surround, not the paper */}
      <Modal visible={showSubCanvasColor} transparent animationType="fade" onRequestClose={() => setShowSubCanvasColor(false)}>
        <Pressable
          style={[styles.backdrop, isWideScreen ? null : { alignItems: 'center', justifyContent: 'center', padding: spacing.lg }]}
          onPressIn={() => setShowSubCanvasColor(false)}
        >
          <Pressable
            onPress={(e) => e.stopPropagation()}
            style={sidePanelStyle('80%')}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: spacing.md }}>
              <Pressable onPress={() => { setShowSubCanvasColor(false); setShowPaperMenu(true); }} hitSlop={6}>
                <Ionicons name="chevron-back" size={22} color={colors.onSurface} />
              </Pressable>
              <Text style={{ flex: 1, color: colors.onSurface, fontSize: typeScale.lg, fontWeight: '700', textAlign: 'center', marginRight: 22 }}>
                Canvas color
              </Text>
            </View>
            <Text style={{ color: colors.muted, fontSize: typeScale.sm, marginBottom: spacing.md, textAlign: 'center' }}>
              The surface your pages sit on.
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, justifyContent: 'center' }}>
              {CANVAS_COLORS.map((c) => {
                const active = canvasColorHex.toLowerCase() === c.hex.toLowerCase();
                return (
                  <Pressable
                    key={c.id}
                    onPress={() => { handleSetCanvasColor(c.hex); haptic.selection(); }}
                    testID={`sub-canvas-${c.id}`}
                    accessibilityLabel={c.label}
                    style={{
                      width: 56,
                      height: 56,
                      borderRadius: 28,
                      backgroundColor: c.hex,
                      borderWidth: active ? 3 : 1,
                      borderColor: active ? colors.brand : colors.border,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    {active && <Ionicons name="checkmark" size={22} color={colors.brand} />}
                  </Pressable>
                );
              })}
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* SUB: Page template */}
      <Modal visible={showSubTemplate} transparent animationType="fade" onRequestClose={() => setShowSubTemplate(false)}>
        <Pressable
          style={[styles.backdrop, isWideScreen ? null : { alignItems: 'center', justifyContent: 'center', padding: spacing.lg }]}
          onPressIn={() => setShowSubTemplate(false)}
        >
          <Pressable
            onPress={(e) => e.stopPropagation()}
            style={sidePanelStyle('80%')}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: spacing.md }}>
              <Pressable onPress={() => { setShowSubTemplate(false); setShowPaperMenu(true); }} hitSlop={6}>
                <Ionicons name="chevron-back" size={22} color={colors.onSurface} />
              </Pressable>
              <Text style={{ flex: 1, color: colors.onSurface, fontSize: typeScale.lg, fontWeight: '700', textAlign: 'center', marginRight: 22 }}>
                Page template
              </Text>
            </View>
            <ScrollView contentContainerStyle={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, justifyContent: 'center' }}>
              {(['blank', 'ruled', 'narrow', 'grid', 'dotted', 'cornell', 'planner', 'todo', 'engineering', 'graph'] as const).map((t) => {
                const active = paper === t;
                return (
                  <Pressable
                    key={t}
                    onPress={() => { handleSetPaper(t); haptic.selection(); }}
                    testID={`sub-template-${t}`}
                    style={{ alignItems: 'center' }}
                  >
                    <View
                      style={{
                        padding: 4,
                        borderRadius: radius.md,
                        backgroundColor: active ? colors.brandTertiary : 'transparent',
                        borderWidth: 2,
                        borderColor: active ? colors.brand : colors.border,
                      }}
                    >
                      <PaperPreview
                        type={t}
                        width={86}
                        height={112}
                        color={paperColor}
                        lineColor={paperLine}
                        borderRadius={6}
                      />
                    </View>
                    <Text
                      style={{
                        marginTop: 6,
                        color: active ? colors.brand : colors.onSurface,
                        fontWeight: active ? '700' : '500',
                        fontSize: typeScale.sm,
                      }}
                    >
                      {t.charAt(0).toUpperCase() + t.slice(1)}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      {/* SUB: Page size */}
      <Modal visible={showSubSize} transparent animationType="fade" onRequestClose={() => setShowSubSize(false)}>
        <Pressable
          style={[styles.backdrop, isWideScreen ? null : { alignItems: 'center', justifyContent: 'center', padding: spacing.lg }]}
          onPressIn={() => setShowSubSize(false)}
        >
          <Pressable
            onPress={(e) => e.stopPropagation()}
            style={{
              width: '100%',
              maxWidth: 420,
              backgroundColor: colors.surface,
              borderRadius: radius.lg,
              padding: spacing.lg,
              shadowColor: '#000',
              shadowOffset: { width: 0, height: 10 },
              shadowOpacity: 0.22,
              shadowRadius: 24,
              elevation: 16,
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: spacing.md }}>
              <Pressable onPress={() => { setShowSubSize(false); setShowPaperMenu(true); }} hitSlop={6}>
                <Ionicons name="chevron-back" size={22} color={colors.onSurface} />
              </Pressable>
              <Text style={{ flex: 1, color: colors.onSurface, fontSize: typeScale.lg, fontWeight: '700', textAlign: 'center', marginRight: 22 }}>
                Page size
              </Text>
            </View>

            {/* Orientation toggle */}
            <View style={{ flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md }}>
              {(['portrait', 'landscape'] as const).map((o) => {
                const active = orientation === o;
                return (
                  <Pressable
                    key={o}
                    testID={`sub-orientation-${o}`}
                    onPress={() => { setOrientation(o); rememberSetup({ orientation: o }); haptic.selection(); }}
                    style={{
                      flex: 1,
                      paddingVertical: spacing.sm,
                      borderRadius: radius.md,
                      alignItems: 'center',
                      flexDirection: 'row',
                      justifyContent: 'center',
                      gap: 6,
                      backgroundColor: active ? colors.brand : colors.surfaceSecondary,
                    }}
                  >
                    <Ionicons
                      name={o === 'portrait' ? 'phone-portrait-outline' : 'phone-landscape-outline'}
                      size={18}
                      color={active ? colors.onBrandPrimary : colors.onSurface}
                    />
                    <Text style={{ color: active ? colors.onBrandPrimary : colors.onSurface, fontWeight: active ? '700' : '500', textTransform: 'capitalize' }}>
                      {o}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            <View style={{ gap: spacing.sm }}>
              {(Object.keys(PAPER_SIZES) as Exclude<PaperSize, 'custom'>[]).map((s) => {
                const active = paperSize === s;
                return (
                  <Pressable
                    key={s}
                    onPress={() => { handleSetSize(s); haptic.selection(); }}
                    testID={`sub-size-${s}`}
                    style={({ pressed }) => ({
                      flexDirection: 'row',
                      alignItems: 'center',
                      padding: spacing.md,
                      borderRadius: radius.md,
                      backgroundColor: active
                        ? colors.brandTertiary
                        : pressed
                        ? colors.surfaceTertiary
                        : colors.surfaceSecondary,
                    })}
                  >
                    <Ionicons
                      name={active ? 'radio-button-on' : 'radio-button-off'}
                      size={20}
                      color={active ? colors.brand : colors.muted}
                    />
                    <Text style={{ flex: 1, marginLeft: spacing.md, fontSize: typeScale.lg, color: colors.onSurface, fontWeight: active ? '700' : '500' }}>
                      {PAPER_SIZES[s].label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* SUB: Line spacing */}
      <Modal visible={showSubSpacing} transparent animationType="fade" onRequestClose={() => setShowSubSpacing(false)}>
        <Pressable
          style={[styles.backdrop, isWideScreen ? null : { alignItems: 'center', justifyContent: 'center', padding: spacing.lg }]}
          onPressIn={() => setShowSubSpacing(false)}
        >
          <Pressable
            onPress={(e) => e.stopPropagation()}
            style={{
              width: '100%',
              maxWidth: 420,
              backgroundColor: colors.surface,
              borderRadius: radius.lg,
              padding: spacing.lg,
              shadowColor: '#000',
              shadowOffset: { width: 0, height: 10 },
              shadowOpacity: 0.22,
              shadowRadius: 24,
              elevation: 16,
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: spacing.md }}>
              <Pressable onPress={() => { setShowSubSpacing(false); setShowPaperMenu(true); }} hitSlop={6}>
                <Ionicons name="chevron-back" size={22} color={colors.onSurface} />
              </Pressable>
              <Text style={{ flex: 1, color: colors.onSurface, fontSize: typeScale.lg, fontWeight: '700', textAlign: 'center', marginRight: 22 }}>
                Line spacing
              </Text>
            </View>
            <View style={{ gap: spacing.sm }}>
              {[
                { val: 16, label: 'Tight' },
                { val: 22, label: 'Narrow' },
                { val: 28, label: 'Normal' },
                { val: 36, label: 'Wide' },
                { val: 48, label: 'X-Wide' },
              ].map((opt) => {
                const active = (lineSpacing ?? 28) === opt.val;
                return (
                  <Pressable
                    key={opt.val}
                    onPress={() => { handleSetLineSpacing(opt.val); haptic.selection(); }}
                    testID={`sub-spacing-${opt.val}`}
                    style={({ pressed }) => ({
                      flexDirection: 'row',
                      alignItems: 'center',
                      padding: spacing.md,
                      borderRadius: radius.md,
                      backgroundColor: active
                        ? colors.brandTertiary
                        : pressed
                        ? colors.surfaceTertiary
                        : colors.surfaceSecondary,
                    })}
                  >
                    <Ionicons
                      name={active ? 'radio-button-on' : 'radio-button-off'}
                      size={20}
                      color={active ? colors.brand : colors.muted}
                    />
                    <Text style={{ flex: 1, marginLeft: spacing.md, fontSize: typeScale.lg, color: colors.onSurface, fontWeight: active ? '700' : '500' }}>
                      {opt.label}
                    </Text>
                    <Text style={{ color: colors.muted, fontSize: typeScale.sm, fontWeight: '600' }}>
                      {opt.val}px
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* SUB: Toolbar position */}
      {/* SUB: Toolbar position (removed — replaced with inline segmented row in the paper menu) */}
      <Modal visible={false} transparent animationType="fade" onRequestClose={() => {}}>
        <View />
      </Modal>

      {/* Rename popover — compact single-line input anchored to the "Rename"
          row in the ⋮ menu, matching the text-editor UX. */}
      <Modal
        visible={showTitleEdit}
        transparent
        animationType="fade"
        onRequestClose={() => setShowTitleEdit(false)}
      >
        <Pressable style={styles.backdrop} onPress={() => setShowTitleEdit(false)}>
          <Pressable
            onPress={(e) => e.stopPropagation && e.stopPropagation()}
            style={{
              position: 'absolute',
              top: titleAnchor
                ? Math.max(insets.top + spacing.sm, titleAnchor.y)
                : insets.top + 56,
              // The ⋮ menu is right-aligned; keep the popover right-aligned too
              // so it lines up perfectly with the "Rename" row's on-screen slot.
              right: 8,
              width: 210,
              maxWidth: '92%' as any,
              backgroundColor: colors.surface,
              paddingHorizontal: spacing.md,
              paddingVertical: spacing.sm,
              borderRadius: radius.md,
              shadowColor: '#000',
              shadowOffset: { width: 0, height: 6 },
              shadowOpacity: 0.22,
              shadowRadius: 16,
              elevation: 12,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <Ionicons name="create-outline" size={18} color={colors.muted} style={{ flexShrink: 0 }} />
            <TextInput
              autoFocus
              value={titleDraft}
              onChangeText={setTitleDraft}
              placeholder="Note title"
              placeholderTextColor={colors.muted}
              style={{
                flex: 1,
                minWidth: 0,
                fontSize: typeScale.base,
                color: colors.onSurface,
                paddingVertical: 6,
                paddingHorizontal: 2,
                borderBottomWidth: 1,
                borderBottomColor: colors.brand,
              }}
              testID="title-input"
              returnKeyType="done"
              onSubmitEditing={updateTitle}
              maxLength={80}
            />
            <Pressable
              onPress={updateTitle}
              testID="title-save"
              hitSlop={6}
              style={{
                width: 30,
                height: 30,
                borderRadius: 15,
                backgroundColor: colors.brand,
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <Ionicons name="checkmark" size={17} color={colors.onBrandPrimary} />
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Folder picker — move this handwritten note into any folder. Mirrors
          the text-editor's Move-to-folder sheet so the behaviour is consistent
          regardless of note type. */}
      <Modal
        visible={showFolderPicker}
        transparent
        animationType="slide"
        onRequestClose={() => setShowFolderPicker(false)}
      >
        <Pressable style={styles.backdrop} onPress={() => setShowFolderPicker(false)}>
          <Pressable
            onPress={(e) => e.stopPropagation && e.stopPropagation()}
            style={sidePanelStyle('70%')}
          >
            <View
              style={{
                // The grab handle is a bottom-sheet affordance; a side panel
                // isn't draggable, so it would be lying about the interaction.
                display: isWideScreen ? 'none' : 'flex',
                width: 44,
                height: 4,
                borderRadius: 2,
                backgroundColor: '#0002',
                alignSelf: 'center',
                marginBottom: spacing.md,
              }}
            />
            <Text style={{ fontSize: typeScale.xl, fontWeight: '700', color: colors.onSurface, marginBottom: spacing.md }}>
              Move to folder
            </Text>
            <ScrollView>
              <Pressable
                testID="draw-folder-none"
                onPress={() => moveNoteToFolder(null)}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  paddingVertical: spacing.md,
                  borderBottomWidth: StyleSheet.hairlineWidth,
                  borderBottomColor: colors.divider,
                }}
              >
                <View style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: colors.muted, marginRight: spacing.md }} />
                <Text style={{ color: colors.onSurface, fontSize: typeScale.lg, flex: 1 }}>No folder</Text>
                {!note.folder_id && <Ionicons name="checkmark" size={18} color={colors.brand} />}
              </Pressable>
              {folderTree.map(({ folder: f, depth }) => (
                <Pressable
                  key={f.id}
                  testID={`draw-folder-pick-${f.id}`}
                  onPress={() => moveNoteToFolder(f.id)}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    paddingVertical: spacing.md,
                    // Indent by nesting depth so the hierarchy is visible.
                    paddingLeft: depth * 18,
                    borderBottomWidth: StyleSheet.hairlineWidth,
                    borderBottomColor: colors.divider,
                  }}
                >
                  {depth > 0 && (
                    <Ionicons
                      name="return-down-forward-outline"
                      size={14}
                      color={colors.muted}
                      style={{ marginRight: 4 }}
                    />
                  )}
                  {/* A folder icon, not a colour dot: the dot matched the label
                      rows elsewhere and said nothing about what the row was. */}
                  <Ionicons name="folder" size={20} color={f.color} style={{ marginRight: spacing.md }} />
                  <Text numberOfLines={1} style={{ color: colors.onSurface, fontSize: typeScale.lg, flex: 1 }}>
                    {f.name}
                  </Text>
                  {note.folder_id === f.id && <Ionicons name="checkmark" size={18} color={colors.brand} />}
                </Pressable>
              ))}
              {folders.length === 0 && (
                <Text style={{ color: colors.muted, textAlign: 'center', marginTop: spacing.lg }}>
                  No folders yet. Create one from the home screen.
                </Text>
              )}
            </ScrollView>
            <Pressable
              onPress={() => setShowFolderPicker(false)}
              testID="draw-folder-picker-done"
              style={{
                marginTop: spacing.md,
                paddingVertical: spacing.md,
                borderRadius: radius.sm,
                backgroundColor: colors.brand,
                alignItems: 'center',
              }}
            >
              <Text style={{ color: colors.onBrandPrimary, fontWeight: '700' }}>Done</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Labels picker — toggle or create labels for this handwritten note. Mirrors
          the text-note editor so behaviour stays consistent across note types. */}
      <Modal
        visible={showLabelPicker}
        transparent
        animationType="slide"
        onRequestClose={() => setShowLabelPicker(false)}
      >
        <Pressable style={styles.backdrop} onPress={() => setShowLabelPicker(false)}>
          <Pressable
            onPress={(e) => e.stopPropagation && e.stopPropagation()}
            style={sidePanelStyle('75%')}
          >
            <View
              style={{
                // The grab handle is a bottom-sheet affordance; a side panel
                // isn't draggable, so it would be lying about the interaction.
                display: isWideScreen ? 'none' : 'flex',
                width: 44,
                height: 4,
                borderRadius: 2,
                backgroundColor: '#0002',
                alignSelf: 'center',
                marginBottom: spacing.md,
              }}
            />
            <Text style={{ fontSize: typeScale.xl, fontWeight: '700', color: colors.onSurface, marginBottom: spacing.md }}>
              Labels
            </Text>
            <View style={{ flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md }}>
              <TextInput
                testID="draw-label-new-input"
                value={labelDraftName}
                onChangeText={setLabelDraftName}
                placeholder="New label name"
                placeholderTextColor={colors.muted}
                style={{
                  flex: 1,
                  height: 44,
                  borderRadius: radius.md,
                  paddingHorizontal: spacing.md,
                  fontSize: typeScale.lg,
                  borderWidth: 1,
                  borderColor: colors.divider,
                  color: colors.onSurface,
                  backgroundColor: colors.surfaceSecondary,
                }}
                returnKeyType="done"
                onSubmitEditing={createLabelFromDraw}
                maxLength={40}
              />
              <Pressable
                testID="draw-label-create-btn"
                onPress={createLabelFromDraw}
                style={{
                  paddingHorizontal: spacing.lg,
                  height: 44,
                  borderRadius: radius.pill,
                  backgroundColor: labelDraftName.trim() ? colors.brand : colors.surfaceSecondary,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
                disabled={!labelDraftName.trim()}
              >
                <Text style={{ color: labelDraftName.trim() ? colors.onBrandPrimary : colors.muted, fontWeight: '700' }}>
                  Create
                </Text>
              </Pressable>
            </View>
            {labels.length === 0 ? (
              <Text style={{ color: colors.muted, textAlign: 'center', marginTop: spacing.lg }}>
                No labels yet. Type a name above and tap Create.
              </Text>
            ) : (
              <ScrollView>
                {labels.map((l) => {
                  const on = (note.label_ids || []).includes(l.id);
                  return (
                    <Pressable
                      key={l.id}
                      testID={`draw-label-toggle-${l.id}`}
                      onPress={() => toggleLabelOnNote(l.id)}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        paddingVertical: spacing.md,
                        borderBottomWidth: StyleSheet.hairlineWidth,
                        borderBottomColor: colors.divider,
                      }}
                    >
                      <View style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: l.color, marginRight: spacing.md }} />
                      <Text style={{ color: colors.onSurface, fontSize: typeScale.lg, flex: 1 }}>{l.name}</Text>
                      <View
                        style={{
                          width: 22,
                          height: 22,
                          borderRadius: 11,
                          borderWidth: 2,
                          borderColor: on ? colors.brand : colors.divider,
                          backgroundColor: on ? colors.brand : 'transparent',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        {on && <Ionicons name="checkmark" size={14} color={colors.onBrandPrimary} />}
                      </View>
                    </Pressable>
                  );
                })}
              </ScrollView>
            )}
            <Pressable
              onPress={() => setShowLabelPicker(false)}
              testID="draw-label-picker-done"
              style={{
                marginTop: spacing.md,
                paddingVertical: spacing.md,
                borderRadius: radius.sm,
                backgroundColor: colors.brand,
                alignItems: 'center',
              }}
            >
              <Text style={{ color: colors.onBrandPrimary, fontWeight: '700' }}>Done</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

// ----- Subcomponents -----
function DrawMenuRow({
  icon,
  label,
  onPress,
  valueText,
  valueSwatch,
  destructive,
  testID,
}: {
  icon: any;
  label: string;
  onPress: (e?: any) => void;
  valueText?: string;
  valueSwatch?: string;
  destructive?: boolean;
  testID?: string;
}) {
  const { colors } = useTheme();
  const tint = destructive ? colors.error : colors.onSurface;
  return (
    <Pressable
      testID={testID}
      onPress={(e) => onPress(e)}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: spacing.md,
        paddingHorizontal: spacing.lg,
        backgroundColor: pressed ? colors.surfaceSecondary : 'transparent',
      })}
    >
      <Ionicons name={icon} size={20} color={tint} />
      <Text style={{ flex: 1, marginLeft: spacing.md, fontSize: typeScale.lg, color: tint, fontWeight: '500' }}>
        {label}
      </Text>
      {valueSwatch ? (
        <View
          style={{
            width: 22,
            height: 22,
            borderRadius: 11,
            backgroundColor: valueSwatch,
            borderWidth: 1,
            borderColor: colors.border,
            marginRight: 6,
          }}
        />
      ) : null}
      {valueText ? (
        <Text style={{ color: colors.muted, fontSize: typeScale.base, marginRight: 6 }}>
          {valueText}
        </Text>
      ) : null}
      {!destructive && <Ionicons name="chevron-forward" size={16} color={colors.muted} />}
    </Pressable>
  );
}


function ThicknessSlider({
  value,
  min,
  max,
  onChange,
  trackColor,
  fillColor,
  knobColor,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  trackColor: string;
  fillColor: string;
  knobColor: string;
}) {
  const [trackW, setTrackW] = useState(200);
  const trackLeftRef = useRef(0); // absolute pageX of the track's left edge, captured once at layout
  const clamp = (v: number) => Math.max(min, Math.min(max, v));
  const pct = Math.max(0, Math.min(1, (value - min) / (max - min)));
  const knobX = pct * trackW;

  // React Native's built-in touch responder — works inside a <Modal>, unlike
  // react-native-gesture-handler. We use absolute `pageX` (not the flaky `locationX`
  // which drifts when the parent re-renders during the drag) and subtract the track's
  // captured left edge to compute a stable position within the track.
  const commit = (pageX: number) => {
    const nx = Math.max(0, Math.min(trackW, pageX - trackLeftRef.current));
    const raw = min + (nx / Math.max(1, trackW)) * (max - min);
    // Round to 0.1 pt precision to prevent tiny sub-pixel jitter from re-triggering renders.
    const rounded = Math.round(raw * 10) / 10;
    if (rounded !== value) onChange(clamp(rounded));
  };

  return (
    <View
      onLayout={(ev) => {
        setTrackW(ev.nativeEvent.layout.width);
      }}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderGrant={(e) => {
        // Capture the track's absolute left edge at the start of the drag so that any
        // subsequent parent re-renders (which move the popover around) don't cause the
        // knob to jump. We derive it from the first touch's pageX minus its locationX.
        trackLeftRef.current = e.nativeEvent.pageX - e.nativeEvent.locationX;
        commit(e.nativeEvent.pageX);
      }}
      onResponderMove={(e) => commit(e.nativeEvent.pageX)}
      onResponderTerminationRequest={() => false}
      style={{ height: 40, justifyContent: 'center', paddingVertical: 8 }}
    >
      <View style={{ height: 4, backgroundColor: trackColor, borderRadius: 2 }} />
      <View style={{ position: 'absolute', left: 0, top: 18, height: 4, width: knobX, backgroundColor: fillColor, borderRadius: 2 }} />
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: Math.max(0, knobX - 12),
          top: 8,
          width: 24,
          height: 24,
          borderRadius: 12,
          backgroundColor: knobColor,
          shadowColor: '#000',
          shadowOpacity: 0.25,
          shadowRadius: 4,
          shadowOffset: { width: 0, height: 2 },
          elevation: 4,
        }}
      />
    </View>
  );
}

function ToolBtn({
  icon,
  label,
  active,
  onPress,
  testID,
  iconLib,
}: {
  icon: any;
  label: string;
  active: boolean;
  onPress: (e?: any) => void;
  testID?: string;
  iconLib?: 'ion' | 'mci';
}) {
  const { colors } = useTheme();
  const IconComp: any = iconLib === 'mci' ? MaterialCommunityIcons : Ionicons;
  return (
    <Pressable
      testID={testID}
      onPress={(e) => {
        haptic.selection();
        onPress(e);
      }}
      style={{
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 6,
        paddingVertical: 4,
        borderRadius: radius.sm,
        backgroundColor: active ? colors.brand : 'transparent',
        minWidth: 44,
      }}
    >
      <IconComp name={icon} size={16} color={active ? colors.onBrandPrimary : colors.onSurface} />
      <Text style={{ fontSize: 9, color: active ? colors.onBrandPrimary : colors.onSurface, marginTop: 1, fontWeight: '600' }}>
        {label}
      </Text>
    </Pressable>
  );
}

function Divider({ vertical }: { vertical?: boolean }) {
  const { colors } = useTheme();
  return (
    <View
      style={
        vertical
          ? { height: 1, width: 20, backgroundColor: colors.divider, marginVertical: 2 }
          : { width: 1, height: 20, backgroundColor: colors.divider, marginHorizontal: 3 }
      }
    />
  );
}

function ShapeOption({
  icon,
  label,
  active,
  onPress,
  testID,
}: {
  icon: any;
  label: string;
  active: boolean;
  onPress: () => void;
  testID?: string;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      style={{
        alignItems: 'center',
        padding: spacing.md,
        borderRadius: radius.md,
        backgroundColor: active ? colors.brandTertiary : colors.surfaceSecondary,
        minWidth: 92,
      }}
    >
      <Ionicons name={icon} size={28} color={active ? colors.brand : colors.onSurface} />
      <Text style={{ marginTop: 4, color: active ? colors.brand : colors.onSurface, fontWeight: '600' }}>{label}</Text>
    </Pressable>
  );
}

function PaperOption({
  type,
  active,
  onPress,
  testID,
}: {
  type: Paper;
  active: boolean;
  onPress: () => void;
  testID?: string;
}) {
  const { colors } = useTheme();
  const labelMap: Record<Paper, string> = {
    blank: 'Blank',
    ruled: 'Ruled',
    narrow: 'Narrow',
    grid: 'Grid',
    dotted: 'Dotted',
    cornell: 'Cornell',
    planner: 'Planner',
    todo: 'To-do',
    engineering: 'Engineering',
    graph: 'Graph',
  };
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      style={{
        width: 78,
        height: 96,
        borderRadius: radius.md,
        borderWidth: active ? 2 : 1,
        borderColor: active ? colors.brand : colors.border,
        overflow: 'hidden',
        backgroundColor: '#FBFAF6',
      }}
    >
      <PaperBackground type={type} color="#FBFAF6" lineColor="#D1CDC2" textColor="#999" />
      <Text
        style={{
          position: 'absolute',
          bottom: 4,
          left: 0,
          right: 0,
          textAlign: 'center',
          fontSize: 11,
          color: active ? colors.brand : '#222',
          fontWeight: '700',
          backgroundColor: '#fff8',
        }}
      >
        {labelMap[type]}
      </Text>
    </Pressable>
  );
}

function PaperFrame({
  size,
  children,
}: {
  size: PaperSize;
  children: React.ReactNode;
}) {
  if (size === 'custom') return <View style={{ flex: 1 }}>{children}</View>;
  const ratio = PAPER_SIZES[size].ratio; // portrait W/H
  // Letterbox so the page maintains its ratio
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.sm }}>
      <View
        style={{
          aspectRatio: ratio,
          maxWidth: '100%',
          maxHeight: '100%',
          width: '100%',
          height: '100%',
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 2 },
          shadowOpacity: 0.15,
          shadowRadius: 6,
          elevation: 4,
        }}
      >
        {children}
      </View>
    </View>
  );
}

function PaperBackground({
  type,
  color,
  lineColor,
  textColor,
}: {
  type: Paper;
  color: string;
  lineColor: string;
  textColor?: string;
}) {
  const base = <View style={[StyleSheet.absoluteFill, { backgroundColor: color }]} />;

  if (type === 'blank') return base;

  const hLines = (top: number, gap: number, count: number) =>
    Array.from({ length: count }).map((_, i) => (
      <View
        key={`h${i}`}
        style={{ position: 'absolute', left: 0, right: 0, top: top + i * gap, height: 1, backgroundColor: lineColor }}
      />
    ));
  const vLines = (left: number, gap: number, count: number) =>
    Array.from({ length: count }).map((_, i) => (
      <View
        key={`v${i}`}
        style={{ position: 'absolute', top: 0, bottom: 0, left: left + i * gap, width: 1, backgroundColor: lineColor }}
      />
    ));

  if (type === 'ruled') {
    return (
      <View style={[StyleSheet.absoluteFill, { backgroundColor: color }]}>{hLines(40, 32, 60)}</View>
    );
  }
  if (type === 'narrow') {
    return (
      <View style={[StyleSheet.absoluteFill, { backgroundColor: color }]}>{hLines(28, 20, 100)}</View>
    );
  }
  if (type === 'grid') {
    return (
      <View style={[StyleSheet.absoluteFill, { backgroundColor: color }]}>
        {hLines(0, 24, 80)}
        {vLines(0, 24, 60)}
      </View>
    );
  }
  if (type === 'dotted') {
    return (
      <View style={[StyleSheet.absoluteFill, { backgroundColor: color }]}>
        {Array.from({ length: 60 }).map((_, r) =>
          Array.from({ length: 40 }).map((__, c) => (
            <View
              key={`d-${r}-${c}`}
              style={{
                position: 'absolute',
                top: 12 + r * 24,
                left: 12 + c * 24,
                width: 2,
                height: 2,
                borderRadius: 1,
                backgroundColor: lineColor,
              }}
            />
          ))
        )}
      </View>
    );
  }
  if (type === 'cornell') {
    return (
      <View style={[StyleSheet.absoluteFill, { backgroundColor: color }]}>
        {hLines(120, 28, 60)}
        {/* Vertical cue column line ~30% from left */}
        <View style={{ position: 'absolute', top: 120, bottom: 80, left: '30%', width: 1.5, backgroundColor: lineColor }} />
        {/* Horizontal summary line near bottom */}
        <View style={{ position: 'absolute', left: 0, right: 0, bottom: 80, height: 1.5, backgroundColor: lineColor }} />
        {/* Header band */}
        <View style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 110, borderBottomWidth: 1, borderBottomColor: lineColor }} />
        <Text style={{ position: 'absolute', top: 16, left: 16, color: textColor || '#888', fontSize: 11, fontWeight: '700' }}>CORNELL</Text>
      </View>
    );
  }
  if (type === 'planner') {
    return (
      <View style={[StyleSheet.absoluteFill, { backgroundColor: color }]}>
        <View style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 90, borderBottomWidth: 1.5, borderBottomColor: lineColor }} />
        <Text style={{ position: 'absolute', top: 24, left: 20, color: textColor || '#888', fontSize: 14, fontWeight: '800' }}>DATE</Text>
        <View style={{ position: 'absolute', top: 50, left: 20, right: 20, height: 1, backgroundColor: lineColor }} />
        {hLines(100, 30, 50)}
      </View>
    );
  }
  // todo
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: color }]}>
      {Array.from({ length: 50 }).map((_, i) => {
        const y = 30 + i * 30;
        return (
          <View key={`t${i}`} style={{ position: 'absolute', left: 0, right: 0, top: y, flexDirection: 'row', alignItems: 'center' }}>
            <View
              style={{
                width: 14,
                height: 14,
                borderRadius: 3,
                borderWidth: 1.2,
                borderColor: lineColor,
                marginLeft: 18,
              }}
            />
            <View style={{ flex: 1, height: 1, backgroundColor: lineColor, marginLeft: 8, marginRight: 12 }} />
          </View>
        );
      })}
    </View>
  );
}

// Apply alpha to a hex color (#RRGGBB or #RRGGBBAA) → returns "#RRGGBBAA"
function applyAlpha(hex: string, alpha: number): string {
  if (alpha >= 0.999) return hex;
  const h = hex.replace('#', '');
  if (h.length < 6) return hex;
  const aa = Math.round(Math.max(0, Math.min(1, alpha)) * 255)
    .toString(16)
    .padStart(2, '0');
  return `#${h.slice(0, 6)}${aa}`;
}

function labelForTool(t: Tool): string {
  switch (t) {
    case 'pen': return 'Pen';
    case 'fountain': return 'Fountain pen';
    case 'marker': return 'Marker';
    case 'highlighter': return 'Highlighter';
    case 'pencil': return 'Pencil';
    case 'fineliner': return 'Fineliner';
    case 'calligraphy': return 'Calligraphy pen';
    case 'brush': return 'Brush';
    case 'eraser': return 'Eraser';
    case 'line': return 'Line';
    case 'rect': return 'Rectangle';
    case 'ellipse': return 'Ellipse';
  }
}

/** One button in the selection bar: icon over a short label. */
function SelAction({
  icon,
  label,
  onPress,
  colors,
  destructive,
  testID,
}: {
  icon: any;
  label: string;
  onPress: () => void;
  colors: any;
  destructive?: boolean;
  testID?: string;
}) {
  const tint = destructive ? colors.error : colors.onSurface;
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      accessibilityLabel={label}
      style={({ pressed }) => ({
        alignItems: 'center',
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: 12,
        backgroundColor: pressed ? colors.surfaceSecondary : 'transparent',
      })}
    >
      <MaterialCommunityIcons name={icon} size={20} color={tint} />
      <Text style={{ color: tint, fontSize: 10, marginTop: 1 }}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  paperSectionTitle: {
    fontSize: typeScale.sm,
    letterSpacing: 1.2,
    fontWeight: '700',
    marginBottom: spacing.sm,
    marginTop: 4,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.xs,
    paddingBottom: spacing.sm,
    gap: 2,
  },
  topIcon: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabsRowIcon: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 18,
  },
  zoomPill: {
    height: 28,
    paddingHorizontal: 10,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: 2,
  },
  toolOptCard: {
    position: 'absolute',
    padding: spacing.md,
    borderRadius: radius.lg,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 12,
    elevation: 8,
  },
  widthBtnLg: {
    width: 64,
    height: 44,
    borderRadius: 12,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toolbar: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: spacing.xs,
  },
  optRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.xs,
  },
  colorDot: {
    width: 22,
    height: 22,
    borderRadius: 11,
  },
  widthBtn: {
    width: 30,
    height: 24,
    borderRadius: 12,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backdrop: { flex: 1, backgroundColor: 'transparent' },
  sheet: {
    position: 'absolute',
    left: 0, right: 0, bottom: 0,
    padding: spacing.lg,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
  },
  sheetHandle: {
    width: 44, height: 4, borderRadius: 2,
    backgroundColor: '#0002', alignSelf: 'center', marginBottom: spacing.md,
  },
  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.md,
    borderRadius: radius.md,
  },
  titleSheet: {
    position: 'absolute',
    left: spacing.lg, right: spacing.lg,
    padding: spacing.lg,
    borderRadius: radius.lg,
  },
  btn: {
    height: 44,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
