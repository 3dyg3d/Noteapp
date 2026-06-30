import React, { useRef, useState } from 'react';
import { View, StyleSheet, Pressable, Text, ScrollView } from 'react-native';
import { Canvas, Path, Skia, SkPath } from '@shopify/react-native-skia';
import { GestureDetector, Gesture } from 'react-native-gesture-handler';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/src/theme/ThemeContext';
import { spacing, radius } from '@/src/theme/tokens';

interface PathItem {
  path: SkPath;
  color: string;
  width: number;
}

const COLORS = ['#1A1A1C', '#B85C5C', '#7B8C73', '#D4A352', '#6E7A8A', '#8B7AA8'];

interface DrawingPadProps {
  height?: number;
  onChange?: (paths: PathItem[]) => void;
  initialPaths?: PathItem[];
}

export default function DrawingPad({ height = 360 }: DrawingPadProps) {
  const { colors, isDark } = useTheme();
  const [paths, setPaths] = useState<PathItem[]>([]);
  const [color, setColor] = useState<string>(isDark ? '#F2F2F7' : '#1A1A1C');
  const [width, setWidth] = useState<number>(3);
  const [mode, setMode] = useState<'pen' | 'highlight' | 'eraser'>('pen');
  const currentPathRef = useRef<SkPath | null>(null);
  const [currentPath, setCurrentPath] = useState<SkPath | null>(null);

  const strokeColor = mode === 'highlight' ? `${color}66` : color;
  const strokeWidth = mode === 'highlight' ? 14 : mode === 'eraser' ? 16 : width;
  const usedColor = mode === 'eraser' ? (isDark ? '#000000' : '#FFFFFF') : strokeColor;

  const pan = Gesture.Pan()
    .runOnJS(true)
    .minDistance(0)
    .onBegin((e) => {
      const p = Skia.Path.Make();
      p.moveTo(e.x, e.y);
      currentPathRef.current = p;
      setCurrentPath(p.copy());
    })
    .onUpdate((e) => {
      if (currentPathRef.current) {
        currentPathRef.current.lineTo(e.x, e.y);
        setCurrentPath(currentPathRef.current.copy());
      }
    })
    .onEnd(() => {
      if (currentPathRef.current) {
        const finished: PathItem = {
          path: currentPathRef.current,
          color: usedColor,
          width: strokeWidth,
        };
        setPaths((prev) => [...prev, finished]);
        currentPathRef.current = null;
        setCurrentPath(null);
      }
    });

  const undo = () => setPaths((p) => p.slice(0, -1));
  const clear = () => setPaths([]);

  return (
    <View style={{ marginVertical: spacing.md }}>
      <View
        style={[
          styles.canvasWrap,
          { backgroundColor: colors.surfaceSecondary, borderColor: colors.border },
        ]}
      >
        <GestureDetector gesture={pan}>
          <Canvas style={{ width: '100%', height }}>
            {paths.map((p, i) => (
              <Path key={i} path={p.path} color={p.color} style="stroke" strokeWidth={p.width} strokeCap="round" strokeJoin="round" />
            ))}
            {currentPath && (
              <Path
                path={currentPath}
                color={usedColor}
                style="stroke"
                strokeWidth={strokeWidth}
                strokeCap="round"
                strokeJoin="round"
              />
            )}
          </Canvas>
        </GestureDetector>
      </View>

      {/* Tool row */}
      <View style={[styles.toolRow, { backgroundColor: colors.surfaceSecondary }]}>
        <ToolBtn
          icon="brush"
          active={mode === 'pen'}
          onPress={() => setMode('pen')}
          testID="tool-pen"
        />
        <ToolBtn
          icon="color-wand"
          active={mode === 'highlight'}
          onPress={() => setMode('highlight')}
          testID="tool-highlight"
        />
        <ToolBtn
          icon="trash-bin-outline"
          active={mode === 'eraser'}
          onPress={() => setMode('eraser')}
          testID="tool-eraser"
        />
        <View style={{ width: 1, height: 24, backgroundColor: colors.divider, marginHorizontal: 4 }} />
        <Pressable onPress={undo} style={styles.toolIcon} testID="tool-undo">
          <Ionicons name="arrow-undo" size={20} color={colors.onSurface} />
        </Pressable>
        <Pressable onPress={clear} style={styles.toolIcon} testID="tool-clear">
          <Ionicons name="refresh" size={20} color={colors.onSurface} />
        </Pressable>
      </View>

      {/* Color palette */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.colorRow}>
        {COLORS.map((c) => (
          <Pressable
            key={c}
            testID={`color-${c}`}
            onPress={() => setColor(c)}
            style={[
              styles.colorDot,
              { backgroundColor: c, borderColor: color === c ? colors.brand : 'transparent' },
            ]}
          />
        ))}
        {/* width */}
        {[2, 4, 8].map((w) => (
          <Pressable
            key={`w-${w}`}
            testID={`width-${w}`}
            onPress={() => setWidth(w)}
            style={[
              styles.widthBtn,
              {
                backgroundColor: colors.surface,
                borderColor: width === w ? colors.brand : colors.border,
              },
            ]}
          >
            <View style={{ width: 22, height: w, backgroundColor: colors.onSurface, borderRadius: 999 }} />
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

function ToolBtn({
  icon,
  active,
  onPress,
  testID,
}: {
  icon: any;
  active: boolean;
  onPress: () => void;
  testID?: string;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      style={[
        styles.toolIcon,
        { backgroundColor: active ? colors.brand : 'transparent' },
      ]}
    >
      <Ionicons name={icon} size={20} color={active ? colors.onBrandPrimary : colors.onSurface} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  canvasWrap: {
    borderRadius: radius.md,
    borderWidth: 1,
    overflow: 'hidden',
  },
  toolRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.xs,
    borderRadius: radius.pill,
    marginTop: spacing.sm,
    alignSelf: 'flex-start',
    gap: spacing.xs,
  },
  toolIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  colorRow: {
    marginTop: spacing.sm,
    gap: spacing.sm,
    paddingVertical: spacing.xs,
    alignItems: 'center',
  },
  colorDot: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 2,
  },
  widthBtn: {
    paddingHorizontal: spacing.sm,
    height: 28,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
