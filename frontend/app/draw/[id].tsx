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
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Canvas, Path, Skia, SkPath, Group } from '@shopify/react-native-skia';
import { GestureDetector, Gesture } from 'react-native-gesture-handler';
import { useSharedValue } from 'react-native-reanimated';

import { useTheme } from '@/src/theme/ThemeContext';
import { spacing, radius, typeScale } from '@/src/theme/tokens';
import { NotesApi, Note } from '@/src/api/client';
import { useAppSettings, haptic, GestureAction, ToolbarPosition } from '@/src/state/useAppSettings';
import { useOpenTabs } from '@/src/state/useOpenTabs';
import OpenTabsStrip from '@/src/components/OpenTabsStrip';
import SkiaPaper from '@/src/components/SkiaPaper';
import PaperPreview from '@/src/components/PaperPreview';

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
  points: { x: number; y: number; t?: number }[];
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
type PaperSize = 'fit' | 'a4' | 'a5' | 'letter' | 'index' | 'custom';

interface DrawingDoc {
  paper: Paper;
  paperSize?: PaperSize;
  customSize?: { w: number; h: number }; // pixel dimensions used when paperSize === 'custom'
  orientation?: 'portrait' | 'landscape';
  paperColor?: string;
  canvasColor?: string;
  lineSpacing?: number; // pixel spacing for ruled / grid / dotted templates
  pageCount?: number;   // number of stacked pages in this note
  items: Item[];
}

// Ratio = width / height of the page in PORTRAIT
const PAPER_SIZES: Record<Exclude<PaperSize, 'custom'>, { ratio: number; label: string }> = {
  fit:    { ratio: 0,      label: 'Fit screen' }, // 0 = fill
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
const PALETTE = ['#1A1A1C', '#FFFFFF', '#B85C5C', '#D4A352', '#7B8C73', '#6E7A8A', '#8B7AA8', '#638C61'];
const WIDTHS: Record<PenTool | 'eraser' | ShapeTool, [number, number, number]> = {
  pen: [2, 4, 7],
  fountain: [3, 6, 10],
  marker: [8, 14, 22],
  highlighter: [16, 24, 32],
  pencil: [1.5, 3, 5],
  eraser: [16, 30, 60],
  line: [2, 4, 6],
  rect: [2, 4, 6],
  ellipse: [2, 4, 6],
};

// ---------- Helpers ----------
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

  const [note, setNote] = useState<Note | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Doc & history
  const [items, setItems] = useState<Item[]>([]);
  const [paper, setPaper] = useState<Paper>('blank');
  const [paperSize, setPaperSize] = useState<PaperSize>('fit');
  const [customSize, setCustomSize] = useState<{ w: number; h: number } | null>(null);
  const [orientation, setOrientation] = useState<'portrait' | 'landscape'>('portrait');
  const [paperColorId, setPaperColorId] = useState<string>('white');
  const [lineSpacing, setLineSpacing] = useState<number | undefined>(undefined);
  const [canvasColorHex, setCanvasColorHex] = useState<string>('#d4d4d4');
  // Viewport = the actual on-screen container size. pageDims = the effective page size,
  // derived from paperSize / orientation / customSize (fitting into viewport width).
  const [viewport, setViewport] = useState<{ w: number; h: number }>({ w: 1024, h: 1366 });
  const pageDims = useMemo<{ w: number; h: number }>(() => {
    if (viewport.w <= 0 || viewport.h <= 0) return { w: 1024, h: 1366 };
    if (paperSize === 'fit') return viewport;
    // ratio = width / height in the current orientation
    let ratio: number;
    if (paperSize === 'custom' && customSize) {
      ratio = customSize.w / Math.max(1, customSize.h);
    } else if (paperSize !== 'custom') {
      // PAPER_SIZES.ratio is always the PORTRAIT ratio (w/h). Flip for landscape.
      const portraitRatio = PAPER_SIZES[paperSize].ratio;
      ratio = orientation === 'landscape' ? 1 / portraitRatio : portraitRatio;
    } else {
      return viewport;
    }
    // Fit width to viewport, derive height. For very-wide (landscape) papers we cap by height too.
    let w = viewport.w;
    let h = w / ratio;
    if (h > viewport.h * 3) {
      // extremely tall (would swamp scroll) — cap
      h = viewport.h * 3;
      w = h * ratio;
    }
    return { w, h };
  }, [viewport.w, viewport.h, paperSize, customSize, orientation]);
  const historyRef = useRef<{ undo: Item[][]; redo: Item[][] }>({ undo: [], redo: [] });

  // Tool state
  const [tool, setTool] = useState<Tool>('pen');
  const [color, setColor] = useState<string>('#1A1A1C');
  const [widthIdx, setWidthIdx] = useState<0 | 1 | 2>(1);
  const [showPaperMenu, setShowPaperMenu] = useState(false);
  // Sub-menus opened from the main kebab menu
  const [showSubColor, setShowSubColor] = useState(false);
  const [showSubTemplate, setShowSubTemplate] = useState(false);
  const [showSubSize, setShowSubSize] = useState(false);
  const [showSubSpacing, setShowSubSpacing] = useState(false);
  const [showSubToolbar, setShowSubToolbar] = useState(false);
  const [showToolPalette, setShowToolPalette] = useState(false);
  const [showToolOpts, setShowToolOpts] = useState(false);
  const [showTitleEdit, setShowTitleEdit] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');

  // Zoom (panning removed) — translation is derived to keep canvas centered while zooming.
  const [scale, setScale] = useState(1);
  const [scrollY, setScrollY] = useState(0); // vertical scroll across multi-page canvas
  const scrollYStartRef = useRef(0);
  const scaleStartRef = useRef(1);
  const MAX_SCALE = 16;
  const MIN_SCALE = 0.5;

  // Multi-page support
  const [pageCount, setPageCount] = useState(1);

  // Derived translation so the canvas center stays pinned to the screen center at any scale,
  // plus the user's vertical scroll offset across pages.
  const basePageH = pageDims.h;
  const totalPageH = basePageH * pageCount;
  // Derived translation. Horizontal: pin the page center to the viewport center at any scale.
  // Vertical: pin the *top* of the page to the top of the viewport (adjusted by user scroll).
  // This prevents the paper from drifting down and leaving empty space above when zooming out.
  const centerOffsetX = Math.max(0, (viewport.w - pageDims.w) / 2);
  const tx = centerOffsetX + (pageDims.w / 2) * (1 - scale);
  const ty = -scrollY * scale;

  // App settings (haptics + gestures + toolbar)
  const { settings, update } = useAppSettings();
  const toolbarPos: ToolbarPosition = settings.toolbarPosition || 'left';
  const isVerticalToolbar = toolbarPos === 'left' || toolbarPos === 'right';
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
  const livePtsRef = useRef<{ x: number; y: number; t: number }[]>([]);
  const liveShapeRef = useRef<{ start: Pt; end: Pt } | null>(null);
  const [liveTick, setLiveTick] = useState(0);

  // Save debounce
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ----- Load -----
  useEffect(() => {
    (async () => {
      try {
        const n = await NotesApi.get(id as string);
        setNote(n);
        openTab({ id: n.id, title: n.title || 'Untitled', type: 'handwriting' });
        if (n.drawing_data) {
          try {
            const doc: DrawingDoc = JSON.parse(n.drawing_data);
            setItems(doc.items || []);
            setPaper(doc.paper || 'blank');
            if (doc.paperSize) setPaperSize(doc.paperSize);
            if (doc.customSize) setCustomSize(doc.customSize);
            if (doc.orientation) setOrientation(doc.orientation);
            if (doc.paperColor) setPaperColorId(doc.paperColor);
            if (doc.canvasColor) setCanvasColorHex(doc.canvasColor);
            if (typeof doc.lineSpacing === 'number') setLineSpacing(doc.lineSpacing);
            if (typeof doc.pageCount === 'number') setPageCount(Math.max(1, doc.pageCount));
          } catch {}
        }
      } catch (e) {
        console.warn(e);
      } finally {
        setLoading(false);
      }
    })();
  }, [id]);

  // ----- Persist (debounced) -----
  const persist = useCallback(
    (nextItems: Item[], nextPaper: Paper, nextSize: PaperSize, nextColor: string, nextTitle?: string) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(async () => {
        try {
          setSaving(true);
          const body: Partial<Note> = {
            drawing_data: JSON.stringify({
              paper: nextPaper,
              paperSize: nextSize,
              customSize: customSize ?? undefined,
              orientation,
              paperColor: nextColor,
              canvasColor: canvasColorHex,
              lineSpacing,
              pageCount,
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

  const finalizeStroke = (pts: { x: number; y: number; t: number }[]) => {
    if (pts.length < 2 || !isPenTool(tool)) return;
    const w = WIDTHS[tool][widthIdx];
    const stroke: StrokeData = {
      kind: 'stroke',
      tool,
      color,
      width: w,
      points: pts.map((p) => ({ x: p.x, y: p.y, t: p.t })),
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
    const w = WIDTHS[tool][widthIdx];
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

  const eraseAt = (x: number, y: number) => {
    const radius = WIDTHS.eraser[widthIdx] / 2;
    setItems((prev) => {
      const next = prev.filter((it) => {
        if (it.kind === 'stroke') {
          for (let i = 1; i < it.points.length; i++) {
            if (distPtSeg({ x, y }, it.points[i - 1], it.points[i]) <= radius + it.width / 2) {
              return false;
            }
          }
          return true;
        } else {
          const a = it.start;
          const b = it.end;
          // simplified: check distance to bounding box corners and midpoints
          const candidates = [
            a,
            b,
            { x: a.x, y: b.y },
            { x: b.x, y: a.y },
            { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
          ];
          for (const c of candidates) {
            if (Math.hypot(c.x - x, c.y - y) <= radius + it.width) return false;
          }
          return true;
        }
      });
      if (next.length !== prev.length) {
        pushHistory(prev);
        persist(next, paper, paperSize, paperColorId);
      }
      return next;
    });
  };

  const runGestureAction = (action: GestureAction) => {
    if (action === 'undo') { haptic.light(); undo(); }
    else if (action === 'redo') { haptic.light(); redo(); }
    else if (action === 'eraser') { haptic.medium(); setTool('eraser'); }
  };

  // Pinch zoom (2 fingers) — and 2-finger vertical pan for scrolling across multi-page canvas.
  const pinch = Gesture.Pinch()
    .runOnJS(true)
    .onStart(() => { scaleStartRef.current = scale; })
    .onUpdate((e) => {
      const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scaleStartRef.current * e.scale));
      setScale(next);
    });

  const twoFingerPanY = Gesture.Pan()
    .runOnJS(true)
    .minPointers(2)
    .maxPointers(2)
    .averageTouches(true)
    .onStart(() => { scrollYStartRef.current = scrollY; })
    .onUpdate((e) => {
      // Only vertical pan — horizontal translation is ignored.
      // At scale s the visible document window is viewport.h / s tall; scroll can go up to
      // totalPageH minus that window (or 0 if the page already fits).
      const visibleH = viewport.h / Math.max(0.01, scale);
      const maxScroll = Math.max(0, totalPageH - visibleH);
      const next = Math.max(0, Math.min(maxScroll, scrollYStartRef.current - e.translationY / Math.max(0.5, scale)));
      setScrollY(next);
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

  // Convert screen-space gesture coords to world coords accounting for zoom only (no pan).
  const toWorld = (x: number, y: number) => ({
    x: (x - tx) / scale,
    y: (y - ty) / scale,
  });

  // Track whether the active touch is from a stylus / S-Pen vs a finger.
  // We set this in onTouchesDown and consult it in every callback so palm
  // rejection works even when pointerType is not reported (some Android builds).
  const isStylusRef = useRef<boolean>(true);

  const pan = Gesture.Pan()
    .runOnJS(true)
    .minDistance(0)
    .maxPointers(1)
    .onTouchesDown((event, manager) => {
      'worklet';
      // Runs synchronously on the UI thread so `manager.fail()` aborts the gesture before
      // any stroke can be created.
      if (palmRejectionSV.value !== 1) return;
      const allT: any = (event as any).allTouches || [];
      const chgT: any = (event as any).changedTouches || [];
      const touch: any = allT[0] || chgT[0];
      const toolType: number | undefined = touch?.toolType;
      const pointerType: string | undefined = (event as any).pointerType;
      const isStylus =
        toolType === 2 ||
        toolType === 4 ||
        pointerType === 'stylus' ||
        pointerType === 'pen';
      if (!isStylus) {
        manager.fail();
      }
    })
    .onBegin((e) => {
      if (palmRejectionRef.current && !isStylusRef.current) {
        livePtsRef.current = [];
        return;
      }
      const w = toWorld(e.x, e.y);
      // Reject touches that started outside the page area (left/right margins or above/below pages)
      if (w.x < 0 || w.x > pageDims.w || w.y < 0 || w.y > totalPageH) {
        livePtsRef.current = [];
        liveShapeRef.current = null;
        return;
      }
      if (isPenTool(tool)) {
        livePtsRef.current = [{ x: w.x, y: w.y, t: Date.now() }];
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
      const w = toWorld(e.x, e.y);
      if (isPenTool(tool)) {
        const last = livePtsRef.current[livePtsRef.current.length - 1];
        if (!last) return;
        const d = Math.hypot(w.x - last.x, w.y - last.y);
        if (d < 1.2 / scale) return;
        livePtsRef.current.push({ x: w.x, y: w.y, t: Date.now() });
        setLiveTick((n) => n + 1);
      } else if (isShapeTool(tool) && liveShapeRef.current) {
        liveShapeRef.current.end = { x: w.x, y: w.y, t: Date.now() };
        setLiveTick((n) => n + 1);
      } else if (tool === 'eraser') {
        eraseAt(w.x, w.y);
      }
    })
    .onEnd(() => {
      if (palmRejectionRef.current && !isStylusRef.current) {
        livePtsRef.current = [];
        liveShapeRef.current = null;
        setLiveTick((n) => n + 1);
        return;
      }
      // Auto-add a page when the last stroke approaches the bottom of the current pages.
      if (autoAddPageRef.current && isPenTool(tool) && livePtsRef.current.length > 0) {
        const last = livePtsRef.current[livePtsRef.current.length - 1];
        if (last && last.y > pageCount * basePageH - 120) {
          setPageCount((c) => c + 1);
          // Scroll the indicator forward to the new page so the user sees the new space.
          setScrollY(pageCount * basePageH);
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
    });

  const finalGesture = Gesture.Simultaneous(pan, composedGesture, tapsGesture);

  // ----- Render strokes -----
  const renderStroke = (s: StrokeData, key: string) => {
    if (s.tool === 'fountain') {
      // Variable width segments from velocity
      const pts = s.points;
      const els: React.ReactNode[] = [];
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1];
        const b = pts[i];
        const dt = Math.max(1, (b.t || 0) - (a.t || 0));
        const dist = Math.hypot(b.x - a.x, b.y - a.y);
        const speed = dist / dt;
        const t = Math.min(1, Math.max(0, (speed - 0.2) / 1.4));
        const w = s.width * (1.6 - t * 1.05);
        const p = Skia.Path.Make();
        p.moveTo(a.x, a.y);
        p.lineTo(b.x, b.y);
        els.push(
          <Path
            key={`${key}-${i}`}
            path={p}
            color={s.color}
            style="stroke"
            strokeWidth={w}
            strokeCap="round"
            strokeJoin="round"
          />
        );
      }
      return <React.Fragment key={key}>{els}</React.Fragment>;
    }

    const path = buildPathFromPoints(s.points);
    const opacity =
      s.tool === 'highlighter' ? 0.35 : s.tool === 'pencil' ? 0.75 : 1;
    const colorWithAlpha = applyAlpha(s.color, opacity);
    const width = s.tool === 'highlighter' ? s.width : s.width;
    return (
      <Path
        key={key}
        path={path}
        color={colorWithAlpha}
        style="stroke"
        strokeWidth={width}
        strokeCap={s.tool === 'highlighter' ? 'butt' : 'round'}
        strokeJoin="round"
      />
    );
  };

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

  // Live preview
  const livePreview = (() => {
    if (isPenTool(tool) && livePtsRef.current.length >= 2) {
      const stroke: StrokeData = {
        kind: 'stroke',
        tool,
        color,
        width: WIDTHS[tool][widthIdx],
        points: livePtsRef.current.map((p) => ({ x: p.x, y: p.y, t: p.t })),
      };
      return renderStroke(stroke, 'live');
    }
    if (isShapeTool(tool) && liveShapeRef.current) {
      const shape: ShapeData = {
        kind: 'shape',
        tool,
        color,
        width: WIDTHS[tool][widthIdx],
        start: liveShapeRef.current.start,
        end: liveShapeRef.current.end,
      };
      return renderShape(shape, 'live-shape');
    }
    return null;
  })();

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

  const handleToolTap = (t: Tool) => {
    haptic.selection();
    if (tool === t && (isPenTool(t) || t === 'eraser')) {
      setShowToolOpts(true);
      return;
    }
    setTool(t);
  };

  const resetZoom = () => {
    setScale(1);
  };

  if (loading || !note) {
    return (
      <View style={[styles.center, { backgroundColor: paperColor }]}>
        <ActivityIndicator color={colors.brand} />
      </View>
    );
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
                width: 60,
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
            icon={settings.palmRejection ? 'hand-left' : 'hand-left-outline'}
            label={settings.palmRejection ? 'Pen only' : 'Touch on'}
            active={settings.palmRejection}
            onPress={() => { haptic.selection(); update({ palmRejection: !settings.palmRejection }); }}
            testID="tool-pen-mode"
          />
          <Divider vertical={vertical} />
          <ToolBtn icon="brush" label="Pen" active={tool === 'pen'} onPress={() => handleToolTap('pen')} testID="tool-pen" />
          <ToolBtn icon="create-outline" label="Fountain" active={tool === 'fountain'} onPress={() => handleToolTap('fountain')} testID="tool-fountain" />
          <ToolBtn icon="color-wand" label="Marker" active={tool === 'marker'} onPress={() => handleToolTap('marker')} testID="tool-marker" />
          <ToolBtn icon="bookmark-outline" label="Highlight" active={tool === 'highlighter'} onPress={() => handleToolTap('highlighter')} testID="tool-highlighter" />
          <ToolBtn icon="pencil-outline" label="Pencil" active={tool === 'pencil'} onPress={() => handleToolTap('pencil')} testID="tool-pencil" />
          <Divider vertical={vertical} />
          <ToolBtn icon="ellipse-outline" label="Shape" active={isShapeTool(tool)} onPress={() => setShowToolPalette(true)} testID="tool-shape" />
          <ToolBtn icon="close-circle-outline" label="Eraser" active={tool === 'eraser'} onPress={() => handleToolTap('eraser')} testID="tool-eraser" />
          <Divider vertical={vertical} />
          {/* Color swatches — inline in the same single line */}
          {PALETTE.map((c) => (
            <Pressable
              key={c}
              onPress={() => setColor(c)}
              testID={`color-${c}`}
              style={[
                styles.colorDot,
                {
                  backgroundColor: c,
                  borderColor: color === c ? colors.brand : colors.border,
                  borderWidth: color === c ? 3 : 1,
                  marginHorizontal: 2,
                },
              ]}
            />
          ))}
          <Divider vertical={vertical} />
          {/* Width buttons — also inline */}
          {[0, 1, 2].map((i) => (
            <Pressable
              key={`w-${i}`}
              onPress={() => setWidthIdx(i as 0 | 1 | 2)}
              testID={`width-${i}`}
              style={[
                styles.widthBtn,
                {
                  borderColor: widthIdx === i ? colors.brand : colors.border,
                  backgroundColor: colors.surfaceSecondary,
                  marginHorizontal: 2,
                },
              ]}
            >
              <View
                style={{
                  width: 18,
                  height: 2 + i * 3,
                  backgroundColor: colors.onSurface,
                  borderRadius: 999,
                }}
              />
            </Pressable>
          ))}
        </ScrollView>
      </View>
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: paperColor }}>
      {/* Chrome-style tabs row with back arrow inline */}
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
              {saving && (
                <Text style={{ color: colors.muted, fontSize: typeScale.sm, marginRight: 4 }}>
                  Saving…
                </Text>
              )}
              {scale !== 1 && (
                <Pressable onPress={resetZoom} testID="draw-reset-zoom" style={[styles.zoomPill, { backgroundColor: colors.brand }]}>
                  <Text style={{ color: colors.onBrandPrimary, fontWeight: '700', fontSize: 12 }}>
                    {Math.round(scale * 100)}%
                  </Text>
                </Pressable>
              )}
              <Pressable onPress={() => setShowPaperMenu(true)} testID="draw-more" style={styles.tabsRowIcon} hitSlop={6}>
                <Ionicons name="ellipsis-vertical" size={22} color={colors.onSurface} />
              </Pressable>
            </View>
          }
        />
      </View>

      {toolbarPos === 'top' && renderToolbar()}

      {/* Canvas (+ optional left/right toolbars wrapping it) */}
      <View style={{ flex: 1, flexDirection: isVerticalToolbar ? 'row' : 'column' }}>
        {toolbarPos === 'left' && renderToolbar()}
        <View
          style={{ flex: 1, backgroundColor: canvasColorHex }}
          onLayout={(e) => setViewport({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
        >
          {Platform.OS !== 'web' ? (
            <GestureDetector gesture={finalGesture}>
              <View style={{ flex: 1 }}>
                <Canvas style={StyleSheet.absoluteFill}>
                  <Group transform={[{ translateX: tx }, { translateY: ty }, { scale }]}>
                    {Array.from({ length: pageCount }).map((_, i) => (
                      <Group key={`page-${i}`} transform={[{ translateY: i * basePageH }]}>
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
                      {items.map((it, i) =>
                        it.kind === 'stroke' ? renderStroke(it, `s${i}`) : renderShape(it, `sh${i}`)
                      )}
                      {livePreview}
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
          {/* Vertical scroll thumb (right edge) — stylus-friendly, works regardless of palm rejection */}
          {pageCount > 1 && (
            <View
              testID="scroll-thumb-track"
              style={{
                position: 'absolute',
                top: spacing.sm,
                bottom: spacing.sm,
                right: 2,
                width: 6,
                backgroundColor: colors.surfaceSecondary,
                borderRadius: 3,
                opacity: 0.7,
              }}
            >
              <Pressable
                testID="scroll-thumb"
                onTouchStart={(e) => { (e as any)._sy = scrollY; (e as any)._py = e.nativeEvent.pageY; }}
                onTouchMove={(e) => {
                  const startY: number = (e as any)._py ?? e.nativeEvent.pageY;
                  const startScroll: number = (e as any)._sy ?? scrollY;
                  const dy = e.nativeEvent.pageY - startY;
                  // Map thumb drag to canvas scroll (scale-aware).
                  const visibleH = viewport.h / Math.max(0.01, scale);
                  const maxScroll = Math.max(0, totalPageH - visibleH);
                  const trackH = viewport.h - 2 * spacing.sm;
                  const ratio = maxScroll / Math.max(1, trackH - 40);
                  const next = Math.max(0, Math.min(maxScroll, startScroll + dy * ratio));
                  setScrollY(next);
                }}
                style={{
                  position: 'absolute',
                  left: -8,
                  width: 22,
                  height: Math.max(40, ((viewport.h / Math.max(0.01, scale)) / Math.max(1, totalPageH)) * (viewport.h - 2 * spacing.sm)),
                  top: (scrollY / Math.max(1, totalPageH)) * (viewport.h - 2 * spacing.sm),
                  backgroundColor: colors.brand,
                  borderRadius: 11,
                  opacity: 0.9,
                }}
              />
            </View>
          )}
          {/* Manual "Add page" FAB + page jump buttons (stack vertically, bottom-right) */}
          <View style={{ position: 'absolute', right: spacing.lg, bottom: insets.bottom + spacing.lg, alignItems: 'center', gap: spacing.sm }}>
            {pageCount > 1 && (
              <>
                <Pressable
                  testID="page-up-btn"
                  onPress={() => {
                    haptic.selection();
                    const currentPage = Math.floor(scrollY / Math.max(1, basePageH));
                    setScrollY(Math.max(0, (currentPage - 1) * basePageH));
                  }}
                  style={({ pressed }) => ({
                    width: 44,
                    height: 44,
                    borderRadius: 22,
                    backgroundColor: colors.surface,
                    borderWidth: 1,
                    borderColor: colors.border,
                    alignItems: 'center',
                    justifyContent: 'center',
                    opacity: pressed ? 0.7 : 1,
                  })}
                >
                  <Ionicons name="chevron-up" size={22} color={colors.onSurface} />
                </Pressable>
                <Pressable
                  testID="page-down-btn"
                  onPress={() => {
                    haptic.selection();
                    const currentPage = Math.floor(scrollY / Math.max(1, basePageH));
                    const maxScroll = Math.max(0, totalPageH - basePageH);
                    setScrollY(Math.min(maxScroll, (currentPage + 1) * basePageH));
                  }}
                  style={({ pressed }) => ({
                    width: 44,
                    height: 44,
                    borderRadius: 22,
                    backgroundColor: colors.surface,
                    borderWidth: 1,
                    borderColor: colors.border,
                    alignItems: 'center',
                    justifyContent: 'center',
                    opacity: pressed ? 0.7 : 1,
                  })}
                >
                  <Ionicons name="chevron-down" size={22} color={colors.onSurface} />
                </Pressable>
              </>
            )}
            {!settings.autoAddPage && (
              <Pressable
                testID="add-page-btn"
                onPress={() => {
                  haptic.success();
                  setPageCount((c) => c + 1);
                  setScrollY(pageCount * basePageH);
                }}
                style={({ pressed }) => ({
                  width: 52,
                  height: 52,
                  borderRadius: 26,
                  backgroundColor: colors.brand,
                  alignItems: 'center',
                  justifyContent: 'center',
                  opacity: pressed ? 0.85 : 1,
                  shadowColor: '#000',
                  shadowOffset: { width: 0, height: 4 },
                  shadowOpacity: 0.25,
                  shadowRadius: 8,
                  elevation: 8,
                })}
              >
                <Ionicons name="add" size={28} color={colors.onBrandPrimary} />
              </Pressable>
            )}
          </View>
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
                {Math.min(pageCount, Math.floor(scrollY / Math.max(1, basePageH)) + 1)} / {pageCount}
              </Text>
            </View>
          )}
        </View>
        {toolbarPos === 'right' && renderToolbar()}
      </View>

      {toolbarPos === 'bottom' && renderToolbar()}

      {/* Tool options popover (tap an already-active tool again) */}
      <Modal visible={showToolOpts} transparent animationType="fade" onRequestClose={() => setShowToolOpts(false)}>
        <Pressable style={styles.backdrop} onPress={() => setShowToolOpts(false)}>
          <Pressable
            style={[
              styles.toolOptCard,
              {
                backgroundColor: colors.surface,
                bottom: insets.bottom + 130,
                shadowColor: '#000',
              },
            ]}
          >
            <Text style={{ color: colors.onSurface, fontSize: typeScale.lg, fontWeight: '700', marginBottom: spacing.sm }}>
              {labelForTool(tool)} settings
            </Text>

            <Text style={{ color: colors.muted, fontSize: typeScale.sm, marginBottom: 6 }}>Thickness</Text>
            <View style={{ flexDirection: 'row', gap: 6, marginBottom: spacing.md }}>
              {[0, 1, 2].map((i) => {
                const sample = isPenTool(tool)
                  ? WIDTHS[tool][i]
                  : tool === 'eraser'
                  ? WIDTHS.eraser[i]
                  : WIDTHS.pen[i];
                return (
                  <Pressable
                    key={i}
                    onPress={() => setWidthIdx(i as 0 | 1 | 2)}
                    testID={`opt-width-${i}`}
                    style={[
                      styles.widthBtnLg,
                      { borderColor: widthIdx === i ? colors.brand : colors.border, backgroundColor: colors.surfaceSecondary },
                    ]}
                  >
                    <View style={{ width: 36, height: Math.min(20, sample), borderRadius: 999, backgroundColor: colors.onSurface }} />
                  </Pressable>
                );
              })}
            </View>

            {tool !== 'eraser' && (
              <>
                <Text style={{ color: colors.muted, fontSize: typeScale.sm, marginBottom: 6 }}>Color</Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                  {PALETTE.map((c) => (
                    <Pressable
                      key={c}
                      onPress={() => setColor(c)}
                      testID={`opt-color-${c}`}
                      style={[
                        styles.colorDot,
                        {
                          backgroundColor: c,
                          borderColor: color === c ? colors.brand : colors.border,
                          borderWidth: color === c ? 3 : 1,
                        },
                      ]}
                    />
                  ))}
                </View>
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

            <Pressable
              onPress={() => setShowToolOpts(false)}
              testID="opt-close"
              style={[styles.btn, { backgroundColor: colors.brand, marginTop: spacing.lg }]}
            >
              <Text style={{ color: colors.onBrandPrimary, fontWeight: '700' }}>Done</Text>
            </Pressable>
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
          onPress={() => setShowPaperMenu(false)}
        >
          <Pressable
            onPress={(e) => e.stopPropagation()}
            style={{
              position: 'absolute',
              top: insets.top + 52,
              right: spacing.sm,
              width: 280,
              maxHeight: '80%',
              backgroundColor: colors.surface,
              borderRadius: radius.lg,
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
              valueText={PAPER_SIZES[(paperSize === 'custom' ? 'fit' : paperSize) as Exclude<PaperSize, 'custom'>]?.label || 'Fit'}
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
            <DrawMenuRow
              icon="apps-outline"
              label="Toolbar position"
              valueText={toolbarPos.charAt(0).toUpperCase() + toolbarPos.slice(1)}
              onPress={() => { setShowPaperMenu(false); setShowSubToolbar(true); }}
              testID="draw-menu-toolbar"
            />

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
              onPress={() => { setShowPaperMenu(false); setTitleDraft(note.title); setShowTitleEdit(true); }}
              testID="draw-menu-rename"
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
          style={[styles.backdrop, { alignItems: 'center', justifyContent: 'center', padding: spacing.lg }]}
          onPress={() => setShowSubColor(false)}
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

      {/* SUB: Page template */}
      <Modal visible={showSubTemplate} transparent animationType="fade" onRequestClose={() => setShowSubTemplate(false)}>
        <Pressable
          style={[styles.backdrop, { alignItems: 'center', justifyContent: 'center', padding: spacing.lg }]}
          onPress={() => setShowSubTemplate(false)}
        >
          <Pressable
            onPress={(e) => e.stopPropagation()}
            style={{
              width: '100%',
              maxWidth: 520,
              maxHeight: '80%',
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
          style={[styles.backdrop, { alignItems: 'center', justifyContent: 'center', padding: spacing.lg }]}
          onPress={() => setShowSubSize(false)}
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
          style={[styles.backdrop, { alignItems: 'center', justifyContent: 'center', padding: spacing.lg }]}
          onPress={() => setShowSubSpacing(false)}
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
      <Modal visible={showSubToolbar} transparent animationType="fade" onRequestClose={() => setShowSubToolbar(false)}>
        <Pressable
          style={styles.backdrop}
          onPress={() => setShowSubToolbar(false)}
        >
          <Pressable
            onPress={(e) => e.stopPropagation()}
            style={{
              position: 'absolute',
              top: insets.top + 52,
              right: spacing.sm,
              width: 280,
              backgroundColor: colors.surface,
              borderRadius: radius.lg,
              padding: spacing.md,
              shadowColor: '#000',
              shadowOffset: { width: 0, height: 10 },
              shadowOpacity: 0.22,
              shadowRadius: 24,
              elevation: 16,
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: spacing.sm }}>
              <Pressable onPress={() => { setShowSubToolbar(false); setShowPaperMenu(true); }} hitSlop={6}>
                <Ionicons name="chevron-back" size={20} color={colors.onSurface} />
              </Pressable>
              <Text style={{ flex: 1, color: colors.onSurface, fontSize: typeScale.base, fontWeight: '700', marginLeft: spacing.sm }}>
                Toolbar position
              </Text>
            </View>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, justifyContent: 'center' }}>
              {(['left', 'right', 'top', 'bottom'] as ToolbarPosition[]).map((pos) => {
                const active = toolbarPos === pos;
                const iconName: any =
                  pos === 'left'
                    ? 'chevron-back-circle-outline'
                    : pos === 'right'
                    ? 'chevron-forward-circle-outline'
                    : pos === 'top'
                    ? 'chevron-up-circle-outline'
                    : 'chevron-down-circle-outline';
                return (
                  <Pressable
                    key={pos}
                    testID={`sub-toolbar-${pos}`}
                    onPress={() => { haptic.selection(); update({ toolbarPosition: pos }); }}
                    style={({ pressed }) => ({
                      width: 110,
                      paddingVertical: spacing.md,
                      borderRadius: radius.md,
                      backgroundColor: active
                        ? colors.brandTertiary
                        : pressed
                        ? colors.surfaceTertiary
                        : colors.surfaceSecondary,
                      borderWidth: 2,
                      borderColor: active ? colors.brand : 'transparent',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 4,
                    })}
                  >
                    <Ionicons name={iconName} size={24} color={active ? colors.brand : colors.onSurface} />
                    <Text style={{ color: active ? colors.brand : colors.onSurface, fontWeight: active ? '700' : '500', fontSize: typeScale.sm }}>
                      {pos.charAt(0).toUpperCase() + pos.slice(1)}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Title edit modal */}
      <Modal visible={showTitleEdit} transparent animationType="fade" onRequestClose={() => setShowTitleEdit(false)}>
        <Pressable style={styles.backdrop} onPress={() => setShowTitleEdit(false)}>
          <Pressable
            style={[styles.titleSheet, { backgroundColor: colors.surface, top: insets.top + 48 }]}
          >
            <Text style={{ color: colors.muted, marginBottom: spacing.xs }}>Note title</Text>
            <TextInput
              autoFocus
              value={titleDraft}
              onChangeText={setTitleDraft}
              placeholder="Untitled"
              placeholderTextColor={colors.muted}
              style={{
                fontSize: typeScale.xl,
                color: colors.onSurface,
                fontWeight: '700',
                padding: spacing.sm,
                borderBottomWidth: 1,
                borderBottomColor: colors.brand,
              }}
              testID="title-input"
              returnKeyType="done"
              onSubmitEditing={updateTitle}
            />
            <Pressable
              onPress={updateTitle}
              testID="title-save"
              style={[styles.btn, { backgroundColor: colors.brand, marginTop: spacing.lg }]}
            >
              <Text style={{ color: colors.onBrandPrimary, fontWeight: '700' }}>Save</Text>
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
  onPress: () => void;
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
      onPress={onPress}
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

function ToolBtn({
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
      onPress={() => {
        haptic.selection();
        onPress();
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
      <Ionicons name={icon} size={16} color={active ? colors.onBrandPrimary : colors.onSurface} />
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
  if (size === 'fit') return <View style={{ flex: 1 }}>{children}</View>;
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
    left: spacing.lg,
    right: spacing.lg,
    padding: spacing.lg,
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
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
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
