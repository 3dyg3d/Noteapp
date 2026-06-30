import { useEffect, useState, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'galaxynotes:open-tabs';

export interface OpenTab {
  id: string;
  title: string;
  type: 'text' | 'handwriting';
  openedAt: number;
}

let cache: OpenTab[] = [];
const listeners = new Set<(tabs: OpenTab[]) => void>();
let loaded = false;

async function load() {
  if (loaded) return cache;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (raw) cache = JSON.parse(raw);
  } catch {}
  loaded = true;
  return cache;
}

async function save(tabs: OpenTab[]) {
  cache = tabs;
  listeners.forEach((l) => l(tabs));
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(tabs));
  } catch {}
}

export function useOpenTabs() {
  const [tabs, setTabs] = useState<OpenTab[]>(cache);

  useEffect(() => {
    load().then(setTabs);
    const l = (next: OpenTab[]) => setTabs(next);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);

  const openTab = useCallback(async (t: Omit<OpenTab, 'openedAt'>) => {
    const cur = await load();
    const filtered = cur.filter((x) => x.id !== t.id);
    const next = [...filtered, { ...t, openedAt: Date.now() }].slice(-8); // keep last 8
    save(next);
  }, []);

  const closeTab = useCallback(async (id: string) => {
    const cur = await load();
    save(cur.filter((x) => x.id !== id));
  }, []);

  const renameTab = useCallback(async (id: string, title: string) => {
    const cur = await load();
    const next = cur.map((t) => (t.id === id ? { ...t, title } : t));
    if (JSON.stringify(next) !== JSON.stringify(cur)) save(next);
  }, []);

  const clearAll = useCallback(async () => save([]), []);

  return { tabs, openTab, closeTab, renameTab, clearAll };
}

load();
