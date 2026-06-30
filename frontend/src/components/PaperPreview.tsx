import React, { useMemo } from 'react';
import { View, StyleSheet } from 'react-native';

export type PaperType =
  | 'blank'
  | 'ruled'
  | 'narrow'
  | 'grid'
  | 'dotted'
  | 'cornell'
  | 'planner'
  | 'todo';

interface Props {
  type: PaperType;
  width: number;
  height: number;
  color?: string;
  lineColor?: string;
  borderRadius?: number;
}

/**
 * Lightweight, pure-RN preview of paper templates.
 * Used in the handwriting prep popup so users can SEE the template style.
 * Renders deterministic mini-lines/dots using absolutely positioned <View />s
 * (no Skia, no SVG — works on web and native).
 */
function PaperPreviewInner({
  type,
  width,
  height,
  color = '#FFFFFF',
  lineColor = '#C9D2E0',
  borderRadius = 8,
}: Props) {
  const nodes = useMemo<React.ReactNode[]>(() => {
    const arr: React.ReactNode[] = [];

    if (type === 'blank') {
      return arr;
    }

    if (type === 'ruled') {
      const step = Math.max(8, Math.round(height / 7));
      for (let y = step; y < height - 2; y += step) {
        arr.push(
          <View
            key={`r-${y}`}
            style={[styles.hLine, { top: y, backgroundColor: lineColor }]}
          />
        );
      }
      return arr;
    }

    if (type === 'narrow') {
      const step = Math.max(5, Math.round(height / 11));
      for (let y = step; y < height - 2; y += step) {
        arr.push(
          <View
            key={`n-${y}`}
            style={[styles.hLine, { top: y, backgroundColor: lineColor }]}
          />
        );
      }
      return arr;
    }

    if (type === 'grid') {
      const stepY = Math.max(6, Math.round(height / 7));
      const stepX = Math.max(6, Math.round(width / 6));
      for (let y = stepY; y < height - 1; y += stepY) {
        arr.push(
          <View
            key={`gh-${y}`}
            style={[styles.hLine, { top: y, backgroundColor: lineColor }]}
          />
        );
      }
      for (let x = stepX; x < width - 1; x += stepX) {
        arr.push(
          <View
            key={`gv-${x}`}
            style={[styles.vLine, { left: x, backgroundColor: lineColor }]}
          />
        );
      }
      return arr;
    }

    if (type === 'dotted') {
      const stepY = Math.max(6, Math.round(height / 7));
      const stepX = Math.max(6, Math.round(width / 6));
      for (let y = stepY; y < height - 2; y += stepY) {
        for (let x = stepX; x < width - 2; x += stepX) {
          arr.push(
            <View
              key={`d-${x}-${y}`}
              style={{
                position: 'absolute',
                top: y - 1,
                left: x - 1,
                width: 2,
                height: 2,
                borderRadius: 1,
                backgroundColor: lineColor,
              }}
            />
          );
        }
      }
      return arr;
    }

    if (type === 'cornell') {
      const top = Math.round(height * 0.18);
      const bottom = Math.round(height * 0.82);
      const cueX = Math.round(width * 0.3);
      // header line + summary line
      arr.push(
        <View key="ct" style={[styles.hLine, { top, backgroundColor: lineColor, height: 1 }]} />
      );
      arr.push(
        <View
          key="cb"
          style={[styles.hLine, { top: bottom, backgroundColor: lineColor, height: 1 }]}
        />
      );
      // cue column divider
      arr.push(
        <View
          key="cc"
          style={[
            styles.vLine,
            {
              left: cueX,
              top,
              height: bottom - top,
              backgroundColor: lineColor,
            },
          ]}
        />
      );
      // ruled lines in note area
      const step = Math.max(5, Math.round((bottom - top) / 5));
      for (let y = top + step; y < bottom - 1; y += step) {
        arr.push(
          <View
            key={`cl-${y}`}
            style={[
              styles.hLine,
              { top: y, left: 0, right: 0, backgroundColor: lineColor, opacity: 0.7 },
            ]}
          />
        );
      }
      return arr;
    }

    if (type === 'planner') {
      const head1 = Math.round(height * 0.14);
      const head2 = Math.round(height * 0.26);
      arr.push(
        <View
          key="ph1"
          style={[styles.hLine, { top: head1, backgroundColor: lineColor }]}
        />
      );
      arr.push(
        <View
          key="ph2"
          style={[styles.hLine, { top: head2, backgroundColor: lineColor, height: 1.5 }]}
        />
      );
      const step = Math.max(6, Math.round(height / 8));
      for (let y = head2 + step; y < height - 2; y += step) {
        arr.push(
          <View
            key={`pl-${y}`}
            style={[styles.hLine, { top: y, backgroundColor: lineColor, opacity: 0.85 }]}
          />
        );
      }
      return arr;
    }

    if (type === 'todo') {
      const step = Math.max(7, Math.round(height / 6));
      const boxSize = Math.max(5, Math.round(step * 0.55));
      const padX = 4;
      for (let i = 0; i < Math.floor((height - 2) / step); i++) {
        const cy = step * (i + 1) - boxSize / 2;
        arr.push(
          <View
            key={`tb-${i}`}
            style={{
              position: 'absolute',
              left: padX,
              top: cy,
              width: boxSize,
              height: boxSize,
              borderWidth: 1,
              borderColor: lineColor,
              borderRadius: 1,
            }}
          />
        );
        arr.push(
          <View
            key={`tl-${i}`}
            style={[
              styles.hLine,
              {
                top: cy + boxSize / 2,
                left: padX + boxSize + 3,
                right: 4,
                backgroundColor: lineColor,
                opacity: 0.8,
              },
            ]}
          />
        );
      }
      return arr;
    }

    return arr;
  }, [type, width, height, lineColor]);

  return (
    <View
      style={[
        styles.page,
        { width, height, backgroundColor: color, borderRadius },
      ]}
    >
      {nodes}
    </View>
  );
}

const styles = StyleSheet.create({
  page: {
    overflow: 'hidden',
    position: 'relative',
  },
  hLine: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 1,
  },
  vLine: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 1,
  },
});

const PaperPreview = React.memo(PaperPreviewInner);
export default PaperPreview;
