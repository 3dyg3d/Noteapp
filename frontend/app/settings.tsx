import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView, TextInput, Switch, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';

import { useTheme } from '@/src/theme/ThemeContext';
import { spacing, radius, typeScale } from '@/src/theme/tokens';
import { useAppSettings, GestureAction, SPenAction } from '@/src/state/useAppSettings';

const PASS_KEY = 'galaxynotes:passcode';

export default function SettingsScreen() {
  const { mode, setMode, colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { settings, update } = useAppSettings();
  const { width: winW } = useWindowDimensions();
  const wide = winW >= 720;
  const router = useRouter();

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

  const ThemeOption = ({ value, label }: { value: 'system' | 'light' | 'dark'; label: string }) => {
    const active = mode === value;
    return (
      <Pressable
        testID={`theme-${value}`}
        onPress={() => setMode(value)}
        style={[styles.themeBtn, { backgroundColor: active ? colors.brand : colors.surfaceSecondary }]}
      >
        <Text style={{ color: active ? colors.onBrandPrimary : colors.onSurface, fontWeight: active ? '700' : '500' }}>
          {label}
        </Text>
      </Pressable>
    );
  };

  const ActionPicker = ({
    label,
    value,
    options,
    onChange,
    testID,
  }: {
    label: string;
    value: string;
    options: { id: string; label: string }[];
    onChange: (v: any) => void;
    testID: string;
  }) => (
    <View style={[styles.pickerCard, { backgroundColor: colors.surfaceSecondary }]}>
      <Text style={{ color: colors.onSurface, fontSize: typeScale.lg, fontWeight: '600', marginBottom: spacing.sm }}>
        {label}
      </Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs }} testID={testID}>
        {options.map((opt) => {
          const active = value === opt.id;
          return (
            <Pressable
              key={opt.id}
              onPress={() => onChange(opt.id)}
              testID={`${testID}-${opt.id}`}
              style={{
                paddingHorizontal: spacing.md,
                paddingVertical: spacing.xs + 2,
                borderRadius: radius.pill,
                backgroundColor: active ? colors.brand : colors.surface,
                borderWidth: 1,
                borderColor: active ? colors.brand : colors.border,
              }}
            >
              <Text
                style={{
                  color: active ? colors.onBrandPrimary : colors.onSurface,
                  fontWeight: active ? '700' : '500',
                  fontSize: typeScale.sm,
                }}
              >
                {opt.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );

  const actionOptions: { id: GestureAction; label: string }[] = [
    { id: 'undo', label: 'Undo' },
    { id: 'redo', label: 'Redo' },
    { id: 'eraser', label: 'Eraser' },
    { id: 'none', label: 'Off' },
  ];

  type TabKey = 'general' | 'pen' | 'security' | 'about';
  const [activeTab, setActiveTab] = useState<TabKey>('general');
  const tabs: { key: TabKey; label: string; icon: any }[] = [
    { key: 'general', label: 'General', icon: 'options-outline' },
    { key: 'pen', label: 'Pen & Gestures', icon: 'hand-left-outline' },
    { key: 'security', label: 'Security', icon: 'lock-closed-outline' },
    { key: 'about', label: 'About', icon: 'information-circle-outline' },
  ];

  return (
    <View style={{ flex: 1, flexDirection: 'row', backgroundColor: wide ? 'transparent' : colors.surface }}>
      {wide && (
        <Pressable
          testID="settings-backdrop"
          onPress={() => router.back()}
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' }}
        />
      )}
      <View
        style={{
          width: wide ? 480 : '100%',
          backgroundColor: colors.surface,
          alignItems: 'center',
          shadowColor: '#000',
          shadowOffset: { width: -4, height: 0 },
          shadowOpacity: wide ? 0.18 : 0,
          shadowRadius: 16,
          elevation: wide ? 12 : 0,
          borderLeftWidth: wide ? StyleSheet.hairlineWidth : 0,
          borderLeftColor: colors.divider,
        }}
      >
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm, width: '100%' }]}>
        <Text style={[styles.title, { color: colors.onSurface }]} testID="settings-title">
          Settings
        </Text>
      </View>

      {/* Tab bar */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: spacing.md, gap: spacing.sm }}
        style={{ width: '100%', flexGrow: 0, marginBottom: spacing.sm }}
      >
        {tabs.map((t) => {
          const active = activeTab === t.key;
          return (
            <Pressable
              key={t.key}
              onPress={() => setActiveTab(t.key)}
              testID={`settings-tab-${t.key}`}
              style={({ pressed }) => [
                styles.tab,
                {
                  backgroundColor: active
                    ? colors.brand
                    : pressed
                    ? colors.surfaceTertiary
                    : colors.surfaceSecondary,
                },
              ]}
            >
              <Ionicons
                name={t.icon}
                size={16}
                color={active ? colors.onBrandPrimary : colors.onSurface}
              />
              <Text
                style={{
                  color: active ? colors.onBrandPrimary : colors.onSurface,
                  fontWeight: active ? '700' : '500',
                  marginLeft: 6,
                }}
              >
                {t.label}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>

      <ScrollView
        style={{ width: '100%' }}
        contentContainerStyle={{ alignItems: 'center', paddingBottom: insets.bottom + 100 }}
      >
        <View style={{ width: '100%', padding: spacing.lg }}>
        {activeTab === 'general' && (<>
        <Text style={[styles.section, { color: colors.muted }]}>APPEARANCE</Text>
        <View style={styles.themeRow}>
          <ThemeOption value="system" label="System" />
          <ThemeOption value="light" label="Light" />
          <ThemeOption value="dark" label="Dark" />
        </View>

        <View style={[styles.row, { backgroundColor: colors.surfaceSecondary, marginTop: spacing.md }]}>
          <Ionicons name="phone-portrait-outline" size={22} color={colors.onSurface} />
          <View style={{ flex: 1, marginLeft: spacing.md }}>
            <Text style={{ color: colors.onSurface, fontSize: typeScale.lg }}>Hide status bar</Text>
            <Text style={{ color: colors.muted, fontSize: typeScale.sm, marginTop: 2 }}>
              Hide the system bar (time / battery / signal) for an immersive view
            </Text>
          </View>
          <Switch
            testID="toggle-status-bar"
            value={settings.statusBarHidden}
            onValueChange={(v) => update({ statusBarHidden: v })}
            thumbColor={settings.statusBarHidden ? colors.brand : colors.muted}
            trackColor={{ false: colors.border, true: colors.brandTertiary }}
          />
        </View>

        <Text style={[styles.section, { color: colors.muted, marginTop: spacing.xl }]}>FEEDBACK</Text>
        <View style={[styles.row, { backgroundColor: colors.surfaceSecondary }]}>
          <Ionicons name="phone-portrait-outline" size={22} color={colors.onSurface} />
          <View style={{ flex: 1, marginLeft: spacing.md }}>
            <Text style={{ color: colors.onSurface, fontSize: typeScale.lg }}>Haptic feedback</Text>
            <Text style={{ color: colors.muted, fontSize: typeScale.sm, marginTop: 2 }}>
              Vibrate on taps, selections, and save
            </Text>
          </View>
          <Switch
            testID="toggle-haptics"
            value={settings.hapticsEnabled}
            onValueChange={(v) => update({ hapticsEnabled: v })}
            thumbColor={settings.hapticsEnabled ? colors.brand : colors.muted}
            trackColor={{ false: colors.border, true: colors.brandTertiary }}
          />
        </View>
        </>)}

        {activeTab === 'pen' && (<>
        <Text style={[styles.section, { color: colors.muted }]}>S PEN & GESTURES</Text>

        <View style={[styles.row, { backgroundColor: colors.surfaceSecondary, marginBottom: spacing.md }]}>
          <Ionicons name="hand-left-outline" size={22} color={colors.onSurface} />
          <View style={{ flex: 1, marginLeft: spacing.md }}>
            <Text style={{ color: colors.onSurface, fontSize: typeScale.lg }}>Palm rejection</Text>
            <Text style={{ color: colors.muted, fontSize: typeScale.sm, marginTop: 2 }}>
              Single-finger touch scrolls the canvas; S Pen / stylus draws
            </Text>
          </View>
          <Switch
            testID="toggle-palm-rejection"
            value={settings.palmRejection}
            onValueChange={(v) => update({ palmRejection: v })}
            thumbColor={settings.palmRejection ? colors.brand : colors.muted}
            trackColor={{ false: colors.border, true: colors.brandTertiary }}
          />
        </View>

        <ActionPicker
          label="S Pen button"
          value={settings.sPenButton}
          options={actionOptions}
          onChange={(v: SPenAction) => update({ sPenButton: v })}
          testID="spen-action"
        />
        <Text style={{ color: colors.muted, fontSize: typeScale.sm, marginTop: -spacing.sm, marginBottom: spacing.md, paddingHorizontal: spacing.md }}>
          Requires Galaxy Tab / Note device — works in production build.
        </Text>

        <ActionPicker
          label="Two-finger tap"
          value={settings.gestureTwoFingerTap}
          options={actionOptions}
          onChange={(v: GestureAction) => update({ gestureTwoFingerTap: v })}
          testID="gesture-two-finger"
        />
        <ActionPicker
          label="Three-finger tap"
          value={settings.gestureThreeFingerTap}
          options={actionOptions}
          onChange={(v: GestureAction) => update({ gestureThreeFingerTap: v })}
          testID="gesture-three-finger"
        />

        <View style={[styles.row, { backgroundColor: colors.surfaceSecondary, marginTop: spacing.md }]}>
          <Ionicons name="add-circle-outline" size={22} color={colors.onSurface} />
          <View style={{ flex: 1, marginLeft: spacing.md }}>
            <Text style={{ color: colors.onSurface, fontSize: typeScale.lg }}>Auto-add page</Text>
            <Text style={{ color: colors.muted, fontSize: typeScale.sm, marginTop: 2 }}>
              Automatically add a new page when you write near the bottom. When off, tap the
              floating + button to add a page manually.
            </Text>
          </View>
          <Switch
            testID="toggle-auto-add-page"
            value={settings.autoAddPage}
            onValueChange={(v) => update({ autoAddPage: v })}
            thumbColor={settings.autoAddPage ? colors.brand : colors.muted}
            trackColor={{ false: colors.border, true: colors.brandTertiary }}
          />
        </View>
        </>)}

        {activeTab === 'security' && (<>
        <Text style={[styles.section, { color: colors.muted }]}>SECURITY</Text>

        {!hasPasscode && !editing && (
          <Pressable
            testID="set-passcode"
            onPress={() => setEditing(true)}
            style={({ pressed }) => [
              styles.row,
              { backgroundColor: pressed ? colors.surfaceTertiary : colors.surfaceSecondary },
            ]}
          >
            <Ionicons name="lock-closed-outline" size={22} color={colors.onSurface} />
            <Text style={[styles.label, { color: colors.onSurface, marginLeft: spacing.md }]}>
              Set passcode for locked notes
            </Text>
          </Pressable>
        )}

        {hasPasscode && !editing && (
          <>
            <View style={[styles.row, { backgroundColor: colors.surfaceSecondary }]}>
              <Ionicons name="shield-checkmark-outline" size={22} color={colors.success} />
              <Text style={[styles.label, { color: colors.onSurface, marginLeft: spacing.md, flex: 1 }]}>
                Passcode is set
              </Text>
              <Ionicons name="checkmark-circle" size={20} color={colors.success} />
            </View>
            <View style={{ height: spacing.sm }} />
            <Pressable
              testID="change-passcode"
              onPress={() => setEditing(true)}
              style={({ pressed }) => [
                styles.row,
                { backgroundColor: pressed ? colors.surfaceTertiary : colors.surfaceSecondary },
              ]}
            >
              <Ionicons name="key-outline" size={22} color={colors.onSurface} />
              <Text style={[styles.label, { color: colors.onSurface, marginLeft: spacing.md }]}>Change passcode</Text>
            </Pressable>
            <View style={{ height: spacing.sm }} />
            <Pressable
              testID="remove-passcode"
              onPress={removePasscode}
              style={({ pressed }) => [
                styles.row,
                { backgroundColor: pressed ? colors.surfaceTertiary : colors.surfaceSecondary },
              ]}
            >
              <Ionicons name="trash-outline" size={22} color={colors.error} />
              <Text style={[styles.label, { color: colors.error, marginLeft: spacing.md }]}>Remove passcode</Text>
            </Pressable>
          </>
        )}

        {editing && (
          <View style={[styles.passBox, { backgroundColor: colors.surfaceSecondary }]}>
            <Text style={{ color: colors.muted, marginBottom: spacing.sm }}>Enter a 4-8 digit passcode</Text>
            <TextInput
              testID="passcode-input"
              value={passcode}
              onChangeText={(t) => setPasscode(t.replace(/\D/g, '').slice(0, 8))}
              keyboardType="number-pad"
              secureTextEntry
              placeholder="••••"
              placeholderTextColor={colors.muted}
              style={[styles.input, { color: colors.onSurface, backgroundColor: colors.surface }]}
            />
            <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md }}>
              <Pressable
                onPress={() => { setEditing(false); setPasscode(''); }}
                style={[styles.btn, { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1 }]}
              >
                <Text style={{ color: colors.onSurface }}>Cancel</Text>
              </Pressable>
              <Pressable onPress={savePasscode} testID="save-passcode" style={[styles.btn, { backgroundColor: colors.brand }]}>
                <Text style={{ color: colors.onBrandPrimary, fontWeight: '700' }}>Save</Text>
              </Pressable>
            </View>
          </View>
        )}
        </>)}

        {activeTab === 'about' && (<>
        <Text style={[styles.section, { color: colors.muted }]}>ABOUT</Text>
        <View style={[styles.row, { backgroundColor: colors.surfaceSecondary }]}>
          <Ionicons name="information-circle-outline" size={22} color={colors.onSurface} />
          <Text style={[styles.label, { color: colors.onSurface, marginLeft: spacing.md }]}>GalaxyNotes v1.0</Text>
        </View>
        </>)}
        </View>
      </ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: spacing.lg, paddingBottom: spacing.md },
  title: { fontSize: typeScale.xxxl, fontWeight: '700' },
  section: { fontSize: typeScale.sm, letterSpacing: 1.2, fontWeight: '600', marginBottom: spacing.sm },
  themeRow: { flexDirection: 'row', gap: spacing.sm },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
  },
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
  },
  label: { fontSize: typeScale.lg },
  pickerCard: {
    padding: spacing.md,
    borderRadius: radius.md,
    marginBottom: spacing.md,
  },
  passBox: { padding: spacing.lg, borderRadius: radius.md, marginTop: spacing.sm },
  input: {
    height: 50,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    fontSize: typeScale.xl,
    letterSpacing: 8,
    textAlign: 'center',
  },
  btn: { flex: 1, height: 44, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
});
