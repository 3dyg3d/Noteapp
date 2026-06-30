import React from 'react';
import { Group, Rect, Line, Circle, vec } from '@shopify/react-native-skia';

export type PaperType = 'blank' | 'ruled' | 'narrow' | 'grid' | 'dotted' | 'cornell' | 'planner' | 'todo';

interface Props {
  type: PaperType;
  color: string;
  lineColor: string;
  width: number;
  height: number;
}

/**
 * Skia-based paper background. Renders inside a transformed Group so it
 * zooms / pans together with the user's strokes.
 */
export default function SkiaPaper({ type, color, lineColor, width, height }: Props) {
  const fill = <Rect x={0} y={0} width={width} height={height} color={color} />;

  if (type === 'blank') return fill;

  if (type === 'ruled') {
    const lines = [];
    for (let y = 40; y < height; y += 32) {
      lines.push(<Line key={`r-${y}`} p1={vec(0, y)} p2={vec(width, y)} color={lineColor} strokeWidth={1} />);
    }
    return <Group>{fill}{lines}</Group>;
  }

  if (type === 'narrow') {
    const lines = [];
    for (let y = 28; y < height; y += 20) {
      lines.push(<Line key={`n-${y}`} p1={vec(0, y)} p2={vec(width, y)} color={lineColor} strokeWidth={1} />);
    }
    return <Group>{fill}{lines}</Group>;
  }

  if (type === 'grid') {
    const lines = [];
    for (let y = 0; y < height; y += 24) {
      lines.push(<Line key={`gh-${y}`} p1={vec(0, y)} p2={vec(width, y)} color={lineColor} strokeWidth={1} />);
    }
    for (let x = 0; x < width; x += 24) {
      lines.push(<Line key={`gv-${x}`} p1={vec(x, 0)} p2={vec(x, height)} color={lineColor} strokeWidth={1} />);
    }
    return <Group>{fill}{lines}</Group>;
  }

  if (type === 'dotted') {
    const dots = [];
    for (let y = 12; y < height; y += 24) {
      for (let x = 12; x < width; x += 24) {
        dots.push(<Circle key={`d-${x}-${y}`} cx={x} cy={y} r={1.4} color={lineColor} />);
      }
    }
    return <Group>{fill}{dots}</Group>;
  }

  if (type === 'cornell') {
    const lines = [];
    // ruled
    for (let y = 120; y < height - 80; y += 28) {
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
    const els = [];
    els.push(<Line key="ph" p1={vec(0, 90)} p2={vec(width, 90)} color={lineColor} strokeWidth={1.5} />);
    els.push(<Line key="pd" p1={vec(20, 50)} p2={vec(width - 20, 50)} color={lineColor} strokeWidth={1} />);
    for (let y = 100; y < height; y += 30) {
      els.push(<Line key={`pl-${y}`} p1={vec(0, y)} p2={vec(width, y)} color={lineColor} strokeWidth={1} />);
    }
    return <Group>{fill}{els}</Group>;
  }

  // todo
  const els = [];
  for (let y = 30; y < height; y += 30) {
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
