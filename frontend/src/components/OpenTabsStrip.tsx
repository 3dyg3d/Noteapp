import React from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';

import { useTheme } from '@/src/theme/ThemeContext';
import { spacing, typeScale } from '@/src/theme/tokens';
import { useOpenTabs } from '@/src/state/useOpenTabs';

interface Props {
  currentId: string;
  /** Optional element rendered to the LEFT of the tabs (e.g. back button). */
  leftSlot?: React.ReactNode;
  /** Optional element rendered to the RIGHT of the tabs (e.g. more / new tab). */
  rightSlot?: React.ReactNode;
  /** Hide the strip when only one tab (or none) is open. Default = false (always show). */
  hideWhenSingle?: boolean;
}

/**
 * Chrome-style open-tabs strip. Each tab has rounded top corners and a flat
 * bottom so the active tab visually "merges" with the content below.
 */
export default function OpenTabsStrip({
  currentId,
  leftSlot,
  rightSlot,
  hideWhenSingle = false,
}: Props) {
  const router = useRouter();
  const { colors } = useTheme();
  const { tabs, closeTab } = useOpenTabs();

  if (hideWhenSingle && tabs.length <= 1) return null;

  return (
    <View
      style={[
        styles.wrap,
        {
          backgroundColor: colors.surfaceSecondary,
          borderBottomColor: colors.divider,
        },
      ]}
    >
      {leftSlot ? <View style={styles.slot}>{leftSlot}</View> : null}

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scroll}
        style={{ flex: 1 }}
      >
        {tabs.map((t) => {
          const active = t.id === currentId;
          const route = t.type === 'handwriting' ? `/draw/${t.id}` : `/note/${t.id}`;
          return (
            <View
              key={t.id}
              style={[
                styles.tab,
                {
                  backgroundColor: active ? colors.surface : colors.surfaceTertiary,
                  // Active tab is "lifted" — slight shadow & no bottom corner
                  shadowColor: '#000',
                  shadowOffset: { width: 0, height: -1 },
                  shadowOpacity: active ? 0.12 : 0,
                  shadowRadius: active ? 3 : 0,
                  elevation: active ? 3 : 0,
                  borderTopColor: active ? colors.brand : 'transparent',
                  borderTopWidth: 2,
                },
              ]}
            >
              <Pressable
                testID={`opentab-${t.id}`}
                onPress={() => { if (!active) router.replace(route as any); }}
                style={{ flexDirection: 'row', alignItems: 'center', paddingLeft: 12, paddingRight: 4, flex: 1 }}
              >
                <Ionicons
                  name={t.type === 'handwriting' ? 'brush' : 'document-text'}
                  size={14}
                  color={active ? colors.brand : colors.muted}
                />
                <Text
                  numberOfLines={1}
                  style={{
                    marginLeft: 6,
                    maxWidth: 160,
                    color: active ? colors.onSurface : colors.onSurfaceSecondary,
                    fontWeight: active ? '700' : '500',
                    fontSize: typeScale.sm,
                  }}
                >
                  {t.title || 'Untitled'}
                </Text>
              </Pressable>
              <Pressable
                testID={`opentab-close-${t.id}`}
                onPress={async () => {
                  // Navigate FIRST if the closed tab is currently active — this keeps the
                  // current screen visible while the new one mounts so there's no visible
                  // "no active tab" reflow / flash before the next note loads.
                  if (active) {
                    const remaining = tabs.filter((x) => x.id !== t.id);
                    const last = remaining[remaining.length - 1];
                    if (last) router.replace((last.type === 'handwriting' ? `/draw/${last.id}` : `/note/${last.id}`) as any);
                    else router.replace('/');
                  }
                  // Small delay so the navigation transition can commit before the tab
                  // list re-renders — prevents the closed tab from flickering during the swap.
                  setTimeout(() => { closeTab(t.id); }, active ? 60 : 0);
                }}
                style={styles.closeBtn}
                hitSlop={8}
              >
                <Ionicons name="close" size={14} color={active ? colors.muted : colors.muted} />
              </Pressable>
            </View>
          );
        })}
      </ScrollView>

      {rightSlot ? <View style={styles.slot}>{rightSlot}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingTop: 4,
  },
  scroll: {
    paddingHorizontal: 4,
    gap: 2,
    alignItems: 'flex-end',
  },
  slot: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 4,
    height: 40,
  },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 36,
    minWidth: 140,
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
    // Flat bottom — merges with the content area below for Chrome-style look
  },
  closeBtn: {
    paddingHorizontal: 8,
    height: '100%',
    justifyContent: 'center',
  },
});
