import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '@/src/theme/ThemeContext';

/**
 * Snackbar-style toast used across the app for reversible destructive actions
 * (move to trash, restore, move to folder, etc.). Shows a short message and an
 * optional action button (typically "Undo") that fires an async callback.
 *
 * Contract:
 *   const { show } = useToast();
 *   show({
 *     message: 'Moved 3 notes to Trash',
 *     actionLabel: 'Undo',
 *     onAction: async () => { ...revert... },
 *     tone: 'default' | 'success' | 'destructive' | 'info',
 *     duration: 4000,   // ms; -1 = sticky until dismissed
 *   });
 *
 * The toast slides up from the bottom, respects safe-area insets, and can be
 * swiped away (tap "×") or dismissed automatically. Multiple `show()` calls in
 * rapid succession replace the current toast so the user always sees the most
 * recent action.
 */

export type ToastTone = 'default' | 'success' | 'destructive' | 'info';

export interface ToastOptions {
  message: string;
  actionLabel?: string;
  onAction?: () => void | Promise<void>;
  duration?: number; // ms; default 4000. Pass -1 to keep sticky.
  tone?: ToastTone;
}

interface ToastCtx {
  show: (opts: ToastOptions) => void;
  hide: () => void;
}

const ToastContext = createContext<ToastCtx | null>(null);

const DEFAULT_DURATION = 4000;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();

  // Only ever one toast on screen — a new show() replaces the current one.
  const [current, setCurrent] = useState<ToastOptions | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reanimated shared values for entrance/exit.
  const translateY = useSharedValue(120);
  const opacity = useSharedValue(0);

  const clearTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const dismiss = useCallback(() => {
    clearTimer();
    translateY.value = withTiming(120, {
      duration: 220,
      easing: Easing.in(Easing.cubic),
    });
    opacity.value = withTiming(0, { duration: 220 }, (finished) => {
      if (finished) runOnJS(setCurrent)(null);
    });
  }, [opacity, translateY]);

  const show = useCallback(
    (opts: ToastOptions) => {
      clearTimer();
      // Immediately swap content (small crossfade would be nicer but this is
      // cleanest and never leaves an ambiguous state).
      setCurrent(opts);
      translateY.value = withTiming(0, {
        duration: 280,
        easing: Easing.out(Easing.cubic),
      });
      opacity.value = withTiming(1, { duration: 200 });
      const dur = opts.duration ?? DEFAULT_DURATION;
      if (dur > 0) {
        timerRef.current = setTimeout(() => {
          dismiss();
        }, dur);
      }
    },
    [dismiss, opacity, translateY]
  );

  const value = useMemo<ToastCtx>(() => ({ show, hide: dismiss }), [show, dismiss]);

  // Clean up timer on unmount.
  useEffect(() => () => clearTimer(), []);

  const style = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
    opacity: opacity.value,
  }));

  const toneAccent = (() => {
    if (!current) return colors.brand;
    switch (current.tone) {
      case 'success':
        return colors.success;
      case 'destructive':
        return colors.error;
      case 'info':
        return colors.info;
      default:
        return colors.brand;
    }
  })();

  const handleAction = () => {
    const cb = current?.onAction;
    dismiss();
    if (cb) {
      // Fire after the exit animation begins so UI doesn't jitter.
      setTimeout(() => {
        try {
          Promise.resolve(cb()).catch(() => {});
        } catch {
          /* swallow */
        }
      }, 40);
    }
  };

  return (
    <ToastContext.Provider value={value}>
      {children}
      {current ? (
        <View
          pointerEvents="box-none"
          style={[
            styles.wrapper,
            {
              // Leave room for a bottom FAB (56dp) + safe area. Feels closest
              // to material snackbar behaviour on Android.
              bottom: Math.max(insets.bottom, 8) + 72,
            },
          ]}
        >
          <Animated.View
            style={[
              styles.pill,
              {
                backgroundColor: colors.surfaceInverse,
                shadowColor: '#000',
              },
              style,
            ]}
          >
            <View style={[styles.accent, { backgroundColor: toneAccent }]} />
            <Text
              style={[styles.message, { color: colors.onSurfaceInverse }]}
              numberOfLines={2}
            >
              {current.message}
            </Text>
            {current.actionLabel && current.onAction ? (
              <Pressable
                onPress={handleAction}
                style={({ pressed }) => [
                  styles.actionBtn,
                  { opacity: pressed ? 0.6 : 1 },
                ]}
                testID="toast-action"
              >
                <Text style={[styles.actionText, { color: toneAccent }]}>
                  {current.actionLabel.toUpperCase()}
                </Text>
              </Pressable>
            ) : null}
            <Pressable
              onPress={dismiss}
              hitSlop={10}
              style={styles.closeBtn}
              testID="toast-close"
            >
              <Ionicons
                name="close"
                size={18}
                color={colors.onSurfaceInverse}
              />
            </Pressable>
          </Animated.View>
        </View>
      ) : null}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastCtx {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    // Fallback no-ops so accidentally calling before mount doesn't crash.
    return {
      show: () => {
        if (__DEV__) console.warn('useToast called outside <ToastProvider>');
      },
      hide: () => {},
    };
  }
  return ctx;
}

const styles = StyleSheet.create({
  wrapper: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    paddingHorizontal: 12,
    // Toast should always sit above modals & FAB.
    zIndex: 9999,
    elevation: 32,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 48,
    maxWidth: 560,
    width: '100%',
    borderRadius: 14,
    paddingVertical: 8,
    paddingLeft: 16,
    paddingRight: 4,
    // Elevation on Android; shadow on iOS.
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.28,
    shadowRadius: 12,
    ...Platform.select({
      android: { elevation: 10 },
      default: {},
    }),
    overflow: 'hidden',
  },
  accent: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 4,
  },
  message: {
    flex: 1,
    fontSize: 14,
    fontWeight: '500',
    lineHeight: 18,
    marginLeft: 4,
    marginRight: 8,
  },
  actionBtn: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
  },
  actionText: {
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 0.4,
  },
  closeBtn: {
    padding: 8,
    marginLeft: 2,
    borderRadius: 20,
  },
});
