import React, { memo, useImperativeHandle, useState, forwardRef, useCallback } from 'react';
import { Group, ImageShader, Path } from '@shopify/react-native-skia';

import { GRAIN_SCALE, GRAIN_SIZE, grainImage } from './grain';

import { InkPoint, InkTool, TOOL_OPACITY, buildLiveOutline, effectiveWidth, isConstantWidth } from './stroke';

/**
 * The wet stroke, isolated.
 *
 * The drawing screen used to hold the in-progress stroke in the parent's state
 * and bump a `liveTick` counter on every pen sample. That re-rendered a
 * 3,700-line component, which in turn rebuilt an `SkPath` for every committed
 * stroke on the page. Cost per sample therefore grew with how much was already
 * written, which is exactly why ink lagged more the longer you wrote.
 *
 * Here the live points live in this leaf component instead, driven through an
 * imperative ref. A pen sample repaints one path. Nothing above this node
 * re-renders, and committed strokes are never rebuilt mid-stroke.
 */

export interface LiveStrokeHandle {
  /** Replace the current wet stroke. Pass `null` to clear it. */
  set: (stroke: LiveStroke | null) => void;
}

export interface LiveStroke {
  points: InkPoint[];
  tool: InkTool;
  color: string;
  width: number;
}

const LiveStrokeLayer = forwardRef<LiveStrokeHandle>((_props, ref) => {
  const [stroke, setStroke] = useState<LiveStroke | null>(null);

  const set = useCallback((next: LiveStroke | null) => {
    // A fresh object each time is deliberate: the points array is mutated in
    // place by the gesture handler for speed, so identity can't be the signal.
    setStroke(next ? { ...next, points: next.points } : null);
  }, []);

  useImperativeHandle(ref, () => ({ set }), [set]);

  if (!stroke || stroke.points.length === 0) return null;

  const width = effectiveWidth(stroke.tool, stroke.width);
  const path = buildLiveOutline(stroke.points, width, stroke.tool);
  const isOutline = !isConstantWidth(stroke.tool);

  return (
    <Group opacity={TOOL_OPACITY[stroke.tool] ?? 1}>
      <Path
        path={path}
        color={stroke.color}
        // Outline tools are filled shapes; the highlighter stays a stroked spine.
        style={isOutline ? 'fill' : 'stroke'}
        strokeWidth={isOutline ? undefined : width}
        strokeCap="round"
        strokeJoin="round"
      >
        {/* Pencil grain, fixed to the paper (world units), so it doesn't
            crawl as the stroke grows. Same tile as the native layer. */}
        {stroke.tool === 'pencil' && (
          <ImageShader
            image={grainImage(stroke.color)}
            tx="repeat"
            ty="repeat"
            fit="fill"
            rect={{ x: 0, y: 0, width: GRAIN_SIZE * GRAIN_SCALE, height: GRAIN_SIZE * GRAIN_SCALE }}
          />
        )}
      </Path>
    </Group>
  );
});

LiveStrokeLayer.displayName = 'LiveStrokeLayer';

export default memo(LiveStrokeLayer);
