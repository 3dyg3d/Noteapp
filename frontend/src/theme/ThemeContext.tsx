import React, { createContext, useContext, useEffect, useMemo, useState, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { StorageKeys } from '@/src/state/storageKeys';
import { useColorScheme } from 'react-native';
import { lightColors, darkColors, AppColors, ACCENTS, AccentKey } from './tokens';

type Mode = 'system' | 'light' | 'dark';

interface ThemeContextValue {
  mode: Mode;
  setMode: (m: Mode) => void;
  accent: AccentKey;
  setAccent: (a: AccentKey) => void;
  isDark: boolean;
  colors: AppColors;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const MODE_KEY = StorageKeys.themeMode;
const ACCENT_KEY = StorageKeys.themeAccent;

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const system = useColorScheme();
  const [mode, setModeState] = useState<Mode>('system');
  const [accent, setAccentState] = useState<AccentKey>('sage');

  useEffect(() => {
    AsyncStorage.getItem(MODE_KEY).then((v) => {
      if (v === 'light' || v === 'dark' || v === 'system') setModeState(v);
    });
    AsyncStorage.getItem(ACCENT_KEY).then((v) => {
      if (v && (v in ACCENTS)) setAccentState(v as AccentKey);
    });
  }, []);

  const setMode = useCallback((m: Mode) => {
    setModeState(m);
    AsyncStorage.setItem(MODE_KEY, m).catch(() => {});
  }, []);

  const setAccent = useCallback((a: AccentKey) => {
    setAccentState(a);
    AsyncStorage.setItem(ACCENT_KEY, a).catch(() => {});
  }, []);

  const isDark = mode === 'system' ? system === 'dark' : mode === 'dark';

  // Merge the selected accent's brand tokens onto the base light/dark palette so
  // the whole app is re-skinned when the user switches accents.
  const colors: AppColors = useMemo(() => {
    const base = isDark ? darkColors : lightColors;
    const brandTokens = isDark ? ACCENTS[accent].dark : ACCENTS[accent].light;
    return { ...base, ...brandTokens };
  }, [isDark, accent]);

  const value = useMemo(
    () => ({ mode, setMode, accent, setAccent, isDark, colors }),
    [mode, isDark, colors, setMode, accent, setAccent]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
