import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';

import { useTheme } from '@/src/theme/ThemeContext';
import { typeScale } from '@/src/theme/tokens';
import type { SaveStatus } from '@/src/hooks/usePatchQueue';

/**
 * Header pill reflecting the real auto-save lifecycle:
 *   `saving`  -> animated dots + "Saving..."
 *   `saved`   -> "Saved" flashes for 1.4 s, then fades
 *   `error`   -> stays put, tappable to retry
 *   `pending` -> "Unsaved" while edits sit in the queue
 *
 * The previous version took a single `saving` boolean, so a failed write and a
 * successful one were indistinguishable: both ended with `saving === false` and
 * both rendered "Saved". An error state that disappears is worse than no
 * indicator at all, because it actively tells the person their work is safe.
 */
export interface SaveIndicatorProps {
  status: SaveStatus;
  /** Whether anything is still queued. Keeps "Unsaved" visible while offline. */
  hasUnsaved?: boolean;
  /** Invoked when the person taps the error pill. */
  onRetry?: () => void;
  savedColor?: string;
  compact?: boolean;
}

export default function SaveIndicator({
  status,
  hasUnsaved,
  onRetry,
  savedColor,
  compact,
}: SaveIndicatorProps) {
  const { colors } = useTheme();
  const [mode, setMode] = useState<'idle' | 'saving' | 'saved' | 'error' | 'pending'>('idle');
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const opacity = useSharedValue(0);

  useEffect(() => {
    const clear = () => {
      if (savedTimer.current) {
        clearTimeout(savedTimer.current);
        savedTimer.current = null;
      }
    };

    if (status === 'saving') {
      clear();
      setMode('saving');
      opacity.value = withTiming(1, { duration: 160 });
      return;
    }

    // An error is sticky on purpose: it must not fade out from under someone
    // who has unsaved work.
    if (status === 'error') {
      clear();
      setMode('error');
      opacity.value = withTiming(1, { duration: 160 });
      return;
    }

    if (status === 'pending' && hasUnsaved) {
      clear();
      setMode('pending');
      opacity.value = withTiming(1, { duration: 160 });
      return;
    }

    if (status === 'saved') {
      clear();
      setMode('saved');
      opacity.value = withTiming(1, { duration: 160 });
      savedTimer.current = setTimeout(() => {
        opacity.value = withTiming(0, { duration: 320 });
        savedTimer.current = setTimeout(() => setMode('idle'), 340);
      }, 1400);
      return;
    }

    return clear;
  }, [status, hasUnsaved, opacity]);

  useEffect(() => () => {
    if (savedTimer.current) clearTimeout(savedTimer.current);
  }, []);

  const animStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));

  if (mode === 'idle') return null;

  const isSaved = mode === 'saved';
  const isError = mode === 'error';
  const isPending = mode === 'pending';

  const label = isError ? 'Not saved' : isSaved ? 'Saved' : isPending ? 'Unsaved' : 'Saving...';
  const tone = isError
    ? colors.error
    : isSaved
      ? (savedColor ?? colors.success)
      : colors.muted;

  const body = (
    <Animated.View
      style={[styles.wrap, { paddingHorizontal: compact ? 4 : 6 }, animStyle]}
      accessibilityRole={isError ? 'button' : 'text'}
      accessibilityLabel={isError ? 'Changes not saved. Tap to retry.' : label}
      accessibilityHint={isError ? 'Retries the last save' : undefined}
      accessibilityLiveRegion={isError ? 'assertive' : 'polite'}
      testID="save-indicator"
    >
      {isError ? (
        <Ionicons name="cloud-offline" size={compact ? 13 : 14} color={tone} style={styles.icon} />
      ) : isSaved ? (
        <Ionicons name="checkmark-circle" size={compact ? 13 : 14} color={tone} style={styles.icon} />
      ) : isPending ? (
        <Ionicons name="ellipse-outline" size={compact ? 13 : 14} color={tone} style={styles.icon} />
      ) : (
        <View style={styles.dotsWrap}>
          <SavingDots color={tone} />
        </View>
      )}
      <Text style={[styles.label, { color: tone, fontSize: compact ? typeScale.xs : typeScale.sm }]}>
        {label}
      </Text>
    </Animated.View>
  );

  if (isError && onRetry) {
    return (
      <Pressable onPress={onRetry} testID="save-indicator-retry" hitSlop={8}>
        {body}
      </Pressable>
    );
  }
  return body;
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
