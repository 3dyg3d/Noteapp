import React, { useMemo } from 'react';
import { View, Platform, StyleSheet, Text } from 'react-native';

/**
 * Small preview thumbnail for handwritten notes.
 *
 * Parses the note's `drawing_data` JSON, filters items belonging to the FIRST
 * page (using the doc's stored page dimensions where available), and renders
 * them into a compact Skia canvas that fits inside a home-screen card.
 *
 * Design goals:
 *  - Fast: only renders the first page, caps the number of items rendered.
 *  - Cross-platform: uses Skia which works on both native and web.
 *  - Safe: guards against malformed JSON or missing fields; falls back to a
 *    labelled placeholder so bad data can never crash the home grid.
 */
export interface HandwritingThumbnailProps {
  drawingData?: string | null;
  width: number;
  height: number;
  /** Paper background color when set on the doc. Defaults to a warm off-white. */
  fallbackPaperColor?: string;
  radius?: number;
}

// ---------- Item shapes (mirrored from app/draw/[id].tsx) ---------- //
type Pt = { x: number; y: number };
type StrokeItem = {
  kind: 'stroke';
  tool: string;
  color: string;
  width: number;
  points: Pt[];
};
type ShapeItem = {
  kind: 'shape';
  tool: 'line' | 'rect' | 'ellipse';
  color: string;
  width: number;
  start: Pt;
  end: Pt;
};
type Item = StrokeItem | ShapeItem;

interface DrawingDoc {
  paper?: string;
  paperColor?: string;
  canvasColor?: string;
  paperSize?: 'a4' | 'a5' | 'letter' | 'index' | 'custom';
  customSize?: { w: number; h: number };
  orientation?: 'portrait' | 'landscape';
  items?: Item[];
  docVersion?: number;
}

// Same aspect ratios used by the draw screen so previews line up with the real doc.
const PAPER_RATIOS: Record<string, number> = {
  a4: 1 / 1.4142,
  a5: 1 / 1.4142,
  letter: 8.5 / 11,
  index: 5 / 3,
};

/**
 * Estimate the first-page height IN WORLD UNITS. Handwriting docs store points
 * in "world" coordinates where the first page occupies y ∈ [0, pageHeight].
 * Different docs pick different absolute pixel sizes for the page based on the
 * user's viewport when they created it; we approximate by using the paperSize
 * ratio and a reasonable reference width (900 px) so the thumbnail's scaling is
 * consistent across notes.
 */
function estimateFirstPageBounds(doc: DrawingDoc): { w: number; h: number } {
  const orientation = doc.orientation ?? 'portrait';
  if (doc.paperSize === 'custom' && doc.customSize) {
    return orientation === 'landscape'
      ? { w: doc.customSize.h, h: doc.customSize.w }
      : { w: doc.customSize.w, h: doc.customSize.h };
  }
  const ratio = PAPER_RATIOS[(doc.paperSize as string) ?? 'a4'] ?? PAPER_RATIOS.a4;
  const referenceW = 900;
  if (orientation === 'landscape') {
    // Swap so height = referenceW * ratio
    return { w: referenceW, h: referenceW * ratio };
  }
  return { w: referenceW, h: referenceW / ratio };
}

/**
 * Filter items likely belonging to the first page. Uses the item's first
 * point's Y as the "belongs to page N" indicator — same rule the draw screen
 * uses when rendering strokes into pages. Points that stretch outside the
 * page are clipped by the SVG viewBox anyway.
 */
function firstPageItems(items: Item[], pageHeight: number): Item[] {
  const out: Item[] = [];
  for (const it of items) {
    if (it.kind === 'stroke') {
      const y0 = it.points[0]?.y;
      if (typeof y0 === 'number' && y0 < pageHeight) out.push(it);
    } else if (it.kind === 'shape') {
      // A shape lives on the page containing its start point.
      if (it.start && typeof it.start.y === 'number' && it.start.y < pageHeight) {
        out.push(it);
      }
    }
    if (out.length >= 400) break; // hard cap for perf
  }
  return out;
}

/**
 * Convert a list of stroke points into an SVG path "d" attribute. Uses simple
 * straight segments — the thumbnail is small so quadratic smoothing isn't worth
 * the extra CPU or memory during list rendering.
 */
function strokeToSvgPath(pts: Pt[]): string {
  if (pts.length === 0) return '';
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length; i++) {
    d += ` L ${pts[i].x} ${pts[i].y}`;
  }
  return d;
}

export default function HandwritingThumbnail({
  drawingData,
  width,
  height,
  fallbackPaperColor = '#FBFAF6',
  radius = 8,
}: HandwritingThumbnailProps) {
  // Parse once per drawingData change.
  const parsed = useMemo<DrawingDoc | null>(() => {
    if (!drawingData) return null;
    try {
      const d = JSON.parse(drawingData);
      if (d && typeof d === 'object') return d;
    } catch {}
    return null;
  }, [drawingData]);

  const empty = !parsed || !parsed.items || parsed.items.length === 0;
  const paperColor = parsed?.paperColor || fallbackPaperColor;

  const pageBounds = useMemo(
    () => (parsed ? estimateFirstPageBounds(parsed) : { w: 900, h: 1273 }),
    [parsed]
  );
  const items = useMemo(
    () => (parsed?.items ? firstPageItems(parsed.items, pageBounds.h) : []),
    [parsed, pageBounds.h]
  );

  // Compute a uniform scale so the first page fits the card while preserving
  // aspect ratio. Content is drawn inside the SVG viewBox so it scales cleanly
  // regardless of the note's original pixel dimensions.
  const viewBox = `0 0 ${pageBounds.w} ${pageBounds.h}`;

  // ---- SVG rendering ----
  // We use a raw <svg> element on web and react-native-svg's <Svg> on native.
  // To avoid pulling in a new dependency (react-native-svg isn't installed
  // here) we render an HTML SVG element on web only, and fall back to a
  // Skia canvas on native. This split lives inside a single component so
  // the caller doesn't need to think about it.
  if (Platform.OS === 'web') {
    return (
      <View
        style={[
          styles.container,
          { width, height, borderRadius: radius, backgroundColor: paperColor },
        ]}
      >
        {empty ? (
          <PlaceholderContent color={paperColor} />
        ) : (
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          React.createElement('svg' as any, {
            width,
            height,
            viewBox,
            preserveAspectRatio: 'xMidYMin slice',
            style: { display: 'block', width: '100%', height: '100%' },
          },
            items.map((it, idx) => {
              if (it.kind === 'stroke') {
                if (it.points.length < 2) return null;
                return React.createElement('path' as any, {
                  key: idx,
                  d: strokeToSvgPath(it.points),
                  stroke: it.color,
                  strokeWidth: Math.max(1.2, it.width),
                  strokeLinecap: 'round',
                  strokeLinejoin: 'round',
                  fill: 'none',
                  opacity: it.tool === 'highlighter' ? 0.4 : 1,
                });
              }
              // Shapes
              if (it.tool === 'line') {
                return React.createElement('line' as any, {
                  key: idx,
                  x1: it.start.x, y1: it.start.y,
                  x2: it.end.x,   y2: it.end.y,
                  stroke: it.color,
                  strokeWidth: Math.max(1.2, it.width),
                  strokeLinecap: 'round',
                });
              }
              if (it.tool === 'rect') {
                const x = Math.min(it.start.x, it.end.x);
                const y = Math.min(it.start.y, it.end.y);
                const w = Math.abs(it.end.x - it.start.x);
                const h = Math.abs(it.end.y - it.start.y);
                return React.createElement('rect' as any, {
                  key: idx,
                  x, y, width: w, height: h,
                  stroke: it.color,
                  strokeWidth: Math.max(1.2, it.width),
                  fill: 'none',
                });
              }
              if (it.tool === 'ellipse') {
                const cx = (it.start.x + it.end.x) / 2;
                const cy = (it.start.y + it.end.y) / 2;
                const rx = Math.abs(it.end.x - it.start.x) / 2;
                const ry = Math.abs(it.end.y - it.start.y) / 2;
                return React.createElement('ellipse' as any, {
                  key: idx,
                  cx, cy, rx, ry,
                  stroke: it.color,
                  strokeWidth: Math.max(1.2, it.width),
                  fill: 'none',
                });
              }
              return null;
            })
          )
        )}
      </View>
    );
  }

  // Native: use Skia. Import lazily so the web bundle never touches Skia.
  return (
    <View
      style={[
        styles.container,
        { width, height, borderRadius: radius, backgroundColor: paperColor },
      ]}
    >
      {empty ? (
        <PlaceholderContent color={paperColor} />
      ) : (
        <SkiaThumb items={items} pageW={pageBounds.w} pageH={pageBounds.h} width={width} height={height} />
      )}
    </View>
  );
}

// Extracted so importing Skia only happens when we actually need it.
function SkiaThumb({
  items, pageW, pageH, width, height,
}: {
  items: Item[]; pageW: number; pageH: number; width: number; height: number;
}) {
  // Lazily require so web builds don't need Skia at parse time. (Skia does
  // work on web too, but this keeps the import narrow to native for now.)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Skia = require('@shopify/react-native-skia');
  const { Canvas, Path, Skia: SkiaAPI, Group } = Skia;
  const scaleX = width / pageW;
  const scaleY = height / pageH;
  // "cover"-like fit: preserve aspect ratio and centre-crop.
  const scale = Math.max(scaleX, scaleY);
  const dx = (width - pageW * scale) / 2;
  const dy = (height - pageH * scale) / 2;

  const rendered = items.map((it, idx) => {
    if (it.kind === 'stroke') {
      if (it.points.length < 2) return null;
      const path = SkiaAPI.Path.Make();
      path.moveTo(it.points[0].x, it.points[0].y);
      for (let i = 1; i < it.points.length; i++) {
        path.lineTo(it.points[i].x, it.points[i].y);
      }
      return (
        <Path
          key={idx}
          path={path}
          color={it.color}
          style="stroke"
          strokeWidth={Math.max(1.2, it.width)}
          strokeCap="round"
          strokeJoin="round"
          opacity={it.tool === 'highlighter' ? 0.4 : 1}
        />
      );
    }
    if (it.tool === 'line') {
      const p = SkiaAPI.Path.Make();
      p.moveTo(it.start.x, it.start.y);
      p.lineTo(it.end.x, it.end.y);
      return (
        <Path key={idx} path={p} color={it.color} style="stroke" strokeWidth={Math.max(1.2, it.width)} strokeCap="round" />
      );
    }
    if (it.tool === 'rect') {
      const p = SkiaAPI.Path.Make();
      const x = Math.min(it.start.x, it.end.x);
      const y = Math.min(it.start.y, it.end.y);
      const w = Math.abs(it.end.x - it.start.x);
      const h = Math.abs(it.end.y - it.start.y);
      p.addRect({ x, y, width: w, height: h });
      return (
        <Path key={idx} path={p} color={it.color} style="stroke" strokeWidth={Math.max(1.2, it.width)} />
      );
    }
    if (it.tool === 'ellipse') {
      const p = SkiaAPI.Path.Make();
      const x = Math.min(it.start.x, it.end.x);
      const y = Math.min(it.start.y, it.end.y);
      const w = Math.abs(it.end.x - it.start.x);
      const h = Math.abs(it.end.y - it.start.y);
      p.addOval({ x, y, width: w, height: h });
      return (
        <Path key={idx} path={p} color={it.color} style="stroke" strokeWidth={Math.max(1.2, it.width)} />
      );
    }
    return null;
  });

  return (
    <Canvas style={{ width, height }}>
      <Group transform={[{ translateX: dx }, { translateY: dy }, { scale }]}>
        {rendered}
      </Group>
    </Canvas>
  );
}

function PlaceholderContent({ color }: { color: string }) {
  return (
    <View style={styles.placeholder}>
      <Text style={{ color: color === '#0a0a0a' ? '#666' : '#999', fontStyle: 'italic', fontSize: 12 }}>
        Empty note
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    overflow: 'hidden',
  },
  placeholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
