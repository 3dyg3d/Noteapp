import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  TextInput,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { useTheme } from '@/src/theme/ThemeContext';
import { spacing, radius, typeScale } from '@/src/theme/tokens';

const PASS_KEY = 'galaxynotes:passcode';

export default function SettingsScreen() {
  const { mode, setMode, colors } = useTheme();
  const insets = useSafeAreaInsets();

  const [passcode, setPasscode] = useState('');
  const [hasPasscode, setHasPasscode] = useState(false);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(PASS_KEY).then((v) => setHasPasscode(!!v));
  }, []);

  const savePasscode = async () => {
    if (passcode.length < 4) return;
    await AsyncStorage.setItem(PASS_KEY, passcode);
    setHasPasscode(true);
    setEditing(false);
    setPasscode('');
  };

  const removePasscode = async () => {
    await AsyncStorage.removeItem(PASS_KEY);
    setHasPasscode(false);
  };

  const Item = ({
    label,
    icon,
    right,
    onPress,
    testID,
    danger,
  }: {
    label: string;
    icon: any;
    right?: React.ReactNode;
    onPress?: () => void;
    testID?: string;
    danger?: boolean;
  }) => (
    <Pressable
      testID={testID}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        {
          backgroundColor: pressed ? colors.surfaceTertiary : colors.surfaceSecondary,
        },
      ]}
    >
      <Ionicons name={icon} size={22} color={danger ? colors.error : colors.onSurface} />
      <Text style={[styles.label, { color: danger ? colors.error : colors.onSurface }]}>
        {label}
      </Text>
      <View style={{ flex: 1 }} />
      {right}
    </Pressable>
  );

  const ThemeOption = ({ value, label }: { value: 'system' | 'light' | 'dark'; label: string }) => {
    const active = mode === value;
    return (
      <Pressable
        testID={`theme-${value}`}
        onPress={() => setMode(value)}
        style={[
          styles.themeBtn,
          { backgroundColor: active ? colors.brand : colors.surfaceSecondary },
        ]}
      >
        <Text
          style={{
            color: active ? colors.onBrandPrimary : colors.onSurface,
            fontWeight: active ? '700' : '500',
          }}
        >
          {label}
        </Text>
      </Pressable>
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.md }]}>
        <Text style={[styles.title, { color: colors.onSurface }]}>Settings</Text>
      </View>

      <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: insets.bottom + 100 }}>
        <Text style={[styles.section, { color: colors.muted }]}>APPEARANCE</Text>
        <View style={styles.themeRow}>
          <ThemeOption value="system" label="System" />
          <ThemeOption value="light" label="Light" />
          <ThemeOption value="dark" label="Dark" />
        </View>

        <Text style={[styles.section, { color: colors.muted, marginTop: spacing.xl }]}>SECURITY</Text>

        {!hasPasscode && !editing && (
          <Item
            label="Set passcode for locked notes"
            icon="lock-closed-outline"
            onPress={() => setEditing(true)}
            testID="set-passcode"
          />
        )}

        {hasPasscode && !editing && (
          <>
            <Item
              label="Passcode is set"
              icon="shield-checkmark-outline"
              right={<Ionicons name="checkmark-circle" size={20} color={colors.success} />}
            />
            <Pressable
              onPress={() => setEditing(true)}
              testID="change-passcode"
              style={({ pressed }) => [
                styles.row,
                {
                  backgroundColor: pressed ? colors.surfaceTertiary : colors.surfaceSecondary,
                  marginTop: spacing.sm,
                },
              ]}
            >
              <Ionicons name="key-outline" size={22} color={colors.onSurface} />
              <Text style={[styles.label, { color: colors.onSurface }]}>Change passcode</Text>
            </Pressable>
            <Item
              label="Remove passcode"
              icon="trash-outline"
              danger
              onPress={removePasscode}
              testID="remove-passcode"
            />
          </>
        )}

        {editing && (
          <View style={[styles.passBox, { backgroundColor: colors.surfaceSecondary }]}>
            <Text style={{ color: colors.muted, marginBottom: spacing.sm }}>
              Enter a 4–8 digit passcode
            </Text>
            <TextInput
              testID="passcode-input"
              value={passcode}
              onChangeText={(t) => setPasscode(t.replace(/\D/g, '').slice(0, 8))}
              keyboardType="number-pad"
              secureTextEntry
              placeholder="••••"
              placeholderTextColor={colors.muted}
              style={[
                styles.input,
                { color: colors.onSurface, backgroundColor: colors.surface },
              ]}
            />
            <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md }}>
              <Pressable
                onPress={() => {
                  setEditing(false);
                  setPasscode('');
                }}
                style={[
                  styles.btn,
                  { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1 },
                ]}
              >
                <Text style={{ color: colors.onSurface }}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={savePasscode}
                testID="save-passcode"
                style={[styles.btn, { backgroundColor: colors.brand }]}
              >
                <Text style={{ color: colors.onBrandPrimary, fontWeight: '700' }}>Save</Text>
              </Pressable>
            </View>
          </View>
        )}

        <Text style={[styles.section, { color: colors.muted, marginTop: spacing.xl }]}>STYLUS</Text>
        <View style={[styles.passBox, { backgroundColor: colors.surfaceSecondary }]}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Ionicons name="pencil" size={22} color={colors.brand} />
            <Text
              style={{
                marginLeft: spacing.sm,
                fontSize: typeScale.lg,
                fontWeight: '700',
                color: colors.onSurface,
              }}
            >
              S Pen ready
            </Text>
          </View>
          <Text style={{ color: colors.muted, marginTop: spacing.sm, lineHeight: 20 }}>
            Open any note, tap the brush icon, and start writing with your S Pen or any stylus.
            Strokes are pressure-aware: write softly for thin lines, press harder for thick ones.
          </Text>
        </View>

        <Text style={[styles.section, { color: colors.muted, marginTop: spacing.xl }]}>ABOUT</Text>
        <Item label="GalaxyNotes v1.0" icon="information-circle-outline" />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
  },
  title: { fontSize: typeScale.xxxl, fontWeight: '700' },
  section: {
    fontSize: typeScale.sm,
    letterSpacing: 1.2,
    fontWeight: '600',
    marginBottom: spacing.sm,
  },
  themeRow: { flexDirection: 'row', gap: spacing.sm },
  themeBtn: {
    flex: 1,
    height: 44,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    gap: spacing.md,
    marginBottom: spacing.sm,
  },
  label: { fontSize: typeScale.lg },
  passBox: {
    padding: spacing.lg,
    borderRadius: radius.md,
    marginTop: spacing.sm,
  },
  input: {
    height: 50,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    fontSize: typeScale.xl,
    letterSpacing: 8,
    textAlign: 'center',
  },
  btn: {
    flex: 1,
    height: 44,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
