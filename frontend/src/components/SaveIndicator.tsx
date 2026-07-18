import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';

import { useTheme } from '@/src/theme/ThemeContext';
import { typeScale } from '@/src/theme/tokens';

/**
 * Small header pill that reflects the auto-save lifecycle:
 *   `saving === true`   → animated dots + "Saving…"
 *   `saving === false`  → "Saved ✓" flashes for 1.4 s and fades out
 *   after that          → nothing visible
 *
 * Designed to sit inside the header rightSlot so it doesn't shift other icons.
 * Only re-renders when the `saving` prop transitions.
 */
export interface SaveIndicatorProps {
  saving: boolean;
  /** Optional override colour for the "Saved" tone (defaults to theme success). */
  savedColor?: string;
  compact?: boolean;
}

export default function SaveIndicator({ saving, savedColor, compact }: SaveIndicatorProps) {
  const { colors } = useTheme();
  const [mode, setMode] = useState<'idle' | 'saving' | 'saved'>('idle');
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const opacity = useSharedValue(0);

  // React to `saving` transitions. When it goes false after being true, show
  // "Saved" for 1.4 s then fade out.
  useEffect(() => {
    if (saving) {
      if (savedTimer.current) {
        clearTimeout(savedTimer.current);
        savedTimer.current = null;
      }
      setMode('saving');
      opacity.value = withTiming(1, { duration: 160 });
      return;
    }
    // saving just went false
    if (mode === 'saving') {
      setMode('saved');
      opacity.value = withTiming(1, { duration: 160 });
      savedTimer.current = setTimeout(() => {
        opacity.value = withTiming(0, { duration: 320 });
        savedTimer.current = setTimeout(() => setMode('idle'), 340);
      }, 1400);
    }
    return () => {
      if (savedTimer.current) clearTimeout(savedTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saving]);

  const animStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));

  if (mode === 'idle') return null;

  const isSaved = mode === 'saved';
  const label = isSaved ? 'Saved' : 'Saving…';
  const tone = isSaved ? (savedColor ?? colors.success) : colors.muted;

  return (
    <Animated.View
      style={[
        styles.wrap,
        { paddingHorizontal: compact ? 4 : 6 },
        animStyle,
      ]}
      accessibilityRole="text"
      accessibilityLabel={label}
      testID="save-indicator"
    >
      {isSaved ? (
        <Ionicons
          name="checkmark-circle"
          size={compact ? 13 : 14}
          color={tone}
          style={styles.icon}
        />
      ) : (
        <View style={styles.dotsWrap}>
          <SavingDots color={tone} />
        </View>
      )}
      <Text
        style={[
          styles.label,
          { color: tone, fontSize: compact ? typeScale.xs : typeScale.sm },
        ]}
      >
        {label}
      </Text>
    </Animated.View>
  );
}

/**
 * Three pulsing dots for the "Saving…" state. Fully worklet-driven so it
 * doesn't cause React re-renders while the save is in flight.
 */
function SavingDots({ color }: { color: string }) {
  const d0 = useSharedValue(0.35);
  const d1 = useSharedValue(0.35);
  const d2 = useSharedValue(0.35);
  useEffect(() => {
    let stopped = false;
    const cycle = () => {
      if (stopped) return;
      d0.value = withTiming(1, { duration: 260 }, () => {
        d0.value = withTiming(0.35, { duration: 260 });
      });
      setTimeout(() => {
        if (stopped) return;
        d1.value = withTiming(1, { duration: 260 }, () => {
          d1.value = withTiming(0.35, { duration: 260 });
        });
      }, 140);
      setTimeout(() => {
        if (stopped) return;
        d2.value = withTiming(1, { duration: 260 }, () => {
          d2.value = withTiming(0.35, { duration: 260 });
        });
      }, 280);
    };
    cycle();
    const t = setInterval(cycle, 900);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [d0, d1, d2]);

  const s0 = useAnimatedStyle(() => ({ opacity: d0.value }));
  const s1 = useAnimatedStyle(() => ({ opacity: d1.value }));
  const s2 = useAnimatedStyle(() => ({ opacity: d2.value }));

  const dot = { width: 3, height: 3, borderRadius: 2, backgroundColor: color, marginHorizontal: 1 } as const;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      <Animated.View style={[dot, s0]} />
      <Animated.View style={[dot, s1]} />
      <Animated.View style={[dot, s2]} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginRight: 4,
  },
  icon: {
    marginRight: 2,
  },
  dotsWrap: {
    marginRight: 2,
  },
  label: {
    fontWeight: '500',
  },
});
