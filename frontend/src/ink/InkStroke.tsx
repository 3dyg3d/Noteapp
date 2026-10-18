import React, { memo } from 'react';
import { Group, ImageShader, Path } from '@shopify/react-native-skia';

import { GRAIN_SCALE, GRAIN_SIZE, grainImage } from './grain';

import { InkPoint, InkTool, TOOL_OPACITY, cachedOutline, effectiveWidth, isConstantWidth } from './stroke';

export interface InkStrokeProps {
  /** The stroke record itself. Used as the identity key for the path cache. */
  stroke: object;
  points: InkPoint[];
  tool: InkTool;
  color: string;
  width: number;
  /** Set when the stroke was snapped to a shape: drawn at an even width. */
  shape?: string;
}

/**
 * One committed stroke, one draw call.
 *
 * Two things make this cheap. The `SkPath` is cached against the stroke object,
 * so it is built once and reused for the life of the stroke. And the component
 * is memoized on that same identity, so an unrelated state change upstream
 * doesn't walk every stroke on the page.
 *
 * The old renderer did the opposite: `buildPathFromPoints` ran fresh on every
 * render for every stroke, and the fountain pen emitted a separate `<Path>` per
 * segment, so a 300-sample stroke cost 300 elements and 300 draw calls.
 */
function InkStrokeImpl({ stroke, points, tool, color, width, shape }: InkStrokeProps) {
  const w = effectiveWidth(tool, width);
  const path = cachedOutline(stroke, points, w, tool, !!shape);
  const isOutline = !isConstantWidth(tool);

  return (
    <Group opacity={TOOL_OPACITY[tool] ?? 1}>
      <Path
        path={path}
        color={color}
        style={isOutline ? 'fill' : 'stroke'}
        strokeWidth={isOutline ? undefined : w}
        strokeCap="round"
        strokeJoin="round"
      >
        {/* Pencil grain, fixed to the paper (world units), so it doesn't
            crawl as the stroke grows. Same tile as the native layer. */}
        {tool === 'pencil' && (
          <ImageShader
            image={grainImage(color)}
            tx="repeat"
            ty="repeat"
            fit="fill"
            rect={{ x: 0, y: 0, width: GRAIN_SIZE * GRAIN_SCALE, height: GRAIN_SIZE * GRAIN_SCALE }}
          />
        )}
      </Path>
    </Group>
  );
}

export default memo(
  InkStrokeImpl,
  (a, b) =>
    a.stroke === b.stroke &&
    a.color === b.color &&
    a.width === b.width &&
    a.tool === b.tool
);
