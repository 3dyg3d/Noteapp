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
import * as Haptics from 'expo-haptics';

import { useTheme } from '@/src/theme/ThemeContext';
import { spacing, radius, typeScale } from '@/src/theme/tokens';
import { NotesApi, Note } from '@/src/api/client';

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

type Paper = 'blank' | 'ruled' | 'grid' | 'dotted';

interface DrawingDoc {
  paper: Paper;
  items: Item[];
}

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
  const historyRef = useRef<{ undo: Item[][]; redo: Item[][] }>({ undo: [], redo: [] });

  // Tool state
  const [tool, setTool] = useState<Tool>('pen');
  const [color, setColor] = useState<string>('#1A1A1C');
  const [widthIdx, setWidthIdx] = useState<0 | 1 | 2>(1);
  const [showPaperMenu, setShowPaperMenu] = useState(false);
  const [showToolPalette, setShowToolPalette] = useState(false);
  const [showTitleEdit, setShowTitleEdit] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');

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
        if (n.drawing_data) {
          try {
            const doc: DrawingDoc = JSON.parse(n.drawing_data);
            setItems(doc.items || []);
            setPaper(doc.paper || 'blank');
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
    (nextItems: Item[], nextPaper: Paper, nextTitle?: string) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(async () => {
        try {
          setSaving(true);
          const body: Partial<Note> = {
            drawing_data: JSON.stringify({ paper: nextPaper, items: nextItems } as DrawingDoc),
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
    persist(last, paper);
  };
  const redo = () => {
    const h = historyRef.current;
    if (!h.redo.length) return;
    const next = h.redo.pop()!;
    h.undo.push(items);
    setItems(next);
    persist(next, paper);
  };
  const clearAll = () => {
    pushHistory(items);
    setItems([]);
    persist([], paper);
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
      persist(next, paper);
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
      persist(next, paper);
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
        persist(next, paper);
      }
      return next;
    });
  };

  const pan = Gesture.Pan()
    .runOnJS(true)
    .minDistance(0)
    .maxPointers(1)
    .onBegin((e) => {
      if (isPenTool(tool)) {
        livePtsRef.current = [{ x: e.x, y: e.y, t: Date.now() }];
        setLiveTick((n) => n + 1);
      } else if (isShapeTool(tool)) {
        const p: Pt = { x: e.x, y: e.y, t: Date.now() };
        liveShapeRef.current = { start: p, end: p };
        setLiveTick((n) => n + 1);
      } else if (tool === 'eraser') {
        eraseAt(e.x, e.y);
      }
    })
    .onUpdate((e) => {
      if (isPenTool(tool)) {
        const last = livePtsRef.current[livePtsRef.current.length - 1];
        if (!last) return;
        const d = Math.hypot(e.x - last.x, e.y - last.y);
        if (d < 1.2) return;
        livePtsRef.current.push({ x: e.x, y: e.y, t: Date.now() });
        setLiveTick((n) => n + 1);
      } else if (isShapeTool(tool) && liveShapeRef.current) {
        liveShapeRef.current.end = { x: e.x, y: e.y, t: Date.now() };
        setLiveTick((n) => n + 1);
      } else if (tool === 'eraser') {
        eraseAt(e.x, e.y);
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

  // Paper background
  const paperBg = isDark ? '#0a0a0a' : '#FBFAF6';
  const paperLine = isDark ? '#1f1f22' : '#E5E1D6';

  const handleSetPaper = (p: Paper) => {
    setPaper(p);
    setShowPaperMenu(false);
    persist(items, p);
  };

  const updateTitle = () => {
    setShowTitleEdit(false);
    persist(items, paper, titleDraft);
    if (note) setNote({ ...note, title: titleDraft });
  };

  const exitDelete = async () => {
    if (!note) return;
    await NotesApi.remove(note.id);
    router.back();
  };

  if (loading || !note) {
    return (
      <View style={[styles.center, { backgroundColor: paperBg }]}>
        <ActivityIndicator color={colors.brand} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: paperBg }}>
      {/* Top bar */}
      <View style={[styles.topBar, { paddingTop: insets.top + spacing.xs, backgroundColor: colors.surface + 'ee' }]}>
        <Pressable onPress={() => router.back()} testID="draw-back" style={styles.topIcon}>
          <Ionicons name="chevron-back" size={26} color={colors.onSurface} />
        </Pressable>
        <Pressable
          onPress={() => {
            setTitleDraft(note.title);
            setShowTitleEdit(true);
          }}
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
        <Pressable onPress={() => setShowPaperMenu(true)} testID="draw-more" style={styles.topIcon}>
          <Ionicons name="ellipsis-vertical" size={22} color={colors.onSurface} />
        </Pressable>
      </View>

      {/* Canvas */}
      <View style={{ flex: 1 }}>
        <PaperBackground type={paper} color={paperBg} lineColor={paperLine} />
        {Platform.OS !== 'web' ? (
          <GestureDetector gesture={pan}>
            <Canvas style={StyleSheet.absoluteFill}>
              {items.map((it, i) =>
                it.kind === 'stroke' ? renderStroke(it, `s${i}`) : renderShape(it, `sh${i}`)
              )}
              {livePreview}
            </Canvas>
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
          <ToolBtn icon="brush" label="Pen" active={tool === 'pen'} onPress={() => setTool('pen')} testID="tool-pen" />
          <ToolBtn icon="create-outline" label="Fountain" active={tool === 'fountain'} onPress={() => setTool('fountain')} testID="tool-fountain" />
          <ToolBtn icon="color-wand" label="Marker" active={tool === 'marker'} onPress={() => setTool('marker')} testID="tool-marker" />
          <ToolBtn icon="bookmark-outline" label="Highlight" active={tool === 'highlighter'} onPress={() => setTool('highlighter')} testID="tool-highlighter" />
          <ToolBtn icon="pencil-outline" label="Pencil" active={tool === 'pencil'} onPress={() => setTool('pencil')} testID="tool-pencil" />
          <Divider />
          <ToolBtn icon="ellipse-outline" label="Shape" active={isShapeTool(tool)} onPress={() => setShowToolPalette(true)} testID="tool-shape" />
          <ToolBtn icon="close-circle-outline" label="Eraser" active={tool === 'eraser'} onPress={() => setTool('eraser')} testID="tool-eraser" />
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

      {/* More menu (paper + clear + delete) */}
      <Modal visible={showPaperMenu} transparent animationType="slide" onRequestClose={() => setShowPaperMenu(false)}>
        <Pressable style={styles.backdrop} onPress={() => setShowPaperMenu(false)}>
          <Pressable style={[styles.sheet, { backgroundColor: colors.surface, paddingBottom: insets.bottom + spacing.lg }]}>
            <View style={styles.sheetHandle} />
            <Text style={{ color: colors.onSurface, fontSize: typeScale.lg, fontWeight: '700', marginBottom: spacing.md }}>
              Paper style
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
              {(['blank', 'ruled', 'grid', 'dotted'] as Paper[]).map((p) => (
                <PaperOption key={p} type={p} active={paper === p} onPress={() => handleSetPaper(p)} testID={`paper-${p}`} />
              ))}
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
        Haptics.selectionAsync().catch(() => {});
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
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      style={{
        width: 80,
        height: 96,
        borderRadius: radius.md,
        borderWidth: active ? 2 : 1,
        borderColor: active ? colors.brand : colors.border,
        overflow: 'hidden',
        backgroundColor: '#FBFAF6',
      }}
    >
      <PaperBackground type={type} color="#FBFAF6" lineColor="#D1CDC2" />
      <Text
        style={{
          position: 'absolute',
          bottom: 4,
          left: 0,
          right: 0,
          textAlign: 'center',
          fontSize: 11,
          color: active ? colors.brand : colors.onSurface,
          fontWeight: '700',
          backgroundColor: '#fff8',
        }}
      >
        {type[0].toUpperCase() + type.slice(1)}
      </Text>
    </Pressable>
  );
}

function PaperBackground({
  type,
  color,
  lineColor,
}: {
  type: Paper;
  color: string;
  lineColor: string;
}) {
  if (type === 'blank') {
    return <View style={[StyleSheet.absoluteFill, { backgroundColor: color }]} />;
  }
  if (type === 'ruled') {
    return (
      <View style={[StyleSheet.absoluteFill, { backgroundColor: color }]}>
        {Array.from({ length: 40 }).map((_, i) => (
          <View
            key={i}
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: 40 + i * 28,
              height: 1,
              backgroundColor: lineColor,
            }}
          />
        ))}
      </View>
    );
  }
  if (type === 'grid') {
    return (
      <View style={[StyleSheet.absoluteFill, { backgroundColor: color }]}>
        {Array.from({ length: 50 }).map((_, i) => (
          <View
            key={`h${i}`}
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: i * 24,
              height: 1,
              backgroundColor: lineColor,
            }}
          />
        ))}
        {Array.from({ length: 30 }).map((_, i) => (
          <View
            key={`v${i}`}
            style={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              left: i * 24,
              width: 1,
              backgroundColor: lineColor,
            }}
          />
        ))}
      </View>
    );
  }
  // dotted
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: color }]}>
      {Array.from({ length: 30 }).map((_, r) =>
        Array.from({ length: 20 }).map((__, c) => (
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

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
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
