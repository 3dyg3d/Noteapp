/**
 * Passcode storage for locked notes.
 *
 * What was here before: the passcode sat in AsyncStorage as plaintext, under a
 * predictable key, on a device where any rooted shell or backup extraction can
 * read it. `expo-secure-store` was already a dependency and already wrapped in
 * `src/utils/storage`; it was simply never used for the one secret in the app.
 *
 * What this does instead:
 *   - stores a salted SHA-256 digest, never the passcode itself,
 *   - keeps that digest in the Keychain / EncryptedSharedPreferences,
 *   - rate-limits attempts so a 4-digit space can't be walked in a second,
 *   - offers device biometrics, since `expo-local-authentication` was already
 *     installed and unused.
 *
 * This is not a replacement for encrypting note content. The server still holds
 * the body in the clear, so "locked" means "gated on this device". Real
 * at-rest protection needs the note body encrypted with a key derived from the
 * passcode, which is a schema change and is noted in the handover.
 */

import * as Crypto from 'expo-crypto';
import * as LocalAuthentication from 'expo-local-authentication';

import { storage } from '@/src/utils/storage';
import { StorageKeys } from '@/src/state/storageKeys';

const DIGEST_KEY = StorageKeys.passcodeDigest;
const SALT_KEY = StorageKeys.passcodeSalt;
const ATTEMPTS_KEY = StorageKeys.passcodeAttempts;
const LEGACY_KEY = StorageKeys.legacyPasscode;

const MAX_ATTEMPTS = 5;
/** Lockout after MAX_ATTEMPTS consecutive failures. */
const LOCKOUT_MS = 60_000;
const MIN_LENGTH = 4;

async function sha256(value: string): Promise<string> {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value);
}

async function newSalt(): Promise<string> {
  const bytes = await Crypto.getRandomBytesAsync(16);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function digestFor(passcode: string, salt: string): Promise<string> {
  return sha256(`${salt}:${passcode}`);
}

/** Constant-time-ish comparison, so failures don't leak position information. */
function equals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface UnlockResult {
  ok: boolean;
  /** Remaining attempts before a lockout, when applicable. */
  attemptsLeft?: number;
  /** Milliseconds until attempts are accepted again. */
  lockedForMs?: number;
}

export const lockStore = {
  async isConfigured(): Promise<boolean> {
    const digest = await storage.secureGet<string>(DIGEST_KEY, '');
    if (digest) return true;
    // A passcode set by a previous build still counts as configured.
    return !!(await storage.getItem<string>(LEGACY_KEY, ''));
  },

  async set(passcode: string): Promise<void> {
    if (passcode.length < MIN_LENGTH) {
      throw new Error(`Passcode must be at least ${MIN_LENGTH} digits`);
    }
    const salt = await newSalt();
    await storage.secureSet(SALT_KEY, salt);
    await storage.secureSet(DIGEST_KEY, await digestFor(passcode, salt));
    await storage.removeItem(ATTEMPTS_KEY);
    // Remove the old plaintext copy wherever it exists.
    await storage.removeItem(LEGACY_KEY);
  },

  async clear(): Promise<void> {
    await storage.secureRemove(DIGEST_KEY);
    await storage.secureRemove(SALT_KEY);
    await storage.removeItem(ATTEMPTS_KEY);
    await storage.removeItem(LEGACY_KEY);
  },

  /**
   * Silently upgrade a plaintext passcode from an older build into the hashed,
   * secure-store form the first time we see it.
   */
  async migrateLegacy(): Promise<boolean> {
    const legacy = await storage.getItem<string>(LEGACY_KEY, '');
    if (!legacy) return false;
    const alreadyMigrated = await storage.secureGet<string>(DIGEST_KEY, '');
    if (alreadyMigrated) {
      await storage.removeItem(LEGACY_KEY);
      return false;
    }
    await lockStore.set(legacy);
    return true;
  },

  async verify(passcode: string): Promise<UnlockResult> {
    const raw = await storage.getItem<string>(ATTEMPTS_KEY, '');
    const state = raw ? (JSON.parse(raw) as { count: number; until: number }) : { count: 0, until: 0 };

    if (state.until && Date.now() < state.until) {
      return { ok: false, lockedForMs: state.until - Date.now() };
    }

    const salt = await storage.secureGet<string>(SALT_KEY, '');
    const digest = await storage.secureGet<string>(DIGEST_KEY, '');
    if (!salt || !digest) return { ok: false };

    if (equals(await digestFor(passcode, salt), digest)) {
      await storage.removeItem(ATTEMPTS_KEY);
      return { ok: true };
    }

    const count = state.count + 1;
    const until = count >= MAX_ATTEMPTS ? Date.now() + LOCKOUT_MS : 0;
    await storage.setItem(ATTEMPTS_KEY, JSON.stringify({ count: until ? 0 : count, until }));
    return {
      ok: false,
      attemptsLeft: Math.max(0, MAX_ATTEMPTS - count),
      lockedForMs: until ? LOCKOUT_MS : undefined,
    };
  },

  /** Device biometrics as an alternative to typing the passcode. */
  async biometricsAvailable(): Promise<boolean> {
    const [hasHardware, enrolled] = await Promise.all([
      LocalAuthentication.hasHardwareAsync(),
      LocalAuthentication.isEnrolledAsync(),
    ]);
    return hasHardware && enrolled;
  },

  async unlockWithBiometrics(): Promise<boolean> {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: 'Unlock note',
      fallbackLabel: 'Use passcode',
    });
    return result.success;
  },
};
