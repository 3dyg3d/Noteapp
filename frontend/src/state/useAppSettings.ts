import { useCallback, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';

export type GestureAction = 'none' | 'undo' | 'redo' | 'eraser';
export type SPenAction = 'none' | 'undo' | 'redo' | 'eraser';
export type ToolbarPosition = 'top' | 'bottom' | 'left' | 'right';

export interface AppSettings {
  hapticsEnabled: boolean;
  sPenButton: SPenAction;
  gestureTwoFingerTap: GestureAction;
  gestureThreeFingerTap: GestureAction;
  toolbarPosition: ToolbarPosition;
  palmRejection: boolean;
  // Favourite paper colors for the handwriting prep popup (hex strings, exactly 3).
  favoriteHwColors: string[];
  // Hide the system status bar (time / battery / signal) for a more immersive view.
  statusBarHidden: boolean;
  // When true the handwriting canvas automatically appends a new page when the user
  // strokes near the bottom of the last page. When false a floating "+" button at the
  // bottom of the canvas adds a page manually.
  autoAddPage: boolean;
  // Scale factor for the home-screen note & folder tiles. 1.0 = default column
  // count derived from viewport width; >1 shows FEWER, larger tiles; <1 shows
  // MORE, smaller tiles. Persisted so the user's preferred density sticks.
  homeTileScale: number;
}

const KEY = 'galaxynotes:app-settings';
const DEFAULTS: AppSettings = {
  hapticsEnabled: true,
  sPenButton: 'eraser',
  gestureTwoFingerTap: 'undo',
  gestureThreeFingerTap: 'redo',
  toolbarPosition: 'left',
  palmRejection: false,
  favoriteHwColors: ['#FBFAF6', '#F4ECDA', '#FFF4C4'], // White, Cream, Yellow
  statusBarHidden: false,
  autoAddPage: true,
  homeTileScale: 1.0,
};

let cache: AppSettings | null = null;
const listeners = new Set<(s: AppSettings) => void>();

async function loadFromStorage(): Promise<AppSettings> {
  if (cache) return cache;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    cache = raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache!;
}

async function saveToStorage(next: AppSettings) {
  cache = next;
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(next));
  } catch {}
  listeners.forEach((l) => l(next));
}

export function useAppSettings() {
  const [settings, setSettings] = useState<AppSettings>(cache || DEFAULTS);

  useEffect(() => {
    let mounted = true;
    loadFromStorage().then((s) => {
      if (mounted) setSettings(s);
    });
    const listener = (s: AppSettings) => setSettings(s);
    listeners.add(listener);
    return () => {
      mounted = false;
      listeners.delete(listener);
    };
  }, []);

  const update = useCallback(async (patch: Partial<AppSettings>) => {
    const current = (await loadFromStorage()) || DEFAULTS;
    const next = { ...current, ...patch };
    await saveToStorage(next);
  }, []);

  return { settings, update };
}

// Convenience: a settings-aware haptic helper.
export const haptic = {
  selection() {
    if (cache?.hapticsEnabled === false) return;
    Haptics.selectionAsync().catch(() => {});
  },
  light() {
    if (cache?.hapticsEnabled === false) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
  },
  medium() {
    if (cache?.hapticsEnabled === false) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
  },
  success() {
    if (cache?.hapticsEnabled === false) return;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
  },
  error() {
    if (cache?.hapticsEnabled === false) return;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
  },
};

// Preload cache on import so haptic() works before any hook mounts
loadFromStorage();
