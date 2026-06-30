import React from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';

import { useTheme } from '@/src/theme/ThemeContext';
import { spacing, radius, typeScale } from '@/src/theme/tokens';
import { useOpenTabs } from '@/src/state/useOpenTabs';

interface Props {
  currentId: string;
}

export default function OpenTabsStrip({ currentId }: Props) {
  const router = useRouter();
  const { colors } = useTheme();
  const { tabs, closeTab } = useOpenTabs();

  if (tabs.length <= 1) return null;

  return (
    <View style={[styles.wrap, { borderBottomColor: colors.divider, backgroundColor: colors.surface }]}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.scroll}>
        {tabs.map((t) => {
          const active = t.id === currentId;
          const route = t.type === 'handwriting' ? `/draw/${t.id}` : `/note/${t.id}`;
          return (
            <View
              key={t.id}
              style={[
                styles.tab,
                {
                  backgroundColor: active ? colors.brandTertiary : colors.surfaceSecondary,
                  borderColor: active ? colors.brand : 'transparent',
                },
              ]}
            >
              <Pressable
                testID={`opentab-${t.id}`}
                onPress={() => { if (!active) router.replace(route as any); }}
                style={{ flexDirection: 'row', alignItems: 'center', paddingLeft: spacing.md, paddingRight: spacing.xs }}
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
                    maxWidth: 130,
                    color: active ? colors.brand : colors.onSurface,
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
                  await closeTab(t.id);
                  if (active) {
                    // route to most recent remaining tab, or back home
                    const remaining = tabs.filter((x) => x.id !== t.id);
                    const last = remaining[remaining.length - 1];
                    if (last) router.replace((last.type === 'handwriting' ? `/draw/${last.id}` : `/note/${last.id}`) as any);
                    else router.replace('/');
                  }
                }}
                style={styles.closeBtn}
                hitSlop={8}
              >
                <Ionicons name="close" size={14} color={colors.muted} />
              </Pressable>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  scroll: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    gap: 6,
  },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 32,
    borderRadius: radius.pill,
    borderWidth: 1.5,
  },
  closeBtn: {
    paddingHorizontal: 8,
    height: '100%',
    justifyContent: 'center',
  },
});
