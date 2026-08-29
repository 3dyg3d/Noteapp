import React, { memo } from 'react';
import { Group, Path } from '@shopify/react-native-skia';

import { InkPoint, InkTool, TOOL_OPACITY, cachedOutline, effectiveWidth } from './stroke';

export interface InkStrokeProps {
  /** The stroke record itself. Used as the identity key for the path cache. */
  stroke: object;
  points: InkPoint[];
  tool: InkTool;
  color: string;
  width: number;
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
function InkStrokeImpl({ stroke, points, tool, color, width }: InkStrokeProps) {
  const w = effectiveWidth(tool, width);
  const path = cachedOutline(stroke, points, w, tool);
  const isOutline = tool !== 'highlighter';

  return (
    <Group opacity={TOOL_OPACITY[tool] ?? 1}>
      <Path
        path={path}
        color={color}
        style={isOutline ? 'fill' : 'stroke'}
        strokeWidth={isOutline ? undefined : w}
        strokeCap="round"
        strokeJoin="round"
      />
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
