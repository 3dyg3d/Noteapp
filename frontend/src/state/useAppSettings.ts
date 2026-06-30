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
