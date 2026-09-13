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
  Modal,
  useWindowDimensions,
  StatusBar,
} from 'react-native';
import type { DimensionValue, ViewStyle } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Ruler, { RulerState, rulerProject, rulerEdgeDistance, rulerEdgeSign, rulerContains } from '@/src/components/Ruler';
import RulerSettingsMenu from '@/src/components/RulerSettingsMenu';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { Canvas, Path, Skia, SkPath, Group } from '@shopify/react-native-skia';
import InkStroke from '@/src/ink/InkStroke';
import LiveStrokeLayer, { LiveStrokeHandle } from '@/src/ink/LiveStrokeLayer';
import { InkPoint, InkTool, inkNow, simplify } from '@/src/ink/stroke';
import { buildPreview } from '@/src/ink/preview';
import { StorageKeys } from '@/src/state/storageKeys';
import { GestureDetector, Gesture, PointerType } from 'react-native-gesture-handler';
import { useSharedValue } from 'react-native-reanimated';

import { useTheme } from '@/src/theme/ThemeContext';
import { spacing, radius, typeScale, withAlpha, CANVAS_COLORS } from '@/src/theme/tokens';
import { NotesApi, LabelsApi, FoldersApi, Note, Label, Folder } from '@/src/api/client';
import { useAppSettings, haptic, GestureAction, ToolbarPosition } from '@/src/state/useAppSettings';
import { useOpenTabs } from '@/src/state/useOpenTabs';
import OpenTabsStrip from '@/src/components/OpenTabsStrip';
import SkiaPaper from '@/src/components/SkiaPaper';
import PaperPreview from '@/src/components/PaperPreview';
import SaveIndicator from '@/src/components/SaveIndicator';
import { labelColors } from '@/src/theme/tokens';

// ---------- Types ----------
type PenTool = 'pen' | 'fountain' | 'marker' | 'highlighter' | 'pencil';
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
}
interface ShapeData {
  kind: 'shape';
  tool: ShapeTool;
  color: string;
  width: number;
  start: { x: number; y: number };
  end: { x: number; y: number };
}
type Item = StrokeData | ShapeData;

type Paper = 'blank' | 'ruled' | 'narrow' | 'grid' | 'dotted' | 'cornell' | 'planner' | 'todo';
type PaperSize = 'a4' | 'a5' | 'letter' | 'index' | 'custom';

interface DrawingDoc {
  paper: Paper;
  paperSize?: PaperSize;
  customSize?: { w: number; h: number }; // pixel dimensions used when paperSize === 'custom'
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
  eraser:      { min: 4,   max: 60 },
  line:        { min: 1,   max: 12 },
  rect:        { min: 1,   max: 12 },
  ellipse:     { min: 1,   max: 12 },
};

const DEFAULT_WIDTHS: Record<Tool, number> = {
  pen: 3, fountain: 5, marker: 10, highlighter: 20, pencil: 2, eraser: 24,
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
  pen:    [ { key: 'fountain',  label: 'Fountain',  icon: 'fountain-pen', lib: 'mci' },
            { key: 'ballpoint', label: 'Ballpoint', icon: 'pen',          lib: 'mci' } ],
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
  if (f === 'pen')    return v === 'fountain' ? 'fountain' : 'pen';
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
  const [saving, setSaving] = useState(false);

  // Doc & history
  const [items, setItems] = useState<Item[]>([]);
  const [paper, setPaper] = useState<Paper>('blank');
  const [paperSize, setPaperSize] = useState<PaperSize>('a4');
  const [customSize, setCustomSize] = useState<{ w: number; h: number } | null>(null);
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
  // Imperative handle to the wet-ink layer; see src/ink/LiveStrokeLayer.tsx.
  const liveStrokeRef = useRef<LiveStrokeHandle | null>(null);
  const liveShapeRef = useRef<{ start: Pt; end: Pt } | null>(null);
  const [liveTick, setLiveTick] = useState(0);

  // Save debounce
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ----- Load -----
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setNote(null);
    setItems([]);
    historyRef.current = { undo: [], redo: [] };
    (async () => {
      try {
        const [n, ls, fs] = await Promise.all([
          NotesApi.get(id as string),
          LabelsApi.list().catch(() => [] as Label[]),
          FoldersApi.list().catch(() => [] as Folder[]),
        ]);
        if (cancelled) return;
        setNote(n);
        setLabels(ls);
        setFolders(fs);
        openTab({ id: n.id, title: n.title || 'Untitled', type: 'handwriting' });
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
    return () => { cancelled = true; };
  }, [id]);

  // ----- Persist (debounced) -----
  const persist = useCallback(
    (
      nextItems: Item[],
      nextPaper: Paper,
      nextSize: PaperSize,
      nextColor: string,
      nextTitle?: string,
      _reserved?: undefined,
      // Passed explicitly by handleSetCanvasColor: React state updates are not
      // synchronous, so reading canvasColorHex from the closure here would
      // write the PREVIOUS colour.
      nextCanvasColor?: string
    ) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(async () => {
        try {
          setSaving(true);
          const body: Partial<Note> = {
            // A small, bounded render for the notes list, so the list endpoint
            // never has to ship the full document. See src/ink/preview.ts.
            preview: buildPreview(nextItems as any[], pageDims.w, basePageH, nextPaper),
            drawing_data: JSON.stringify({
              paper: nextPaper,
              paperSize: nextSize,
              customSize: customSize ?? undefined,
              orientation,
              paperColor: nextColor,
              canvasColor: nextCanvasColor ?? canvasColorHex,
              lineSpacing,
              pageCount,
              docVersion: 3,
              items: nextItems,
            } as DrawingDoc),
            note_type: 'handwriting',
          };
          if (typeof nextTitle === 'string') body.title = nextTitle;
          await NotesApi.update(id as string, body);
        } catch (e) {
          console.warn('save', e);
        } finally {
          setSaving(false);
        }
      }, 500);
    },
    [id, canvasColorHex, lineSpacing, customSize, pageCount, orientation]
  );

  // Persist when pageCount changes (debounced via persist())
  useEffect(() => {
    if (!loading && note) {
      persist(items, paper, paperSize, paperColorId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageCount, orientation]);

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
    t === 'pen' || t === 'fountain' || t === 'marker' || t === 'highlighter' || t === 'pencil';

  const finalizeStroke = (pts: InkPoint[]) => {
    if (pts.length < 2 || !isPenTool(tool)) return;
    const w = widths[tool];
    // Simplify once, on commit. This is where redundant samples are removed,
    // measured against real shape and pressure error rather than a fixed
    // distance threshold, so corners and width modulation survive while the
    // stored document shrinks by roughly an order of magnitude.
    const points = simplify(pts);
    const stroke: StrokeData = {
      kind: 'stroke',
      tool,
      color,
      width: w,
      points,
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

  const eraseAt = (x: number, y: number) => {
    const radius = widths.eraser / 2;
    setItems((prev) => {
      let changed = false;
      const nextItems: Item[] = [];
      for (const it of prev) {
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
        } else {
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
        }
      }
      if (changed) {
        pushHistory(prev);
        persist(nextItems, paper, paperSize, paperColorId);
      }
      return changed ? nextItems : prev;
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
    .onEnd(() => runGestureAction(settings.gestureTwoFingerTap));

  const threeTap = Gesture.Tap()
    .runOnJS(true)
    .numberOfTaps(1)
    .minPointers(3)
    .onEnd(() => runGestureAction(settings.gestureThreeFingerTap));

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
      if (palmRejectionRef.current && !isStylusRef.current) {
        livePtsRef.current = [];
        liveShapeRef.current = null;
        clearLive();
        return;
      }
      // Ruler snap: if the pen begins near the ruler edge, project this stroke onto it.
      snapToRulerRef.current = false;
      if (rulerEnabled) {
        const proj = rulerSnapWorld(e.x, e.y);
        if (proj) {
          snapToRulerRef.current = true;
          const w = toWorld(proj.x, proj.y);
          if (isPenTool(tool)) {
            livePtsRef.current = [{ x: w.x, y: w.y, t: inkNow(), p: stylusPressure(e) }];
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
        livePtsRef.current = [{ x: w.x, y: w.y, t: inkNow(), p: stylusPressure(e) }];
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
        const last = livePtsRef.current[livePtsRef.current.length - 1];
        if (!last) return;
        const d = Math.hypot(w.x - last.x, w.y - last.y);
        // A much finer gate than the old `1.2 / scale`. That threshold threw
        // away most of the samples in small handwriting and captured different
        // amounts of detail depending on the zoom level the person happened to
        // be at. Redundant points are removed properly at commit time by the
        // simplification pass, which measures actual shape error.
        if (d < MIN_SAMPLE_DISTANCE) return;
        livePtsRef.current.push({
          x: w.x,
          y: w.y,
          // Sub-millisecond clock: Date.now() cannot resolve 120 Hz sampling,
          // so the old velocity model was reading quantisation noise.
          t: inkNow(),
          p: stylusPressure(e),
        });
        pushLive();
      } else if (isShapeTool(tool) && liveShapeRef.current) {
        liveShapeRef.current.end = { x: w.x, y: w.y, t: inkNow() };
        setLiveTick((n) => n + 1);
      } else if (tool === 'eraser') {
        eraseAt(w.x, w.y);
      }
    })
    .onEnd(() => {
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
        const hit: number[] = [];
        items.forEach((it, idx) => {
          const pts: { x: number; y: number }[] =
            it.kind === 'stroke'
              ? it.points
              : [it.start, it.end, { x: it.start.x, y: it.end.y }, { x: it.end.x, y: it.start.y }];
          if (pts.some((p) => inside(p.x, p.y))) hit.push(idx);
        });
        setSelectedIdx(hit);
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
    />
  );

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

  const handleSetPaper = (p: Paper) => {
    setPaper(p);
    persist(items, p, paperSize, paperColorId);
  };
  const handleSetSize = (s: PaperSize) => {
    setPaperSize(s);
    persist(items, paper, s, paperColorId);
  };
  const handleSetColor = (c: string) => {
    setPaperColorId(c);
    persist(items, paper, paperSize, c);
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
        if (it.kind === 'stroke') {
          const home = Math.floor((it.points[0]?.y ?? 0) / pageStrideY);
          if (home === pageIdx) continue; // drop
          if (home > pageIdx) {
            next.push({ ...it, points: it.points.map((p) => ({ ...p, y: p.y - pageStrideY })) });
          } else {
            next.push(it);
          }
        } else {
          const home = Math.floor(it.start.y / pageStrideY);
          if (home === pageIdx) continue;
          if (home > pageIdx) {
            next.push({
              ...it,
              start: { x: it.start.x, y: it.start.y - pageStrideY },
              end: { x: it.end.x, y: it.end.y - pageStrideY },
            });
          } else {
            next.push(it);
          }
        }
      }
      persist(next, paper, paperSize, paperColorId);
      return next;
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
        if (it.kind === 'stroke') {
          const home = Math.floor((it.points[0]?.y ?? 0) / pageStrideY);
          if (home === a) return { ...it, points: it.points.map((p) => ({ ...p, y: p.y + delta })) };
          if (home === b) return { ...it, points: it.points.map((p) => ({ ...p, y: p.y - delta })) };
          return it;
        }
        const home = Math.floor(it.start.y / pageStrideY);
        if (home === a) return { ...it, start: { ...it.start, y: it.start.y + delta }, end: { ...it.end, y: it.end.y + delta } };
        if (home === b) return { ...it, start: { ...it.start, y: it.start.y - delta }, end: { ...it.end, y: it.end.y - delta } };
        return it;
      });
      persist(next, paper, paperSize, paperColorId);
      return next;
    });
  }, [pageCount, pageStrideY, paper, paperSize, paperColorId, persist]);

  const insertPageAfter = useCallback((pageIdx: number) => {
    haptic.success();
    const boundary = (pageIdx + 1) * pageStrideY;
    setItems((prev) => {
      pushHistory(prev);
      const next = prev.map((it) => {
        if (it.kind === 'stroke') {
          return {
            ...it,
            points: it.points.map((p) => (p.y >= boundary ? { ...p, y: p.y + pageStrideY } : p)),
          };
        }
        return {
          ...it,
          start: { x: it.start.x, y: it.start.y >= boundary ? it.start.y + pageStrideY : it.start.y },
          end: { x: it.end.x, y: it.end.y >= boundary ? it.end.y + pageStrideY : it.end.y },
        };
      });
      persist(next, paper, paperSize, paperColorId);
      return next;
    });
    setPageCount((c) => c + 1);
  }, [pageStrideY, paper, paperSize, paperColorId, persist]);

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
                status={saving ? 'saving' : 'saved'}
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
                          type={paper}
                          color={paperColor}
                          lineColor={paperLine}
                          width={pageDims.w}
                          height={basePageH}
                          lineSpacing={lineSpacing}
                        />
                      </Group>
                    ))}
                    {/* Clip strokes & live preview to the page bounds so nothing draws outside */}
                    <Group clip={{ x: 0, y: 0, width: pageDims.w, height: totalPageH }}>
                      {items.map((it, i) => {
                        const el = it.kind === 'stroke' ? renderStroke(it, `s${i}`) : renderShape(it, `sh${i}`);
                        const isSelected = selectedIdx.includes(i);
                        if (!isSelected) return el;
                        // Highlight overlay for selected items.
                        return (
                          <Group key={`sel-${i}`}>
                            {el}
                          </Group>
                        );
                      })}
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
                  </Group>
                </Canvas>
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
          {/* Selection action bar — shown when the user has one or more items selected. */}
          {selectedIdx.length > 0 && (
            <View
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                bottom: insets.bottom + 12,
                alignItems: 'center',
              }}
              pointerEvents="box-none"
            >
              <View style={{ flexDirection: 'row', gap: 8, backgroundColor: colors.surface, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 8, shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 8, elevation: 6 }}>
                <Text style={{ color: colors.onSurface, fontWeight: '600', alignSelf: 'center', marginRight: 4 }}>
                  {selectedIdx.length} selected
                </Text>
                <Pressable
                  testID="sel-delete"
                  onPress={() => {
                    haptic.warning();
                    setItems((prev) => {
                      pushHistory(prev);
                      const next = prev.filter((_, idx) => !selectedIdx.includes(idx));
                      persist(next, paper, paperSize, paperColorId);
                      return next;
                    });
                    setSelectedIdx([]);
                  }}
                  style={{ paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999, backgroundColor: colors.error }}
                >
                  <Text style={{ color: '#FFF', fontWeight: '600' }}>Delete</Text>
                </Pressable>
                <Pressable
                  testID="sel-clear"
                  onPress={() => setSelectedIdx([])}
                  style={{ paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999, backgroundColor: colors.surfaceSecondary }}
                >
                  <Text style={{ color: colors.onSurface, fontWeight: '600' }}>Clear</Text>
                </Pressable>
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
                                        type={paper}
                                        color={paperColor}
                                        lineColor={paperLine}
                                        width={pageDims.w}
                                        height={basePageH}
                                        lineSpacing={lineSpacing}
                                      />
                                      <Group transform={[{ translateY: -i * pageStrideY }]}>
                                        {items
                                          .filter((it) => {
                                            const yy = it.kind === 'stroke' ? (it.points[0]?.y ?? 0) : it.start.y;
                                            return Math.floor(yy / pageStrideY) === i;
                                          })
                                          .map((it, idx) =>
                                            it.kind === 'stroke' ? renderStroke(it, `t${i}-s${idx}`) : renderShape(it, `t${i}-sh${idx}`)
                                          )}
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
              shadowColor: '#000',
              shadowOffset: { width: 0, height: 10 },
              shadowOpacity: 0.22,
              shadowRadius: 24,
              elevation: 16,
            }}
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
            {(paper === 'ruled' || paper === 'narrow' || paper === 'grid' || paper === 'dotted' || paper === 'cornell' || paper === 'planner' || paper === 'todo') && (
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
              {(['blank', 'ruled', 'narrow', 'grid', 'dotted', 'cornell', 'planner', 'todo'] as const).map((t) => {
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
                    onPress={() => { setOrientation(o); haptic.selection(); }}
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
              {folders.map((f) => (
                <Pressable
                  key={f.id}
                  testID={`draw-folder-pick-${f.id}`}
                  onPress={() => moveNoteToFolder(f.id)}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    paddingVertical: spacing.md,
                    borderBottomWidth: StyleSheet.hairlineWidth,
                    borderBottomColor: colors.divider,
                  }}
                >
                  <View style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: f.color, marginRight: spacing.md }} />
                  <Text style={{ color: colors.onSurface, fontSize: typeScale.lg, flex: 1 }}>{f.name}</Text>
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
    case 'eraser': return 'Eraser';
    case 'line': return 'Line';
    case 'rect': return 'Rectangle';
    case 'ellipse': return 'Ellipse';
  }
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
