import React, { forwardRef, useCallback, useImperativeHandle, useRef, useState } from 'react';
import { View, StyleSheet, Pressable, Text, ScrollView, Platform } from 'react-native';
import { Canvas, Path, Skia, SkPath, useCanvasRef } from '@shopify/react-native-skia';
import { GestureDetector, Gesture } from 'react-native-gesture-handler';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/src/theme/ThemeContext';
import { spacing, radius, typeScale } from '@/src/theme/tokens';

// A stylus-friendly drawing pad with velocity-based variable stroke width.
// Each stroke is broken into short segments whose width is determined by the
// instantaneous drawing speed -- mimicking S Pen pressure: slow = thick, fast = thin.

interface Segment {
  path: SkPath;
  color: string;
  width: number;
}

// We group segments per-stroke so undo can pop the whole stroke at once.
interface Stroke {
  segments: Segment[];
}

const COLORS = ['#1A1A1C', '#B85C5C', '#7B8C73', '#D4A352', '#6E7A8A', '#8B7AA8'];

interface DrawingPadProps {
  height?: number;
}

/**
 * What the note editor drives this component with.
 *
 * The editor has always rendered `<DrawingPad ref={drawingRef} />` and called
 * `snapshotBase64()` and `clear()` from its save button, but the component was
 * a plain function that never forwarded a ref. `drawingRef.current` was
 * therefore always null and the save button silently did nothing.
 */
export interface DrawingPadHandle {
  /** PNG of the current canvas, base64, or null if there is nothing to save. */
  snapshotBase64: () => string | null;
  clear: () => void;
  isEmpty: () => boolean;
}

const DrawingPad = forwardRef<DrawingPadHandle, DrawingPadProps>(function DrawingPad(
  { height = 360 },
  ref
) {
  const { colors } = useTheme();
  const isWeb = Platform.OS === 'web';

  // On web there is no canvas, so hand back a handle that reports empty instead
  // of leaving ref.current null and making the caller guard for it.
  useImperativeHandle(
    ref,
    () => ({ snapshotBase64: () => null, clear: () => {}, isEmpty: () => true }),
    []
  );

  if (isWeb) {
    return (
      <View
        style={[
          styles.canvasWrap,
          {
            backgroundColor: colors.surfaceSecondary,
            borderColor: colors.border,
            height,
            alignItems: 'center',
            justifyContent: 'center',
            padding: spacing.lg,
          },
        ]}
      >
        <Ionicons name="brush-outline" size={36} color={colors.brand} />
        <Text style={{ color: colors.onSurface, marginTop: spacing.md, fontWeight: '600' }}>
          Stylus / S Pen canvas
        </Text>
        <Text style={{ color: colors.muted, marginTop: 4, textAlign: 'center', fontSize: typeScale.sm }}>
          Available on Android & iOS — open in Expo Go to draw with your finger or S Pen.
        </Text>
      </View>
    );
  }

  return <NativeDrawingPad height={height} ref={ref} />;
});

export default DrawingPad;

const NativeDrawingPad = forwardRef<DrawingPadHandle, DrawingPadProps>(function NativeDrawingPad(
  { height = 360 },
  ref
) {
  const { colors, isDark } = useTheme();
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [color, setColor] = useState<string>(isDark ? '#F2F2F7' : '#1A1A1C');
  const [baseWidth, setBaseWidth] = useState<number>(3);
  const [mode, setMode] = useState<'pen' | 'highlight' | 'eraser'>('pen');
  const canvasRef = useCanvasRef();

  // Refs for the live stroke being drawn (don't trigger re-render per point)
  const currentStrokeRef = useRef<Stroke | null>(null);
  const lastPointRef = useRef<{ x: number; y: number; t: number } | null>(null);
  const [liveStroke, setLiveStroke] = useState<Stroke | null>(null);

  const strokeColor = mode === 'highlight' ? `${color}66` : color;
  const baseW = mode === 'highlight' ? 14 : mode === 'eraser' ? 18 : baseWidth;
  const usedColor = mode === 'eraser' ? (isDark ? '#000000' : '#FFFFFF') : strokeColor;

  // Convert velocity (px/ms) into a multiplier in [0.55, 1.6]
  // Slow strokes (≤ 0.2 px/ms) → 1.6x, fast (≥ 1.6 px/ms) → 0.55x
  const widthFromSpeed = (speed: number) => {
    const SLOW = 0.2;
    const FAST = 1.6;
    const t = Math.min(1, Math.max(0, (speed - SLOW) / (FAST - SLOW)));
    return baseW * (1.6 - t * (1.6 - 0.55));
  };

  const pan = Gesture.Pan()
    .runOnJS(true)
    .minDistance(0)
    .maxPointers(1)
    .onBegin((e) => {
      const stroke: Stroke = { segments: [] };
      currentStrokeRef.current = stroke;
      lastPointRef.current = { x: e.x, y: e.y, t: Date.now() };
      setLiveStroke({ segments: [] });
    })
    .onUpdate((e) => {
      const last = lastPointRef.current;
      const stroke = currentStrokeRef.current;
      if (!last || !stroke) return;
      const now = Date.now();
      const dx = e.x - last.x;
      const dy = e.y - last.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 1.2) return; // ignore tiny jitter
      const dt = Math.max(1, now - last.t);
      const speed = dist / dt;
      const w = widthFromSpeed(speed);

      const p = Skia.Path.Make();
      p.moveTo(last.x, last.y);
      // quadratic-ish smoothing: line to mid + line to current gives smoother feel
      const midX = (last.x + e.x) / 2;
      const midY = (last.y + e.y) / 2;
      p.quadTo(last.x, last.y, midX, midY);
      p.lineTo(e.x, e.y);

      stroke.segments.push({ path: p, color: usedColor, width: w });
      lastPointRef.current = { x: e.x, y: e.y, t: now };
      setLiveStroke({ segments: [...stroke.segments] });
    })
    .onEnd(() => {
      const stroke = currentStrokeRef.current;
      if (stroke && stroke.segments.length > 0) {
        setStrokes((prev) => [...prev, stroke]);
      }
      currentStrokeRef.current = null;
      lastPointRef.current = null;
      setLiveStroke(null);
    });

  const undo = () => setStrokes((p) => p.slice(0, -1));
  const clear = useCallback(() => setStrokes([]), []);

  // Expose the operations the note editor's save button calls. Encoding happens
  // here so the caller never has to know this is a Skia canvas.
  useImperativeHandle(
    ref,
    () => ({
      snapshotBase64: () => {
        if (strokes.length === 0) return null;
        try {
          const image = canvasRef.current?.makeImageSnapshot();
          if (!image) return null;
          return `data:image/png;base64,${image.encodeToBase64()}`;
        } catch {
          // A snapshot can fail if the canvas has not laid out yet. Returning
          // null lets the caller skip the save rather than write a broken
          // attachment.
          return null;
        }
      },
      clear,
      isEmpty: () => strokes.length === 0,
    }),
    [strokes, clear, ref, canvasRef]
  );

  return (
    <View style={{ marginVertical: spacing.md }}>
      <View
        style={[
          styles.canvasWrap,
          { backgroundColor: colors.surfaceSecondary, borderColor: colors.border },
        ]}
      >
        <GestureDetector gesture={pan}>
          <Canvas ref={canvasRef} style={{ width: '100%', height }}>
            {strokes.map((stroke, si) =>
              stroke.segments.map((seg, segi) => (
                <Path
                  key={`${si}-${segi}`}
                  path={seg.path}
                  color={seg.color}
                  style="stroke"
                  strokeWidth={seg.width}
                  strokeCap="round"
                  strokeJoin="round"
                />
              ))
            )}
            {liveStroke?.segments.map((seg, i) => (
              <Path
                key={`live-${i}`}
                path={seg.path}
                color={seg.color}
                style="stroke"
                strokeWidth={seg.width}
                strokeCap="round"
                strokeJoin="round"
              />
            ))}
          </Canvas>
        </GestureDetector>
      </View>

      <View style={[styles.toolRow, { backgroundColor: colors.surfaceSecondary }]}>
        <ToolBtn icon="brush" active={mode === 'pen'} onPress={() => setMode('pen')} testID="tool-pen" />
        <ToolBtn icon="color-wand" active={mode === 'highlight'} onPress={() => setMode('highlight')} testID="tool-highlight" />
        <ToolBtn icon="trash-bin-outline" active={mode === 'eraser'} onPress={() => setMode('eraser')} testID="tool-eraser" />
        <View style={{ width: 1, height: 24, backgroundColor: colors.divider, marginHorizontal: 4 }} />
        <Pressable onPress={undo} style={styles.toolIcon} testID="tool-undo">
          <Ionicons name="arrow-undo" size={20} color={colors.onSurface} />
        </Pressable>
        <Pressable onPress={clear} style={styles.toolIcon} testID="tool-clear">
          <Ionicons name="refresh" size={20} color={colors.onSurface} />
        </Pressable>
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.colorRow}>
        {COLORS.map((c) => (
          <Pressable
            key={c}
            testID={`color-${c}`}
            onPress={() => setColor(c)}
            style={[styles.colorDot, { backgroundColor: c, borderColor: color === c ? colors.brand : 'transparent' }]}
          />
        ))}
        {[2, 4, 8].map((w) => (
          <Pressable
            key={`w-${w}`}
            testID={`width-${w}`}
            onPress={() => setBaseWidth(w)}
            style={[
              styles.widthBtn,
              { backgroundColor: colors.surface, borderColor: baseWidth === w ? colors.brand : colors.border },
            ]}
          >
            <View style={{ width: 22, height: w, backgroundColor: colors.onSurface, borderRadius: 999 }} />
          </Pressable>
        ))}
      </ScrollView>

      <Text style={{ color: colors.muted, fontSize: typeScale.sm, marginTop: spacing.xs, textAlign: 'center' }}>
        Tip: Draw slowly for thicker strokes — works great with S Pen.
      </Text>
    </View>
  );
});

function ToolBtn({
  icon,
  active,
  onPress,
  testID,
}: {
  icon: any;
  active: boolean;
  onPress: () => void;
  testID?: string;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      style={[styles.toolIcon, { backgroundColor: active ? colors.brand : 'transparent' }]}
    >
      <Ionicons name={icon} size={20} color={active ? colors.onBrandPrimary : colors.onSurface} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  canvasWrap: { borderRadius: radius.md, borderWidth: 1, overflow: 'hidden' },
  toolRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.xs,
    borderRadius: radius.pill,
    marginTop: spacing.sm,
    alignSelf: 'flex-start',
    gap: spacing.xs,
  },
  toolIcon: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  colorRow: { marginTop: spacing.sm, gap: spacing.sm, paddingVertical: spacing.xs, alignItems: 'center' },
  colorDot: { width: 28, height: 28, borderRadius: 14, borderWidth: 2 },
  widthBtn: {
    paddingHorizontal: spacing.sm,
    height: 28,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
