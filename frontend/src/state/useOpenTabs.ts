import { useEffect, useState, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { StorageKeys } from '@/src/state/storageKeys';

const KEY = StorageKeys.openTabs;

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

  /**
   * Open a note in the tab strip.
   *
   * A tab that is already open keeps its position. The previous version
   * filtered the tab out and re-appended it, so simply tapping a tab to switch
   * to it yanked it to the right-hand end and every other tab shifted — the
   * strip reshuffled itself on every navigation, which makes tabs impossible to
   * aim at. Only genuinely new tabs are appended.
   */
  const openTab = useCallback(async (t: Omit<OpenTab, 'openedAt'>) => {
    const cur = await load();
    const existing = cur.findIndex((x) => x.id === t.id);

    if (existing !== -1) {
      // Keep the slot; refresh the title in case the note was renamed.
      const next = cur.slice();
      if (next[existing].title !== t.title) {
        next[existing] = { ...next[existing], ...t };
        save(next);
      }
      return;
    }

    // New tab: append, and drop the OLDEST when over the cap rather than
    // slicing blindly, so the tab you just opened is never the one evicted.
    const next = [...cur, { ...t, openedAt: Date.now() }];
    if (next.length > 8) {
      const oldest = next.reduce((a, b) => (a.openedAt <= b.openedAt ? a : b));
      save(next.filter((x) => x.id !== oldest.id));
    } else {
      save(next);
    }
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
