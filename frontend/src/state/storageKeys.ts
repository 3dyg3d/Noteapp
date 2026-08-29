/**
 * Every persisted key in one place.
 *
 * These were previously inline string literals scattered across the drawing
 * screen, the theme context, settings, and the tab store, all under a
 * `galaxynotes:` prefix. Renaming the app means renaming the namespace, and a
 * blind find-and-replace would have silently orphaned every existing install's
 * theme, passcode, tool widths, saved colours and open tabs: the app would read
 * the new key, find nothing, and quietly reset to defaults.
 *
 * So the keys live here, the old names live here next to them, and
 * `migrateStorageNamespace()` copies anything it finds across exactly once.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const NS = 'geodesic';
const LEGACY_NS = 'galaxynotes';

/** Current keys. Everything in the app should import from here. */
export const StorageKeys = {
  themeMode: `${NS}:theme-mode`,
  themeAccent: `${NS}:theme-accent`,
  appSettings: `${NS}:app-settings`,
  openTabs: `${NS}:open-tabs`,

  quickColors: `${NS}:quick-colors`,
  recentColors: `${NS}:recent-colors`,
  favoriteColors: `${NS}:favorite-colors`,
  toolWidths: `${NS}:tool-widths`,
  eraserMode: `${NS}:eraser-mode`,
  zoomPresets: `${NS}:zoom-presets`,
  rulerPrefs: `${NS}:ruler-prefs`,

  /** Secure-store entries. Handled by lockStore, not the bulk migration. */
  passcodeDigest: `${NS}.passcode.v2`,
  passcodeSalt: `${NS}.passcode.salt.v2`,
  passcodeAttempts: `${NS}.passcode.attempts`,

  /** Plaintext passcode written by builds before the rename. */
  legacyPasscode: `${LEGACY_NS}:passcode`,

  /** Set once the migration below has run, so it never runs twice. */
  migrationMarker: `${NS}:ns-migrated`,
} as const;

/**
 * Plain AsyncStorage keys to carry over, old name to new name. The passcode is
 * deliberately absent: it is not copied verbatim but re-hashed into secure
 * storage by `lockStore.migrateLegacy()`.
 */
const MIGRATIONS: [legacy: string, current: string][] = [
  [`${LEGACY_NS}:theme-mode`, StorageKeys.themeMode],
  [`${LEGACY_NS}:theme-accent`, StorageKeys.themeAccent],
  [`${LEGACY_NS}:app-settings`, StorageKeys.appSettings],
  [`${LEGACY_NS}:open-tabs`, StorageKeys.openTabs],
  [`${LEGACY_NS}:quick-colors`, StorageKeys.quickColors],
  [`${LEGACY_NS}:recent-colors`, StorageKeys.recentColors],
  [`${LEGACY_NS}:favorite-colors`, StorageKeys.favoriteColors],
  [`${LEGACY_NS}:tool-widths`, StorageKeys.toolWidths],
  [`${LEGACY_NS}:eraser-mode`, StorageKeys.eraserMode],
  [`${LEGACY_NS}:zoom-presets`, StorageKeys.zoomPresets],
  [`${LEGACY_NS}:ruler-prefs`, StorageKeys.rulerPrefs],
];

let migrationPromise: Promise<void> | null = null;

/**
 * Copy any preferences written under the old namespace across to the new one.
 *
 * Idempotent, and safe to call from several places at once: the in-flight
 * promise is shared. Never overwrites a value that already exists under the new
 * key, so a fresh preference always beats a stale migrated one. Failures are
 * swallowed on purpose: losing a colour swatch is not a reason to block startup.
 */
export function migrateStorageNamespace(): Promise<void> {
  if (migrationPromise) return migrationPromise;

  migrationPromise = (async () => {
    try {
      if (await AsyncStorage.getItem(StorageKeys.migrationMarker)) return;

      const legacyKeys = MIGRATIONS.map(([legacy]) => legacy);
      const currentKeys = MIGRATIONS.map(([, current]) => current);
      const [legacyPairs, currentPairs] = await Promise.all([
        AsyncStorage.multiGet(legacyKeys),
        AsyncStorage.multiGet(currentKeys),
      ]);

      const alreadySet = new Set(
        currentPairs.filter(([, value]) => value != null).map(([key]) => key)
      );

      const toWrite: [string, string][] = [];
      legacyPairs.forEach(([, value], i) => {
        const [, current] = MIGRATIONS[i];
        if (value != null && !alreadySet.has(current)) toWrite.push([current, value]);
      });

      if (toWrite.length) await AsyncStorage.multiSet(toWrite);
      await AsyncStorage.setItem(StorageKeys.migrationMarker, new Date().toISOString());

      // Only drop the old copies once the new ones are safely written.
      if (toWrite.length) {
        await AsyncStorage.multiRemove(legacyKeys).catch(() => {});
      }
    } catch {
      // Leave the marker unset so a later launch can retry.
      migrationPromise = null;
    }
  })();

  return migrationPromise;
}
