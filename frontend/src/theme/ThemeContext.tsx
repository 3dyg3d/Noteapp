import React, { createContext, useContext, useEffect, useMemo, useState, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useColorScheme } from 'react-native';
import { lightColors, darkColors, AppColors } from './tokens';

type Mode = 'system' | 'light' | 'dark';

interface ThemeContextValue {
  mode: Mode;
  setMode: (m: Mode) => void;
  isDark: boolean;
  colors: AppColors;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const STORAGE_KEY = 'galaxynotes:theme-mode';

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const system = useColorScheme();
  const [mode, setModeState] = useState<Mode>('system');

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((v) => {
      if (v === 'light' || v === 'dark' || v === 'system') setModeState(v);
    });
  }, []);

  const setMode = useCallback((m: Mode) => {
    setModeState(m);
    AsyncStorage.setItem(STORAGE_KEY, m).catch(() => {});
  }, []);

  const isDark = mode === 'system' ? system === 'dark' : mode === 'dark';
  const colors = isDark ? darkColors : lightColors;

  const value = useMemo(
    () => ({ mode, setMode, isDark, colors }),
    [mode, isDark, colors, setMode]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
