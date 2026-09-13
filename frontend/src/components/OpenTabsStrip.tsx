import React, { useRef, useState } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet, Modal, TextInput, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';

import { useTheme } from '@/src/theme/ThemeContext';
import { typeScale, spacing, radius } from '@/src/theme/tokens';
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
  const { tabs, closeTab, renameTab } = useOpenTabs();
  const { width: winW } = useWindowDimensions();

  /** Rename popover: which tab, where it was tapped, and the draft text. */
  const [renaming, setRenaming] = useState<{ id: string; title: string; x: number; y: number } | null>(null);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<TextInput>(null);

  const commitRename = () => {
    if (!renaming) return;
    const next = draft.trim();
    if (next && next !== renaming.title) renameTab(renaming.id, next);
    setRenaming(null);
  };

  if (hideWhenSingle && tabs.length <= 1) return null;

  const renamePopover = renaming ? (
    <Modal visible transparent animationType="fade" onRequestClose={() => setRenaming(null)}>
      <Pressable style={{ flex: 1 }} onPressIn={commitRename}>
        <Pressable
          onPress={(e) => e.stopPropagation && e.stopPropagation()}
          style={{
            position: 'absolute',
            // Hang just below the tab that was tapped, clamped so a tab near
            // either edge doesn't push the field off screen.
            top: renaming.y + 12,
            left: Math.max(8, Math.min(renaming.x - 110, winW - 236)),
            width: 228,
            backgroundColor: colors.surface,
            borderRadius: radius.md,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: colors.border,
            padding: spacing.sm,
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 6 },
            shadowOpacity: 0.28,
            shadowRadius: 14,
            elevation: 14,
          }}
        >
          <Text style={{ color: colors.muted, fontSize: typeScale.sm, marginBottom: 4 }}>Rename note</Text>
          <TextInput
            ref={inputRef}
            testID="tab-rename-input"
            value={draft}
            onChangeText={setDraft}
            onSubmitEditing={commitRename}
            autoFocus
            selectTextOnFocus
            returnKeyType="done"
            placeholder="Untitled"
            placeholderTextColor={colors.muted}
            style={{
              color: colors.onSurface,
              backgroundColor: colors.surfaceSecondary,
              borderRadius: radius.sm,
              paddingHorizontal: spacing.sm,
              paddingVertical: 6,
              fontSize: typeScale.base,
            }}
          />
          <View style={{ flexDirection: 'row', justifyContent: 'flex-end', marginTop: spacing.sm, gap: spacing.sm }}>
            <Pressable testID="tab-rename-cancel" onPress={() => setRenaming(null)} hitSlop={6}>
              <Text style={{ color: colors.muted, fontWeight: '600' }}>Cancel</Text>
            </Pressable>
            <Pressable testID="tab-rename-save" onPress={commitRename} hitSlop={6}>
              <Text style={{ color: colors.brand, fontWeight: '700' }}>Save</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  ) : null;

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
                // onPressIn: a Pressable inside a horizontal ScrollView holds
                // onPress back until the gesture is ruled out as a scroll, and
                // cancels entirely on a few pixels of drift — which is why
                // switching tabs felt laggy and sometimes took two or three
                // taps. Switching on touch-down is immediate.
                onPressIn={(e) => {
                  if (active) {
                    // Tapping the tab you're already on has nothing to navigate
                    // to, so use it to rename. Anchored at the touch point so
                    // the field appears where the finger already is.
                    const { pageX, pageY } = e.nativeEvent;
                    setDraft(t.title || '');
                    setRenaming({ id: t.id, title: t.title || '', x: pageX, y: pageY });
                    return;
                  }
                  // Find the type of the CURRENT tab so we can decide whether to swap
                  // params (same type — no transition) or do a stack replace.
                  const cur = tabs.find((x) => x.id === currentId);
                  if (cur && cur.type === t.type) {
                    router.setParams({ id: t.id } as any);
                  } else {
                    router.replace(route as any);
                  }
                }}
                hitSlop={4}
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
                  if (active) {
                    const remaining = tabs.filter((x) => x.id !== t.id);
                    const last = remaining[remaining.length - 1];
                    if (last) {
                      // If the next tab is the SAME type as the one being closed, we can
                      // just swap the route param — the screen stays mounted, no stack
                      // transition, and the environment feels unchanged.
                      if (last.type === t.type) {
                        router.setParams({ id: last.id } as any);
                      } else {
                        router.replace((last.type === 'handwriting' ? `/draw/${last.id}` : `/note/${last.id}`) as any);
                      }
                    } else {
                      router.replace('/');
                    }
                  }
                  // Delay closing the tab record slightly so the strip doesn't flicker
                  // during the (setParams) or (replace) swap.
                  setTimeout(() => { closeTab(t.id); }, active ? 40 : 0);
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
      {renamePopover}
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
