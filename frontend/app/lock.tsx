import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TextInput, Pressable } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';

import { useTheme } from '@/src/theme/ThemeContext';
import { spacing, radius, typeScale } from '@/src/theme/tokens';

const PASS_KEY = 'galaxynotes:passcode';

export default function LockScreen() {
  const { noteId } = useLocalSearchParams<{ noteId: string }>();
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();

  const [code, setCode] = useState('');
  const [stored, setStored] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(PASS_KEY).then(setStored);
  }, []);

  const tryUnlock = (newCode: string) => {
    if (!stored) {
      // No passcode configured; allow access
      router.replace(`/note/${noteId}`);
      return;
    }
    if (newCode.length >= 4 && newCode === stored) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      router.replace(`/note/${noteId}`);
    } else if (newCode.length === stored.length) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
      setError(true);
      setTimeout(() => {
        setCode('');
        setError(false);
      }, 600);
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.surface, paddingTop: insets.top + spacing.lg }]}>
      <Pressable onPress={() => router.back()} testID="lock-back" style={styles.back}>
        <Ionicons name="chevron-back" size={26} color={colors.onSurface} />
      </Pressable>

      <View style={styles.content}>
        <View style={[styles.iconCircle, { backgroundColor: colors.brandTertiary }]}>
          <Ionicons name="lock-closed" size={36} color={colors.brand} />
        </View>
        <Text style={[styles.title, { color: colors.onSurface }]}>Enter passcode</Text>
        <Text style={[styles.sub, { color: colors.muted }]}>
          {stored ? 'This note is protected' : 'No passcode set — tap continue'}
        </Text>

        <TextInput
          testID="lock-input"
          value={code}
          onChangeText={(t) => {
            const cleaned = t.replace(/\D/g, '').slice(0, 8);
            setCode(cleaned);
            tryUnlock(cleaned);
          }}
          keyboardType="number-pad"
          secureTextEntry
          autoFocus
          placeholder="••••"
          placeholderTextColor={colors.muted}
          style={[
            styles.input,
            {
              color: colors.onSurface,
              backgroundColor: colors.surfaceSecondary,
              borderColor: error ? colors.error : 'transparent',
              borderWidth: 2,
            },
          ]}
        />

        {error && (
          <Text style={{ color: colors.error, marginTop: spacing.sm }}>Incorrect passcode</Text>
        )}

        {!stored && (
          <Pressable
            testID="lock-continue"
            onPress={() => router.replace(`/note/${noteId}`)}
            style={[styles.btn, { backgroundColor: colors.brand }]}
          >
            <Text style={{ color: colors.onBrandPrimary, fontWeight: '700' }}>Continue</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: spacing.lg },
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
  },
});
