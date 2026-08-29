import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, TextInput, Pressable, ActivityIndicator } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

import { useTheme } from '@/src/theme/ThemeContext';
import { spacing, radius, typeScale } from '@/src/theme/tokens';
import { haptic } from '@/src/state/useAppSettings';
import { lockStore } from '@/src/state/lockStore';

export default function LockScreen() {
  const { noteId } = useLocalSearchParams<{ noteId: string }>();
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();

  const [code, setCode] = useState('');
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [lockedUntil, setLockedUntil] = useState(0);
  const [canUseBiometrics, setCanUseBiometrics] = useState(false);
  const resolvedRef = useRef(false);

  const openNote = useCallback(() => {
    if (resolvedRef.current) return;
    resolvedRef.current = true;
    // `unlocked=1` is read by the note screen. The gate is the screen's own
    // check, not merely the presence of this route in the stack.
    router.replace(`/note/${noteId}?unlocked=1`);
  }, [noteId, router]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await lockStore.migrateLegacy();
      const [isSet, bio] = await Promise.all([
        lockStore.isConfigured(),
        lockStore.biometricsAvailable(),
      ]);
      if (cancelled) return;
      setConfigured(isSet);
      setCanUseBiometrics(isSet && bio);
      // Nothing to check against: don't pretend there's a gate here.
      if (!isSet) openNote();
    })();
    return () => {
      cancelled = true;
    };
  }, [openNote]);

  const tryBiometrics = useCallback(async () => {
    try {
      if (await lockStore.unlockWithBiometrics()) {
        haptic.success();
        openNote();
      }
    } catch {
      setMessage('Biometric unlock is unavailable.');
    }
  }, [openNote]);

  // Offer the fingerprint prompt straight away rather than making the person
  // ask for it.
  useEffect(() => {
    if (canUseBiometrics) void tryBiometrics();
  }, [canUseBiometrics, tryBiometrics]);

  const submit = useCallback(
    async (value: string) => {
      if (checking || value.length < 4) return;
      setChecking(true);
      try {
        const result = await lockStore.verify(value);
        if (result.ok) {
          haptic.success();
          openNote();
          return;
        }
        haptic.error();
        setCode('');
        if (result.lockedForMs) {
          setLockedUntil(Date.now() + result.lockedForMs);
          setMessage(`Too many attempts. Try again in ${Math.ceil(result.lockedForMs / 1000)}s.`);
        } else if (typeof result.attemptsLeft === 'number') {
          setMessage(
            result.attemptsLeft === 1
              ? 'Incorrect. 1 attempt left.'
              : `Incorrect. ${result.attemptsLeft} attempts left.`
          );
        } else {
          setMessage('Incorrect passcode.');
        }
      } finally {
        setChecking(false);
      }
    },
    [checking, openNote]
  );

  const isLockedOut = lockedUntil > Date.now();

  useEffect(() => {
    if (!isLockedOut) return;
    const t = setTimeout(() => {
      setLockedUntil(0);
      setMessage(null);
    }, lockedUntil - Date.now());
    return () => clearTimeout(t);
  }, [isLockedOut, lockedUntil]);

  if (configured === null) {
    return (
      <View style={[styles.container, styles.centered, { backgroundColor: colors.surface }]}>
        <ActivityIndicator color={colors.brand} />
      </View>
    );
  }

  return (
    <View
      style={[
        styles.container,
        { backgroundColor: colors.surface, paddingTop: insets.top + spacing.lg },
      ]}
    >
      <Pressable onPress={() => router.back()} testID="lock-back" style={styles.back}>
        <Ionicons name="chevron-back" size={26} color={colors.onSurface} />
      </Pressable>

      <View style={styles.content}>
        <View style={[styles.iconCircle, { backgroundColor: colors.brandTertiary }]}>
          <Ionicons name="lock-closed" size={36} color={colors.brand} />
        </View>
        <Text style={[styles.title, { color: colors.onSurface }]}>Enter passcode</Text>
        <Text style={[styles.sub, { color: colors.muted }]}>This note is protected</Text>

        <TextInput
          testID="lock-input"
          accessibilityLabel="Passcode"
          value={code}
          editable={!isLockedOut && !checking}
          onChangeText={(t) => {
            const cleaned = t.replace(/\D/g, '').slice(0, 8);
            setCode(cleaned);
            setMessage(null);
          }}
          onSubmitEditing={() => submit(code)}
          keyboardType="number-pad"
          returnKeyType="go"
          secureTextEntry
          autoFocus
          placeholder="••••"
          placeholderTextColor={colors.muted}
          style={[
            styles.input,
            {
              color: colors.onSurface,
              backgroundColor: colors.surfaceSecondary,
              borderColor: message ? colors.error : 'transparent',
              borderWidth: 2,
              opacity: isLockedOut ? 0.5 : 1,
            },
          ]}
        />

        {message ? (
          <Text testID="lock-error" style={{ color: colors.error, marginTop: spacing.sm }}>
            {message}
          </Text>
        ) : null}

        <Pressable
          testID="lock-submit"
          accessibilityRole="button"
          disabled={code.length < 4 || isLockedOut || checking}
          onPress={() => submit(code)}
          style={[
            styles.btn,
            { backgroundColor: colors.brand, opacity: code.length < 4 || isLockedOut ? 0.4 : 1 },
          ]}
        >
          {checking ? (
            <ActivityIndicator color={colors.onBrandPrimary} />
          ) : (
            <Text style={{ color: colors.onBrandPrimary, fontWeight: '700' }}>Unlock</Text>
          )}
        </Pressable>

        {canUseBiometrics && (
          <Pressable
            testID="lock-biometrics"
            accessibilityRole="button"
            accessibilityLabel="Unlock with biometrics"
            onPress={tryBiometrics}
            style={styles.bioBtn}
          >
            <Ionicons name="finger-print" size={22} color={colors.brand} />
            <Text style={{ color: colors.brand, fontWeight: '600', marginLeft: spacing.xs }}>
              Use biometrics
            </Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: spacing.lg },
  centered: { alignItems: 'center', justifyContent: 'center' },
  back: { padding: spacing.sm, alignSelf: 'flex-start' },
  content: { flex: 1, alignItems: 'center', paddingTop: 80 },
  iconCircle: {
    width: 96,
    height: 96,
    borderRadius: 48,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xl,
  },
  title: { fontSize: typeScale.xxl, fontWeight: '700' },
  sub: { fontSize: typeScale.base, marginTop: spacing.xs, marginBottom: spacing.xxl },
  input: {
    width: '70%',
    height: 60,
    borderRadius: radius.md,
    fontSize: typeScale.xxl,
    letterSpacing: 16,
    textAlign: 'center',
  },
  btn: {
    marginTop: spacing.xl,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: radius.pill,
    minWidth: 140,
    alignItems: 'center',
  },
  bioBtn: {
    marginTop: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.sm,
  },
});
