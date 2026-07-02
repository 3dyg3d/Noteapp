import React, { useEffect, useMemo } from 'react';
import { View, Text, TextInput } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useAnimatedStyle,
  useAnimatedProps,
  useSharedValue,
  runOnJS,
} from 'react-native-reanimated';

/**
 * Clear-glass ruler overlay that spans the drawing surface.
 *
 * Interaction:
 *  • 1-finger pan → moves the ruler (worklet-driven for zero-lag).
 *  • 2-finger twist → rotates around its centre (worklet-driven, thresholded, damped).
 *  • Stylus / S-Pen touches are ignored so the pen draws THROUGH the ruler.
 *
 * The position and rotation are held as Reanimated shared values, so gesture updates run
 * on the UI thread and don't trigger React re-renders while the user is manipulating the
 * ruler. On gesture end we sync the final value back to React state via runOnJS so the
 * parent can persist / react to changes.
 */
export interface RulerState {
  x: number;      // centre X in viewport space
  y: number;      // centre Y in viewport space
  angle: number;  // degrees, 0 = horizontal
  unit: 'cm' | 'in';
  scaleWithPaper: boolean;
  lengthPx: number; // legacy — retained for persistence but no longer used for size
}

interface Props {
  state: RulerState;
  onChange: (next: RulerState) => void;
  paperScale: number;         // current canvas scale — used to scale graduation when scaleWithPaper=true
  viewport: { w: number; h: number };
  colors: {
    brand: string;
    onSurface: string;
    muted: string;
    surface: string;
  };
  // Optional external gesture refs (drawing Pan + finger-scroll Pan). Passing them lets the
  // ruler's gestures run simultaneously with drawing/scroll so pen strokes don't wait for
  // the ruler to decide/fail. This eliminates the "jagged pen writing" caused by cross-
  // GestureDetector race.
  externalGestureRefs?: React.MutableRefObject<any>[];
}

// Approximate points-per-cm on a typical mobile screen. Real DPI varies but this gives a
// "close-enough" ruler for both platforms without native DPI code.
const POINTS_PER_CM = 38;
const POINTS_PER_INCH = POINTS_PER_CM * 2.54;
const RULER_H = 155;                    // thick, easy to read
const INFINITE_MULTIPLIER = 3.2;        // 3.2× diagonal so the ends never enter the viewport at any rotation
const ROTATION_DAMP = 0.75;             // ruler rotates at 75 % of finger twist — deliberate but not stiff
const ROTATION_START_THRESHOLD_RAD = 0.035; // ~2° before rotation starts (cuts incidental jitter)

const AnimatedView = Animated.createAnimatedComponent(View);

export default function Ruler({ state, onChange, paperScale, viewport, colors, externalGestureRefs }: Props) {
  void colors;

  // Shared values driving the transform. Initial values seeded from React state.
  const x = useSharedValue(state.x);
  const y = useSharedValue(state.y);
  const angle = useSharedValue(state.angle);

  // Sync shared values when React state changes externally (e.g. numeric angle input,
  // recentre from the menu). Clamp x/y so the ruler centre stays inside the viewport.
  useEffect(() => {
    const clamped = Math.max(8, Math.min(viewport.w - 8, state.x));
    if (x.value !== clamped) x.value = clamped;
  }, [state.x, x, viewport.w]);
  useEffect(() => {
    const clamped = Math.max(8, Math.min(viewport.h - 8, state.y));
    if (y.value !== clamped) y.value = clamped;
  }, [state.y, y, viewport.h]);
  useEffect(() => { if (angle.value !== state.angle) angle.value = state.angle; }, [state.angle, angle]);

  // Refs used inside worklet handlers.
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  const startAngle = useSharedValue(0);
  const lastRotation = useSharedValue(0);
  const crossedThreshold = useSharedValue(false);

  // Length: 3.2× the diagonal so the ends are always well outside the viewport.
  const diagonal = Math.hypot(viewport.w, viewport.h);
  const displayLength = diagonal * INFINITE_MULTIPLIER;
  const halfLen = displayLength / 2;

  // Graduation spacing — optionally scales with the canvas zoom.
  const basePpU = state.unit === 'cm' ? POINTS_PER_CM : POINTS_PER_INCH;
  const marksPerUnit = state.scaleWithPaper ? basePpU * paperScale : basePpU;
  const unitsPerSide = Math.floor(halfLen / Math.max(1, marksPerUnit));

  const ticks = useMemo(() => {
    const arr: { pos: number; label: string; big: boolean; isZero: boolean }[] = [];
    arr.push({ pos: halfLen, label: '0', big: true, isZero: true });
    for (let i = 1; i <= unitsPerSide; i++) {
      arr.push({ pos: halfLen + i * marksPerUnit, label: `${i}`, big: true, isZero: false });
      arr.push({ pos: halfLen - i * marksPerUnit, label: `${i}`, big: true, isZero: false });
      const minorStep = marksPerUnit / 10;
      for (let j = 1; j < 10; j++) {
        const posR = halfLen + (i - 1) * marksPerUnit + j * minorStep;
        const posL = halfLen - (i - 1) * marksPerUnit - j * minorStep;
        if (posR <= displayLength) arr.push({ pos: posR, label: '', big: false, isZero: false });
        if (posL >= 0) arr.push({ pos: posL, label: '', big: false, isZero: false });
      }
    }
    return arr;
  }, [displayLength, halfLen, marksPerUnit, unitsPerSide]);

  // Bubble the final position/rotation up to React state so the parent can persist it.
  const commit = (nx: number, ny: number, nAngle: number) => {
    onChange({ ...state, x: nx, y: ny, angle: nAngle });
  };

  // 1-finger drag → pan (UI-thread). ONLY accepts finger touches (pointerType 0).
  // Any pen / mouse / unknown pointer fails the gesture so the S-Pen draws THROUGH the
  // ruler with zero drift.
  const pan = Gesture.Pan()
    .minDistance(0)
    .maxPointers(1)
    .onTouchesDown((event, manager) => {
      'worklet';
      const touches = event.allTouches || [];
      // Fail unless we can confirm at least one finger AND no stylus is in the batch.
      let hasFinger = false;
      for (let i = 0; i < touches.length; i++) {
        const pt = touches[i]?.pointerType;
        if (pt === 1) { manager.fail(); return; }   // stylus present → fail
        if (pt === 0) hasFinger = true;
      }
      if (!hasFinger) manager.fail();               // no finger → fail (mouse / unknown)
    })
    .onStart(() => {
      'worklet';
      startX.value = x.value;
      startY.value = y.value;
    })
    .onUpdate((e) => {
      'worklet';
      // Small safety margin so the "0" tick is always visible (not right at the edge).
      const margin = 8;
      const nx = startX.value + e.translationX;
      const ny = startY.value + e.translationY;
      x.value = Math.max(margin, Math.min(viewport.w - margin, nx));
      y.value = Math.max(margin, Math.min(viewport.h - margin, ny));
    })
    .onEnd(() => {
      'worklet';
      runOnJS(commit)(x.value, y.value, angle.value);
    });

  // 2-finger twist → rotate (UI-thread). Damped and thresholded so twist during a pan
  // doesn't jerk the ruler. Gesture.Rotation() enforces a 2-pointer requirement natively;
  // we only need to fail on stylus so the pen isn't blocked.
  const rotate = Gesture.Rotation()
    .onTouchesDown((event, manager) => {
      'worklet';
      const touches = event.allTouches || [];
      for (let i = 0; i < touches.length; i++) {
        if (touches[i]?.pointerType === 1) { manager.fail(); return; }
      }
    })
    .onBegin(() => {
      'worklet';
      startAngle.value = angle.value;
      lastRotation.value = 0;
      crossedThreshold.value = false;
    })
    .onUpdate((e) => {
      'worklet';
      // Ignore tiny rotations until they clearly cross the threshold — kills jitter.
      if (!crossedThreshold.value) {
        if (Math.abs(e.rotation) < ROTATION_START_THRESHOLD_RAD) return;
        crossedThreshold.value = true;
        lastRotation.value = e.rotation;
      }
      const delta = e.rotation - lastRotation.value;
      lastRotation.value = e.rotation;
      angle.value = angle.value + (delta * ROTATION_DAMP * 180) / Math.PI;
    })
    .onEnd(() => {
      'worklet';
      runOnJS(commit)(x.value, y.value, angle.value);
    });

  // Build the composed gesture and, when external refs are supplied, tell RNGH the
  // ruler's pan/rotate should run SIMULTANEOUSLY with those external gestures (drawing
  // pan, finger-scroll pan). That eliminates the cross-tree race that caused the pen
  // strokes to feel jagged when writing on the ruler.
  let panG = pan;
  let rotG = rotate;
  if (externalGestureRefs && externalGestureRefs.length > 0) {
    panG = pan.simultaneousWithExternalGesture(...externalGestureRefs) as any;
    rotG = rotate.simultaneousWithExternalGesture(...externalGestureRefs) as any;
  }
  const combined = Gesture.Simultaneous(panG, rotG);

  // Animated transform for the container. Fully worklet-driven → smooth 60/120 fps.
  const animatedStyle = useAnimatedStyle(() => {
    return {
      transform: [
        { translateX: x.value - halfLen },
        { translateY: y.value - RULER_H / 2 },
        { rotate: `${angle.value}deg` },
        // The rotation must happen around the ruler's centre; the two translates above
        // already position it so its centre sits at (x, y). No additional pivot fix
        // needed because RN rotates around the element's centre by default.
      ],
    };
  }, [halfLen]);

  // Un-rotated angle chip that follows the ruler centre. Uses AnimatedTextInput with
  // useAnimatedProps so its text updates on the UI thread every frame during rotation
  // (no JS re-renders needed) — feels 100% live.
  const AnimatedTextInput = Animated.createAnimatedComponent(TextInput);
  const angleChipStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: x.value - 40 },
      { translateY: y.value + 10 },
    ],
  }));
  const angleTextProps = useAnimatedProps(() => {
    'worklet';
    const norm = ((angle.value % 360) + 360) % 360;
    return { text: `${Math.round(norm)}°`, defaultValue: `${Math.round(norm)}°` } as any;
  });

  return (
    <>
      <GestureDetector gesture={combined}>
        <AnimatedView
          style={[
            {
              position: 'absolute',
              left: 0,
              top: 0,
              width: displayLength,
              height: RULER_H,
              // The translucent body itself defines the ruler edges — no border lines.
              backgroundColor: 'rgba(255, 255, 255, 0.42)',
              overflow: 'visible',
              shadowColor: '#000',
              shadowOffset: { width: 0, height: 2 },
              shadowOpacity: 0.2,
              shadowRadius: 8,
              elevation: 4,
            },
            animatedStyle,
          ]}
        >
          {/* The translucent body defines the ruler edges — no explicit line drawn. */}

          {/* Tick marks — black graduation. Non-interactive. */}
        {ticks.map((t, i) => (
          <View
            key={i}
            pointerEvents="none"
            style={{
              position: 'absolute',
              left: t.pos - 0.5,
              top: 0,
              width: 1.2,
              height: t.isZero ? 32 : t.big ? 22 : 10,
              backgroundColor: t.isZero ? 'rgba(0,0,0,1)' : 'rgba(0,0,0,0.9)',
            }}
          />
        ))}

        {/* Numeric labels on major ticks (skip 0; centre label handles that) */}
        {ticks.filter((t) => t.big && !t.isZero).map((t, i) => (
          <Text
            key={`lbl-${i}`}
            pointerEvents="none"
            style={{
              position: 'absolute',
              left: t.pos - 12,
              top: 25,
              width: 24,
              textAlign: 'center',
              fontSize: 11,
              color: 'rgba(0,0,0,0.9)',
              fontWeight: '700',
            }}
          >
            {t.label}
          </Text>
        ))}

        {/* Centre "0" */}
        <Text
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: halfLen - 12,
            top: 36,
            width: 24,
            textAlign: 'center',
            fontSize: 15,
            fontWeight: '800',
            color: 'rgba(0,0,0,1)',
          }}
        >
          0
        </Text>

        {/* Unit label */}
        <Text
          pointerEvents="none"
          style={{
            position: 'absolute',
            right: 10,
            top: 8,
            fontSize: 11,
            fontWeight: '700',
            color: 'rgba(0,0,0,0.75)',
          }}
        >
          {state.unit}
        </Text>
      </AnimatedView>
      </GestureDetector>
    {/* Live angle chip — un-rotated so it stays readable while the ruler spins. Updates
        every frame via useAnimatedProps on a TextInput. Non-interactive (pen and gestures
        pass through). */}
    <Animated.View
      pointerEvents="none"
      style={[
        {
          position: 'absolute',
          left: 0,
          top: 0,
          width: 80,
          alignItems: 'center',
        },
        angleChipStyle,
      ]}
    >
      <View
        style={{
          paddingHorizontal: 10,
          paddingVertical: 3,
          borderRadius: 12,
          backgroundColor: 'rgba(0,0,0,0.6)',
          borderWidth: 0.5,
          borderColor: 'rgba(255,255,255,0.75)',
        }}
      >
        <AnimatedTextInput
          editable={false}
          animatedProps={angleTextProps}
          style={{
            color: 'rgba(255,255,255,1)',
            fontSize: 12,
            fontWeight: '700',
            padding: 0,
            textAlign: 'center',
            minWidth: 44,
          }}
        />
      </View>
    </Animated.View>
    </>
  );
}

/**
 * Project a point onto the infinite line defined by the ruler's TOP edge in viewport
 * coordinates. Uses the same length formula as the component so snapping stays consistent.
 */
export function rulerProject(
  state: RulerState,
  paperScale: number,
  pt: { x: number; y: number },
  viewport?: { w: number; h: number }
): { x: number; y: number } {
  void paperScale;
  const vw = viewport?.w ?? 1000;
  const vh = viewport?.h ?? 1000;
  const displayLength = Math.hypot(vw, vh) * INFINITE_MULTIPLIER;
  const halfLen = displayLength / 2;
  const rad = (state.angle * Math.PI) / 180;
  const dx = Math.cos(rad);
  const dy = Math.sin(rad);
  const relX = pt.x - state.x;
  const relY = pt.y - state.y;
  const t = relX * dx + relY * dy;
  const clampedT = Math.max(-halfLen, Math.min(halfLen, t));
  // Offset perpendicular to the axis so strokes sit at the top edge of the ruler.
  const perpX = -dy;
  const perpY = dx;
  const edgeOffset = -RULER_H / 2;
  return {
    x: state.x + clampedT * dx + edgeOffset * perpX,
    y: state.y + clampedT * dy + edgeOffset * perpY,
  };
}

/**
 * Distance from `pt` to the ruler's top edge (viewport coords).
 */
export function rulerEdgeDistance(
  state: RulerState,
  paperScale: number,
  pt: { x: number; y: number },
  viewport?: { w: number; h: number }
): number {
  const projected = rulerProject(state, paperScale, pt, viewport);
  return Math.hypot(pt.x - projected.x, pt.y - projected.y);
}
