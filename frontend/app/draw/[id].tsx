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
import { Canvas, Path, Skia, SkPath } from '@shopify/react-native-skia';
import { GestureDetector, Gesture } from 'react-native-gesture-handler';

import { useTheme } from '@/src/theme/ThemeContext';
import { spacing, radius, typeScale } from '@/src/theme/tokens';
import { NotesApi, Note } from '@/src/api/client';
import { useAppSettings, haptic, GestureAction, ToolbarPosition } from '@/src/state/useAppSettings';
import { useOpenTabs } from '@/src/state/useOpenTabs';
import OpenTabsStrip from '@/src/components/OpenTabsStrip';

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
type PaperSize = 'fit' | 'a4' | 'a5' | 'letter' | 'index';

interface DrawingDoc {
  paper: Paper;
  paperSize?: PaperSize;
  paperColor?: string;
  items: Item[];
}

// Ratio = width / height of the page in PORTRAIT
const PAPER_SIZES: Record<PaperSize, { ratio: number; label: string }> = {
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
  const [paperColorId, setPaperColorId] = useState<string>('white');
  const historyRef = useRef<{ undo: Item[][]; redo: Item[][] }>({ undo: [], redo: [] });

  // Tool state
  const [tool, setTool] = useState<Tool>('pen');
  const [color, setColor] = useState<string>('#1A1A1C');
  const [widthIdx, setWidthIdx] = useState<0 | 1 | 2>(1);
  const [showPaperMenu, setShowPaperMenu] = useState(false);
  const [showToolPalette, setShowToolPalette] = useState(false);
  const [showToolOpts, setShowToolOpts] = useState(false);
  const [showTitleEdit, setShowTitleEdit] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');

  // Zoom & pan
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const scaleStartRef = useRef(1);
  const panStartRef = useRef({ x: 0, y: 0 });
  const MAX_SCALE = 16;
  const MIN_SCALE = 0.5;

  // App settings (haptics + gestures + toolbar)
  const { settings, update } = useAppSettings();
  const toolbarPos: ToolbarPosition = settings.toolbarPosition || 'bottom';
  const { openTab, renameTab } = useOpenTabs();

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
            if (doc.paperColor) setPaperColorId(doc.paperColor);
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
              paperColor: nextColor,
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
    [id]
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

  // Pinch zoom (2 fingers)
  const pinch = Gesture.Pinch()
    .runOnJS(true)
    .onStart(() => { scaleStartRef.current = scale; })
    .onUpdate((e) => {
      const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scaleStartRef.current * e.scale));
      setScale(next);
    });

  // Two-finger pan (canvas pan)
  const twoFingerPan = Gesture.Pan()
    .runOnJS(true)
    .minPointers(2)
    .maxPointers(2)
    .averageTouches(true)
    .onStart(() => { panStartRef.current = { x: tx, y: ty }; })
    .onUpdate((e) => {
      setTx(panStartRef.current.x + e.translationX);
      setTy(panStartRef.current.y + e.translationY);
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

  const composedGesture = Gesture.Simultaneous(pinch, twoFingerPan);
  const tapsGesture = Gesture.Exclusive(threeTap, twoTap);

  // Convert screen-space gesture coords to world coords accounting for zoom/pan
  const toWorld = (x: number, y: number) => ({
    x: (x - tx) / scale,
    y: (y - ty) / scale,
  });

  const pan = Gesture.Pan()
    .runOnJS(true)
    .minDistance(0)
    .maxPointers(1)
    .onBegin((e) => {
      const w = toWorld(e.x, e.y);
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

  // Paper background colors
  const paperColor =
    PAPER_COLORS.find((c) => c.id === paperColorId)?.[isDark ? 'dark' : 'light'] ||
    (isDark ? '#0a0a0a' : '#FBFAF6');
  const isDarkPaper = ['black'].includes(paperColorId) || isDark;
  const paperLine = isDarkPaper ? '#3a3a3c' : '#D1CDC2';

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
    setTx(0);
    setTy(0);
  };

  if (loading || !note) {
    return (
      <View style={[styles.center, { backgroundColor: paperColor }]}>
        <ActivityIndicator color={colors.brand} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: paperColor }}>
      {/* Top bar */}
      <View style={[styles.topBar, { paddingTop: insets.top + spacing.xs, backgroundColor: colors.surface + 'ee' }]}>
        <Pressable onPress={() => router.back()} testID="draw-back" style={styles.topIcon}>
          <Ionicons name="chevron-back" size={26} color={colors.onSurface} />
        </Pressable>
        <Pressable
          onPress={() => { setTitleDraft(note.title); setShowTitleEdit(true); }}
          testID="draw-title"
          style={{ flex: 1, alignItems: 'center' }}
        >
          <Text numberOfLines={1} style={{ color: colors.onSurface, fontSize: typeScale.lg, fontWeight: '600' }}>
            {note.title || 'Untitled'}
          </Text>
          {saving && <Text style={{ color: colors.muted, fontSize: typeScale.sm }}>Saving…</Text>}
        </Pressable>
        <Pressable onPress={undo} testID="draw-undo" style={styles.topIcon}>
          <Ionicons name="arrow-undo" size={22} color={colors.onSurface} />
        </Pressable>
        <Pressable onPress={redo} testID="draw-redo" style={styles.topIcon}>
          <Ionicons name="arrow-redo" size={22} color={colors.onSurface} />
        </Pressable>
        {scale !== 1 && (
          <Pressable onPress={resetZoom} testID="draw-reset-zoom" style={[styles.zoomPill, { backgroundColor: colors.brand }]}>
            <Text style={{ color: colors.onBrandPrimary, fontWeight: '700', fontSize: 12 }}>{Math.round(scale * 100)}%</Text>
          </Pressable>
        )}
        <Pressable onPress={() => setShowPaperMenu(true)} testID="draw-more" style={styles.topIcon}>
          <Ionicons name="ellipsis-vertical" size={22} color={colors.onSurface} />
        </Pressable>
      </View>

      <OpenTabsStrip currentId={id as string} />

      {/* Canvas (with paper-size letterbox) */}
      <View style={{ flex: 1, backgroundColor: isDark ? '#08080a' : '#d4d4d4' }}>
        <PaperFrame size={paperSize}>
          <PaperBackground
            type={paper}
            color={paperColor}
            lineColor={paperLine}
            textColor={isDarkPaper ? '#888' : '#888'}
          />
          {Platform.OS !== 'web' ? (
            <GestureDetector gesture={finalGesture}>
              <View style={{ flex: 1, transform: [{ translateX: tx }, { translateY: ty }, { scale }] }}>
                <Canvas style={StyleSheet.absoluteFill}>
                  {items.map((it, i) =>
                    it.kind === 'stroke' ? renderStroke(it, `s${i}`) : renderShape(it, `sh${i}`)
                  )}
                  {livePreview}
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
        </PaperFrame>
      </View>

      {/* Bottom toolbar */}
      <View
        style={[
          styles.toolbar,
          {
            backgroundColor: colors.surface,
            borderTopColor: colors.divider,
            paddingBottom: insets.bottom + spacing.xs,
          },
        ]}
      >
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ alignItems: 'center', gap: 2, paddingHorizontal: spacing.xs }}>
          <ToolBtn icon="brush" label="Pen" active={tool === 'pen'} onPress={() => handleToolTap('pen')} testID="tool-pen" />
          <ToolBtn icon="create-outline" label="Fountain" active={tool === 'fountain'} onPress={() => handleToolTap('fountain')} testID="tool-fountain" />
          <ToolBtn icon="color-wand" label="Marker" active={tool === 'marker'} onPress={() => handleToolTap('marker')} testID="tool-marker" />
          <ToolBtn icon="bookmark-outline" label="Highlight" active={tool === 'highlighter'} onPress={() => handleToolTap('highlighter')} testID="tool-highlighter" />
          <ToolBtn icon="pencil-outline" label="Pencil" active={tool === 'pencil'} onPress={() => handleToolTap('pencil')} testID="tool-pencil" />
          <Divider />
          <ToolBtn icon="ellipse-outline" label="Shape" active={isShapeTool(tool)} onPress={() => setShowToolPalette(true)} testID="tool-shape" />
          <ToolBtn icon="close-circle-outline" label="Eraser" active={tool === 'eraser'} onPress={() => handleToolTap('eraser')} testID="tool-eraser" />
        </ScrollView>

        {/* Color + width row */}
        <View style={styles.optRow}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: spacing.xs, paddingHorizontal: spacing.sm }}>
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
                  },
                ]}
              />
            ))}
          </ScrollView>
          <View style={{ flexDirection: 'row', gap: 4, paddingHorizontal: spacing.sm }}>
            {[0, 1, 2].map((i) => (
              <Pressable
                key={i}
                onPress={() => setWidthIdx(i as 0 | 1 | 2)}
                testID={`width-${i}`}
                style={[
                  styles.widthBtn,
                  { borderColor: widthIdx === i ? colors.brand : colors.border, backgroundColor: colors.surfaceSecondary },
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
          </View>
        </View>
      </View>

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

      {/* More menu — Paper sheet with Size + Template + Color */}
      <Modal visible={showPaperMenu} transparent animationType="slide" onRequestClose={() => setShowPaperMenu(false)}>
        <Pressable style={styles.backdrop} onPress={() => setShowPaperMenu(false)}>
          <Pressable
            style={[
              styles.sheet,
              {
                backgroundColor: colors.surface,
                paddingBottom: insets.bottom + spacing.lg,
                maxHeight: '85%',
              },
            ]}
          >
            <View style={styles.sheetHandle} />
            <ScrollView>
              {/* SIZE */}
              <Text style={[styles.paperSectionTitle, { color: colors.muted }]}>PAPER SIZE</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: spacing.sm, paddingHorizontal: 2 }}>
                {(Object.keys(PAPER_SIZES) as PaperSize[]).map((s) => (
                  <Pressable
                    key={s}
                    onPress={() => handleSetSize(s)}
                    testID={`size-${s}`}
                    style={{
                      paddingHorizontal: spacing.lg,
                      paddingVertical: spacing.sm,
                      borderRadius: radius.pill,
                      backgroundColor: paperSize === s ? colors.brand : colors.surfaceSecondary,
                    }}
                  >
                    <Text
                      style={{
                        color: paperSize === s ? colors.onBrandPrimary : colors.onSurface,
                        fontWeight: paperSize === s ? '700' : '500',
                      }}
                    >
                      {PAPER_SIZES[s].label}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>

              {/* TEMPLATE */}
              <Text style={[styles.paperSectionTitle, { color: colors.muted, marginTop: spacing.lg }]}>
                TEMPLATE
              </Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
                {(['blank', 'ruled', 'narrow', 'grid', 'dotted', 'cornell', 'planner', 'todo'] as Paper[]).map((p) => (
                  <PaperOption key={p} type={p} active={paper === p} onPress={() => handleSetPaper(p)} testID={`paper-${p}`} />
                ))}
              </View>

              {/* COLOR */}
              <Text style={[styles.paperSectionTitle, { color: colors.muted, marginTop: spacing.lg }]}>
                COLOR
              </Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
                {PAPER_COLORS.map((c) => {
                  const swatch = isDark ? c.dark : c.light;
                  const active = paperColorId === c.id;
                  return (
                    <Pressable
                      key={c.id}
                      onPress={() => handleSetColor(c.id)}
                      testID={`paper-color-${c.id}`}
                      style={{
                        width: 44,
                        height: 44,
                        borderRadius: 22,
                        backgroundColor: swatch,
                        borderWidth: active ? 3 : 1,
                        borderColor: active ? colors.brand : colors.border,
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      {active && <Ionicons name="checkmark" size={18} color={colors.brand} />}
                    </Pressable>
                  );
                })}
              </View>

              <View style={{ height: spacing.lg }} />
              <Pressable
                testID="draw-clear"
                onPress={() => {
                  clearAll();
                  setShowPaperMenu(false);
                }}
                style={({ pressed }) => [
                  styles.menuRow,
                  { backgroundColor: pressed ? colors.surfaceTertiary : colors.surfaceSecondary },
                ]}
              >
                <Ionicons name="refresh" size={20} color={colors.onSurface} />
                <Text style={{ marginLeft: spacing.md, color: colors.onSurface, fontSize: typeScale.lg }}>
                  Clear canvas
                </Text>
              </Pressable>
              <Pressable
                testID="draw-delete-note"
                onPress={() => {
                  setShowPaperMenu(false);
                  exitDelete();
                }}
                style={({ pressed }) => [
                  styles.menuRow,
                  { backgroundColor: pressed ? colors.surfaceTertiary : colors.surfaceSecondary, marginTop: spacing.sm },
                ]}
              >
                <Ionicons name="trash-outline" size={20} color={colors.error} />
                <Text style={{ marginLeft: spacing.md, color: colors.error, fontSize: typeScale.lg }}>
                  Move to trash
                </Text>
              </Pressable>
            </ScrollView>
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
        paddingHorizontal: spacing.sm,
        paddingVertical: 6,
        borderRadius: radius.md,
        backgroundColor: active ? colors.brand : 'transparent',
        minWidth: 56,
      }}
    >
      <Ionicons name={icon} size={20} color={active ? colors.onBrandPrimary : colors.onSurface} />
      <Text style={{ fontSize: 10, color: active ? colors.onBrandPrimary : colors.onSurface, marginTop: 2, fontWeight: '600' }}>
        {label}
      </Text>
    </Pressable>
  );
}

function Divider() {
  const { colors } = useTheme();
  return <View style={{ width: 1, height: 28, backgroundColor: colors.divider, marginHorizontal: 4 }} />;
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
    width: 28,
    height: 28,
    borderRadius: 14,
  },
  widthBtn: {
    width: 36,
    height: 28,
    borderRadius: 14,
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
