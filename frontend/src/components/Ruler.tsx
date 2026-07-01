import React, { useMemo } from 'react';
import { View, Text } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';

/**
 * Clear-glass ruler overlay that spans end-to-end of the drawing surface.
 *
 * Layout:
 *  • The ruler's centre is at (state.x, state.y) in viewport coordinates.
 *  • Its length is derived from the viewport so it always reaches across the
 *    screen regardless of rotation (diagonal + margin).
 *  • The "0" tick sits exactly at the ruler's centre and unit values fan out
 *    symmetrically to the left (negative) and right (positive) so users
 *    always know where their reference point is.
 *  • The current rotation angle is shown next to the centre for quick feedback.
 *
 * Interaction:
 *  • 1-finger pan → moves the ruler.
 *  • 2-finger rotate → rotates around its centre.
 *  • Stylus / S-Pen touches are ignored so the pen draws THROUGH the ruler
 *    (with snapping handled by the parent).
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
  paperScale: number;         // current canvas scale (only used when scaleWithPaper=true)
  viewport: { w: number; h: number };
  colors: {
    brand: string;
    onSurface: string;
    muted: string;
    surface: string;
  };
}

// Approximate points-per-cm on a typical mobile screen. Real DPI varies but this gives a
// "close-enough" ruler for both platforms without native DPI code.
const POINTS_PER_CM = 38;
const POINTS_PER_INCH = POINTS_PER_CM * 2.54;
const RULER_H = 62;               // fixed on-screen height (thicker, easier to grab and read)
const EDGE_PAD = 0;                // no extra padding — clipped by parent's overflow: hidden

export default function Ruler({ state, onChange, paperScale, viewport, colors }: Props) {
  // Reserved for future use — the ruler length is now derived from viewport diagonal so
  // it always spans end-to-end regardless of the paper scale. Kept in the API surface for
  // callers that expect it and for future scale-aware tick spacing tweaks.
  void paperScale;
  void state.scaleWithPaper;
  void state.lengthPx;
  void colors;

  // Compute a length that spans end-to-end regardless of orientation. Using the diagonal
  // guarantees the ruler always reaches beyond both edges even when rotated 45°.
  const diagonal = Math.hypot(viewport.w, viewport.h);
  const displayLength = diagonal + EDGE_PAD;

  // 1-finger drag → pan the ruler. Reject stylus so the pen draws through.
  const pan = Gesture.Pan()
    .runOnJS(true)
    .minDistance(0)
    .maxPointers(1)
    .onTouchesDown((event, manager) => {
      'worklet';
      // 1 = STYLUS. Fail the gesture so stylus events propagate to the canvas underneath.
      if (event.allTouches?.[0]?.pointerType === 1) {
        manager.fail();
      }
    })
    .onUpdate((e) => {
      onChange({ ...state, x: state.x + e.changeX, y: state.y + e.changeY });
    });

  // 2-finger twist → rotate around centre.
  const rotate = Gesture.Rotation()
    .runOnJS(true)
    .onTouchesDown((event, manager) => {
      'worklet';
      if (event.allTouches?.[0]?.pointerType === 1) {
        manager.fail();
      }
    })
    .onUpdate((e) => {
      onChange({ ...state, angle: state.angle + (e.rotation * 180) / Math.PI });
    });

  const combined = Gesture.Simultaneous(pan, rotate);

  const marksPerUnit = state.unit === 'cm' ? POINTS_PER_CM : POINTS_PER_INCH;
  // Total units we can fit on each side of centre.
  const halfLen = displayLength / 2;
  const unitsPerSide = Math.floor(halfLen / marksPerUnit);
  const ticks = useMemo(() => {
    const arr: { pos: number; label: string; big: boolean; isZero: boolean }[] = [];
    // Centre = 0 tick
    arr.push({ pos: halfLen, label: '0', big: true, isZero: true });
    for (let i = 1; i <= unitsPerSide; i++) {
      arr.push({ pos: halfLen + i * marksPerUnit, label: `${i}`, big: true, isZero: false });
      arr.push({ pos: halfLen - i * marksPerUnit, label: `${i}`, big: true, isZero: false });
      // 10 minor divisions between each major on both sides
      const minorStep = marksPerUnit / 10;
      for (let j = 1; j < 10; j++) {
        const posR = halfLen + (i - 1) * marksPerUnit + j * minorStep;
        const posL = halfLen - (i - 1) * marksPerUnit - j * minorStep;
        if (posR <= displayLength) arr.push({ pos: posR, label: '', big: false, isZero: false });
        if (posL >= 0) arr.push({ pos: posL, label: '', big: false, isZero: false });
      }
    }
    // Fill innermost minor ticks around zero (i=0 case above skipped them).
    // Already covered by i=1's inner minor loop starting from posR = halfLen + minorStep etc.
    return arr;
  }, [displayLength, halfLen, marksPerUnit, unitsPerSide]);

  // Format the angle nicely (0..360)
  const normalisedAngle = ((state.angle % 360) + 360) % 360;
  const angleStr = `${normalisedAngle.toFixed(0)}°`;

  return (
    <GestureDetector gesture={combined}>
      <View
        style={{
          position: 'absolute',
          left: state.x - displayLength / 2,
          top: state.y - RULER_H / 2,
          width: displayLength,
          height: RULER_H,
          // Clear-glass look — visible but non-intrusive.
          backgroundColor: 'rgba(255, 255, 255, 0.32)',
          borderTopWidth: 1.6,
          borderBottomWidth: 1.4,
          borderColor: 'rgba(255, 255, 255, 0.95)',
          transform: [{ rotate: `${state.angle}deg` }],
          overflow: 'visible',
          // subtle shadow for depth
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 2 },
          shadowOpacity: 0.28,
          shadowRadius: 8,
          elevation: 4,
        }}
      >
        {/* Solid straight edge at the top for pen snapping visual reference */}
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 0,
            height: 1,
            backgroundColor: 'rgba(255, 255, 255, 0.95)',
          }}
        />

        {/* Tick marks along the top edge */}
        {ticks.map((t, i) => (
          <View
            key={i}
            pointerEvents="none"
            style={{
              position: 'absolute',
              left: t.pos - 0.5,
              top: 0,
              width: 1,
              height: t.isZero ? 24 : t.big ? 16 : 8,
              backgroundColor: t.isZero ? 'rgba(255, 255, 255, 1)' : 'rgba(255, 255, 255, 0.95)',
            }}
          />
        ))}

        {/* Numeric labels on major ticks (skip 0; a bigger centre label handles that) */}
        {ticks.filter((t) => t.big && !t.isZero).map((t, i) => (
          <Text
            key={`lbl-${i}`}
            pointerEvents="none"
            style={{
              position: 'absolute',
              left: t.pos - 10,
              top: 18,
              width: 20,
              textAlign: 'center',
              fontSize: 10,
              color: 'rgba(255, 255, 255, 0.95)',
              fontWeight: '700',
            }}
          >
            {t.label}
          </Text>
        ))}

        {/* Centre "0" — larger, so it reads as the reference point */}
        <Text
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: halfLen - 10,
            top: 26,
            width: 20,
            textAlign: 'center',
            fontSize: 13,
            fontWeight: '800',
            color: 'rgba(255, 255, 255, 1)',
          }}
        >
          0
        </Text>

        {/* Angle readout at centre (below the 0) */}
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: halfLen - 30,
            bottom: 6,
            width: 60,
            alignItems: 'center',
          }}
        >
          <View
            style={{
              paddingHorizontal: 8,
              paddingVertical: 2,
              borderRadius: 10,
              backgroundColor: 'rgba(0, 0, 0, 0.45)',
              borderWidth: 0.5,
              borderColor: 'rgba(255, 255, 255, 0.5)',
            }}
          >
            <Text style={{ color: 'rgba(255, 255, 255, 1)', fontSize: 11, fontWeight: '700' }}>
              {angleStr}
            </Text>
          </View>
        </View>

        {/* Unit label near the right, small and subtle */}
        <Text
          pointerEvents="none"
          style={{
            position: 'absolute',
            right: 8,
            top: 6,
            fontSize: 10,
            fontWeight: '700',
            color: 'rgba(255, 255, 255, 0.9)',
          }}
        >
          {state.unit}
        </Text>
      </View>
    </GestureDetector>
  );
}

/**
 * Project a point onto the infinite line defined by the ruler's TOP edge in viewport
 * coordinates. Returns the projected point. Used by the parent to snap pen strokes.
 * Uses the same length formula the component uses so snapping stays consistent.
 */
export function rulerProject(
  state: RulerState,
  paperScale: number,
  pt: { x: number; y: number },
  viewport?: { w: number; h: number }
): { x: number; y: number } {
  const vw = viewport?.w ?? 1000;
  const vh = viewport?.h ?? 1000;
  const displayLength = Math.hypot(vw, vh) + EDGE_PAD;
  const halfLen = displayLength / 2;
  const rad = (state.angle * Math.PI) / 180;
  const dx = Math.cos(rad);
  const dy = Math.sin(rad);
  const relX = pt.x - state.x;
  const relY = pt.y - state.y;
  const t = relX * dx + relY * dy;
  const clampedT = Math.max(-halfLen, Math.min(halfLen, t));
  // Offset perpendicular to the axis by -RULER_H/2 so strokes sit right at the top edge.
  const perpX = -dy;
  const perpY = dx;
  const edgeOffset = -RULER_H / 2;
  return {
    x: state.x + clampedT * dx + edgeOffset * perpX,
    y: state.y + clampedT * dy + edgeOffset * perpY,
  };
}

/**
 * Returns distance from `pt` to the top edge of the ruler line (viewport coords).
 * Used to decide whether to snap a stroke or not.
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
