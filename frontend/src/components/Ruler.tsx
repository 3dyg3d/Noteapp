import React, { useMemo } from 'react';
import { View, Text } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';

/**
 * Semi-transparent ruler overlay. Supports cm/inch tick marks, pan to move, and
 * two-finger rotation. Can either scale with the paper zoom or stay true to
 * on-screen dimensions.
 *
 * The parent is expected to render this ABOVE the Skia canvas as an absolutely
 * positioned overlay (viewport-space coords). The parent also decides whether to
 * apply pen-stroke snapping when the pen begins near the ruler's edge.
 */
export interface RulerState {
  x: number;      // center X in viewport space
  y: number;      // center Y in viewport space
  angle: number;  // degrees, 0 = horizontal
  unit: 'cm' | 'in';
  scaleWithPaper: boolean;
  lengthPx: number; // length in on-screen points (before paper-scale is applied)
}

interface Props {
  state: RulerState;
  onChange: (next: RulerState) => void;
  paperScale: number;         // current canvas scale (only used when scaleWithPaper=true)
  colors: {
    brand: string;
    onSurface: string;
    muted: string;
    surface: string;
  };
}

// Approximate points-per-cm on a typical mobile screen. Real DPI varies but
// this gives a "close-enough" ruler for both platforms without native DPI code.
const POINTS_PER_CM = 38;
const POINTS_PER_INCH = POINTS_PER_CM * 2.54;

export default function Ruler({ state, onChange, paperScale, colors }: Props) {
  const scale = state.scaleWithPaper ? paperScale : 1;
  const displayLength = state.lengthPx * scale;
  const rulerHeight = 44; // fixed on-screen height (independent of paper scale)

  // Panning: move the ruler.
  const pan = Gesture.Pan()
    .runOnJS(true)
    .minDistance(0)
    .onUpdate((e) => {
      onChange({ ...state, x: state.x + e.changeX, y: state.y + e.changeY });
    });

  // Two-finger rotation.
  const rotate = Gesture.Rotation()
    .runOnJS(true)
    .onUpdate((e) => {
      onChange({ ...state, angle: state.angle + (e.rotation * 180) / Math.PI });
    });

  const combined = Gesture.Simultaneous(pan, rotate);

  const marksPerUnit = state.unit === 'cm' ? POINTS_PER_CM : POINTS_PER_INCH;
  const totalUnits = Math.floor(displayLength / marksPerUnit);
  const ticks = useMemo(() => {
    const arr: { pos: number; label: string; big: boolean }[] = [];
    for (let i = 0; i <= totalUnits; i++) {
      arr.push({ pos: i * marksPerUnit, label: `${i}`, big: true });
      // 10 minor divisions between each major (mm for cm, 1/10" for inches)
      const minorStep = marksPerUnit / 10;
      for (let j = 1; j < 10; j++) {
        const mpos = i * marksPerUnit + j * minorStep;
        if (mpos > displayLength) break;
        arr.push({ pos: mpos, label: '', big: false });
      }
    }
    return arr;
  }, [totalUnits, marksPerUnit, displayLength]);

  return (
    <GestureDetector gesture={combined}>
      <View
        style={{
          position: 'absolute',
          left: state.x - displayLength / 2,
          top: state.y - rulerHeight / 2,
          width: displayLength,
          height: rulerHeight,
          backgroundColor: 'rgba(255, 244, 200, 0.75)',
          borderWidth: 1,
          borderColor: 'rgba(120, 90, 40, 0.6)',
          borderRadius: 4,
          transform: [{ rotate: `${state.angle}deg` }],
          overflow: 'hidden',
        }}
      >
        {/* Tick marks along the top edge */}
        {ticks.map((t, i) => (
          <View
            key={i}
            style={{
              position: 'absolute',
              left: t.pos - 0.5,
              top: 0,
              width: 1,
              height: t.big ? 14 : 7,
              backgroundColor: 'rgba(50, 30, 0, 0.75)',
            }}
          />
        ))}
        {/* Numeric labels on major ticks */}
        {ticks.filter((t) => t.big && t.label !== '0').map((t, i) => (
          <Text
            key={`lbl-${i}`}
            style={{
              position: 'absolute',
              left: t.pos + 2,
              top: 14,
              fontSize: 9,
              color: 'rgba(60, 40, 10, 0.8)',
            }}
          >
            {t.label}
          </Text>
        ))}
        {/* Unit label */}
        <Text
          style={{
            position: 'absolute',
            right: 4,
            bottom: 3,
            fontSize: 10,
            fontWeight: '700',
            color: 'rgba(60, 40, 10, 0.9)',
          }}
        >
          {state.unit}
        </Text>
      </View>
    </GestureDetector>
  );
}

/**
 * Project a point onto the infinite line defined by the ruler's TOP edge in
 * viewport coordinates. Returns the projected point. Used by the parent to
 * snap pen strokes along the ruler edge.
 */
export function rulerProject(state: RulerState, paperScale: number, pt: { x: number; y: number }): { x: number; y: number } {
  const scale = state.scaleWithPaper ? paperScale : 1;
  const halfLen = (state.lengthPx * scale) / 2;
  const rad = (state.angle * Math.PI) / 180;
  const dx = Math.cos(rad);
  const dy = Math.sin(rad);
  // Top edge of the ruler is at center - height/2 rotated. But it's easier to
  // just project onto the LINE that runs through (state.x, state.y) along the
  // rotation axis (i.e. the ruler's long axis), then offset up by the ruler's
  // top-edge distance so strokes hug the edge.
  const relX = pt.x - state.x;
  const relY = pt.y - state.y;
  const t = relX * dx + relY * dy;
  const clampedT = Math.max(-halfLen, Math.min(halfLen, t));
  // Offset perpendicular to the axis by -22 (half of ruler height) so strokes
  // sit right at the top edge of the ruler.
  const perpX = -dy;
  const perpY = dx;
  const edgeOffset = -22;
  return {
    x: state.x + clampedT * dx + edgeOffset * perpX,
    y: state.y + clampedT * dy + edgeOffset * perpY,
  };
}

/**
 * Returns distance from `pt` to the top edge of the ruler line (viewport coords).
 * Used to decide whether to snap a stroke or not.
 */
export function rulerEdgeDistance(state: RulerState, paperScale: number, pt: { x: number; y: number }): number {
  const projected = rulerProject(state, paperScale, pt);
  return Math.hypot(pt.x - projected.x, pt.y - projected.y);
}
