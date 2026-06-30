import React from 'react';
import { Group, Rect, Line, Circle, vec } from '@shopify/react-native-skia';

export type PaperType = 'blank' | 'ruled' | 'narrow' | 'grid' | 'dotted' | 'cornell' | 'planner' | 'todo';

interface Props {
  type: PaperType;
  color: string;
  lineColor: string;
  width: number;
  height: number;
  /**
   * Spacing in pixels for ruled / narrow / grid / dotted templates.
   * If omitted, sensible defaults are used per template.
   */
  lineSpacing?: number;
}

/**
 * Skia-based paper background. Renders inside a transformed Group so it
 * zooms / pans together with the user's strokes.
 */
export default function SkiaPaper({ type, color, lineColor, width, height, lineSpacing }: Props) {
  const fill = <Rect x={0} y={0} width={width} height={height} color={color} />;

  if (type === 'blank') return fill;

  if (type === 'ruled') {
    const step = Math.max(8, lineSpacing ?? 32);
    const lines = [];
    for (let y = step; y < height; y += step) {
      lines.push(<Line key={`r-${y}`} p1={vec(0, y)} p2={vec(width, y)} color={lineColor} strokeWidth={1} />);
    }
    return <Group>{fill}{lines}</Group>;
  }

  if (type === 'narrow') {
    const step = Math.max(6, lineSpacing ?? 20);
    const lines = [];
    for (let y = step; y < height; y += step) {
      lines.push(<Line key={`n-${y}`} p1={vec(0, y)} p2={vec(width, y)} color={lineColor} strokeWidth={1} />);
    }
    return <Group>{fill}{lines}</Group>;
  }

  if (type === 'grid') {
    const step = Math.max(8, lineSpacing ?? 24);
    const lines = [];
    for (let y = 0; y < height; y += step) {
      lines.push(<Line key={`gh-${y}`} p1={vec(0, y)} p2={vec(width, y)} color={lineColor} strokeWidth={1} />);
    }
    for (let x = 0; x < width; x += step) {
      lines.push(<Line key={`gv-${x}`} p1={vec(x, 0)} p2={vec(x, height)} color={lineColor} strokeWidth={1} />);
    }
    return <Group>{fill}{lines}</Group>;
  }

  if (type === 'dotted') {
    const step = Math.max(8, lineSpacing ?? 24);
    const dots = [];
    for (let y = step / 2; y < height; y += step) {
      for (let x = step / 2; x < width; x += step) {
        dots.push(<Circle key={`d-${x}-${y}`} cx={x} cy={y} r={1.4} color={lineColor} />);
      }
    }
    return <Group>{fill}{dots}</Group>;
  }

  if (type === 'cornell') {
    const step = Math.max(10, lineSpacing ?? 28);
    const lines = [];
    // ruled
    for (let y = 120; y < height - 80; y += step) {
      lines.push(<Line key={`cr-${y}`} p1={vec(0, y)} p2={vec(width, y)} color={lineColor} strokeWidth={1} />);
    }
    // cue column
    lines.push(<Line key="cc" p1={vec(width * 0.3, 120)} p2={vec(width * 0.3, height - 80)} color={lineColor} strokeWidth={1.5} />);
    // summary line
    lines.push(<Line key="cs" p1={vec(0, height - 80)} p2={vec(width, height - 80)} color={lineColor} strokeWidth={1.5} />);
    // header divider
    lines.push(<Line key="ch" p1={vec(0, 110)} p2={vec(width, 110)} color={lineColor} strokeWidth={1} />);
    return <Group>{fill}{lines}</Group>;
  }

  if (type === 'planner') {
    const step = Math.max(10, lineSpacing ?? 30);
    const els = [];
    els.push(<Line key="ph" p1={vec(0, 90)} p2={vec(width, 90)} color={lineColor} strokeWidth={1.5} />);
    els.push(<Line key="pd" p1={vec(20, 50)} p2={vec(width - 20, 50)} color={lineColor} strokeWidth={1} />);
    for (let y = 100; y < height; y += step) {
      els.push(<Line key={`pl-${y}`} p1={vec(0, y)} p2={vec(width, y)} color={lineColor} strokeWidth={1} />);
    }
    return <Group>{fill}{els}</Group>;
  }

  // todo
  const step = Math.max(12, lineSpacing ?? 30);
  const els = [];
  for (let y = step; y < height; y += step) {
    // checkbox stroke (square outline)
    els.push(
      <Rect
        key={`tb-${y}`}
        x={18}
        y={y - 7}
        width={14}
        height={14}
        color={lineColor}
        style="stroke"
        strokeWidth={1.2}
      />
    );
    els.push(<Line key={`tl-${y}`} p1={vec(40, y)} p2={vec(width - 12, y)} color={lineColor} strokeWidth={1} />);
  }
  return <Group>{fill}{els}</Group>;
}
