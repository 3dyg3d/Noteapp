import { useCallback, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { StorageKeys } from '@/src/state/storageKeys';
import * as Haptics from 'expo-haptics';

export type GestureAction = 'none' | 'undo' | 'redo' | 'eraser';
export type SPenAction = 'none' | 'undo' | 'redo' | 'eraser';
export type ToolbarPosition = 'top' | 'bottom' | 'left' | 'right';

/**
 * The page a new handwritten note starts with. Updated whenever the user picks
 * paper in the setup dialog or changes it inside a note, so "+" gives them the
 * page they actually use instead of asking every time.
 */
export interface PageSetup {
  paper: string;
  paperSize: string;
  customSize?: { w: number; h: number };
  orientation: 'portrait' | 'landscape';
  paperColor: string;
  lineSpacing?: number;
}

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
  /**
   * Default colour of the canvas the pages sit on. A note that has its own
   * canvas colour saved keeps it; this is only the starting point for notes
   * that don't, so changing it doesn't rewrite existing work.
   */
  defaultCanvasColor: string;
  /** Last page setup used; null until the user has chosen one. */
  lastPageSetup: PageSetup | null;
  /** Home list order, remembered across launches. */
  homeSortBy: 'updated' | 'created' | 'title';
  homeSortDir: 'desc' | 'asc';
  /**
   * Draw the stroke being written with the native ink layer (Android). Lower
   * latency; off falls back to the JavaScript path.
   */
  nativeInk: boolean;
  /**
   * With native ink on, draw the wet stroke straight into the on-screen
   * buffer (Android 10+). Lowest latency; can tear briefly on some screens.
   */
  frontBufferInk: boolean;
  /** Hold the pen still at the end of a stroke to snap it to a clean shape. */
  shapeSnap: boolean;
  /** Up to five saved pens (tool, colour, width) on the drawing toolbar. */
  favoritePens: (FavoritePen | null)[];
}

export interface FavoritePen {
  family: string;
  variant: string;
  color: string;
  width: number;
}

const KEY = StorageKeys.appSettings;
const DEFAULTS: AppSettings = {
  hapticsEnabled: true,
  sPenButton: 'eraser',
  gestureTwoFingerTap: 'undo',
  gestureThreeFingerTap: 'redo',
  toolbarPosition: 'left',
  defaultCanvasColor: '#d4d4d4',
  palmRejection: false,
  favoriteHwColors: ['#FBFAF6', '#F4ECDA', '#FFF4C4'], // White, Cream, Yellow
  statusBarHidden: false,
  autoAddPage: true,
  homeTileScale: 1.0,
  lastPageSetup: null,
  homeSortBy: 'updated',
  homeSortDir: 'desc',
  nativeInk: true,
  frontBufferInk: true,
  shapeSnap: true,
  favoritePens: [null, null, null, null, null],
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
  warning() {
    if (cache?.hapticsEnabled === false) return;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
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
