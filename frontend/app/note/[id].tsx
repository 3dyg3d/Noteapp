import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  Pressable,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Modal,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';

import { useTheme } from '@/src/theme/ThemeContext';
import { spacing, radius, typeScale } from '@/src/theme/tokens';
import { NotesApi, FoldersApi, AiApi, Note, Folder, ChecklistItem } from '@/src/api/client';
import { haptic } from '@/src/state/useAppSettings';
import { useOpenTabs } from '@/src/state/useOpenTabs';
import OpenTabsStrip from '@/src/components/OpenTabsStrip';
import DrawingPad from '@/src/components/DrawingPad';

function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export default function NoteEditor() {
  const { id, mode: queryMode } = useLocalSearchParams<{ id: string; mode?: string }>();
  const router = useRouter();
  const { colors, isDark } = useTheme();
  const insets = useSafeAreaInsets();
  const { openTab, renameTab } = useOpenTabs();

  const [note, setNote] = useState<Note | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showDrawing, setShowDrawing] = useState(queryMode === 'drawing');
  const [showMore, setShowMore] = useState(false);
  const [showFolderPicker, setShowFolderPicker] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiSummary, setAiSummary] = useState<string | null>(null);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const drawingRef = useRef<any | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setNote(null); // clear previous note so old content doesn't briefly show when switching tabs
    (async () => {
      try {
        const [n, f] = await Promise.all([NotesApi.get(id as string), FoldersApi.list()]);
        if (cancelled) return;
        setNote(n);
        setFolders(f);
        openTab({ id: n.id, title: n.title || 'Untitled', type: 'text' });
      } catch (e) {
        console.warn(e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [id]);

  const scheduleSave = useCallback(
    (updates: Partial<Note>) => {
      setNote((prev) => (prev ? { ...prev, ...updates } : prev));
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(async () => {
        if (!note) return;
        try {
          setSaving(true);
          await NotesApi.update(id as string, updates);
        } catch (e) {
          console.warn('save', e);
        } finally {
          setSaving(false);
        }
      }, 600);
    },
    [id, note]
  );

  const persistImmediately = useCallback(
    async (updates: Partial<Note>) => {
      setNote((prev) => (prev ? { ...prev, ...updates } : prev));
      try {
        setSaving(true);
        await NotesApi.update(id as string, updates);
      } catch (e) {
        console.warn(e);
      } finally {
        setSaving(false);
      }
    },
    [id]
  );

  const addChecklistItem = () => {
    if (!note) return;
    const newItem: ChecklistItem = { id: uid(), text: '', done: false };
    const list = [...note.checklist, newItem];
    scheduleSave({ checklist: list });
  };

  const updateChecklistItem = (itemId: string, patch: Partial<ChecklistItem>) => {
    if (!note) return;
    const list = note.checklist.map((c) => (c.id === itemId ? { ...c, ...patch } : c));
    scheduleSave({ checklist: list });
  };

  const removeChecklistItem = (itemId: string) => {
    if (!note) return;
    scheduleSave({ checklist: note.checklist.filter((c) => c.id !== itemId) });
  };

  const pickImage = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return;
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      base64: true,
      quality: 0.6,
    });
    if (!res.canceled && res.assets[0]?.base64 && note) {
      const dataUri = `data:image/jpeg;base64,${res.assets[0].base64}`;
      persistImmediately({ images: [...note.images, dataUri] });
    }
  };

  const removeImage = (idx: number) => {
    if (!note) return;
    persistImmediately({ images: note.images.filter((_, i) => i !== idx) });
  };

  const togglePin = () => {
    if (!note) return;
    haptic.selection();
    persistImmediately({ pinned: !note.pinned });
  };

  const toggleLock = () => {
    if (!note) return;
    persistImmediately({ locked: !note.locked });
  };

  const deleteNote = async () => {
    try {
      await NotesApi.remove(id as string);
      router.back();
    } catch (e) {
      console.warn(e);
    }
  };

  const summarize = async () => {
    if (!note) return;
    const text = [note.title, note.content, ...note.checklist.map((c) => `- ${c.text}`)]
      .join('\n')
      .trim();
    if (!text) return;
    try {
      setAiLoading(true);
      const r = await AiApi.summarize(text);
      setAiSummary(r.summary);
    } catch (e: any) {
      setAiSummary(`Failed: ${e?.message || e}`);
    } finally {
      setAiLoading(false);
    }
  };

  const insertFormatting = (kind: 'bold' | 'italic' | 'heading' | 'bullet') => {
    if (!note) return;
    const map: Record<typeof kind, string> = {
      bold: '**bold** ',
      italic: '_italic_ ',
      heading: '\n# Heading\n',
      bullet: '\n• ',
    };
    scheduleSave({ content: (note.content || '') + map[kind] });
  };

  const currentFolder = useMemo(
    () => (note?.folder_id ? folders.find((f) => f.id === note.folder_id) : undefined),
    [note?.folder_id, folders]
  );

  if (loading || !note) {
    // Plain surface — no spinner — to avoid a flash when switching between open tabs.
    return <View style={{ flex: 1, backgroundColor: colors.surface }} />;
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colors.surface }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {/* Chrome-style tabs row with back arrow inline */}
      <View style={{ paddingTop: insets.top, backgroundColor: colors.surfaceSecondary }}>
        <OpenTabsStrip
          currentId={id as string}
          leftSlot={
            <Pressable
              testID="back-btn"
              onPress={() => router.back()}
              style={{
                width: 36,
                height: 36,
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 18,
              }}
              hitSlop={6}
            >
              <Ionicons name="chevron-back" size={24} color={colors.onSurface} />
            </Pressable>
          }
          rightSlot={
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
              {saving && (
                <Text style={{ color: colors.muted, fontSize: typeScale.sm, marginRight: 4 }}>
                  Saving…
                </Text>
              )}
              <Pressable testID="pin-btn" onPress={togglePin} style={{ width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 18 }} hitSlop={6}>
                <Ionicons
                  name={note.pinned ? 'pin' : 'pin-outline'}
                  size={20}
                  color={note.pinned ? colors.brand : colors.onSurface}
                />
              </Pressable>
              <Pressable testID="more-btn" onPress={() => setShowMore(true)} style={{ width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 18 }} hitSlop={6}>
                <Ionicons name="ellipsis-vertical" size={20} color={colors.onSurface} />
              </Pressable>
            </View>
          }
        />
      </View>

      <ScrollView
        contentContainerStyle={{ padding: spacing.lg, paddingBottom: 160 }}
        keyboardShouldPersistTaps="handled"
      >
        <TextInput
          testID="note-title-input"
          value={note.title}
          onChangeText={(t) => scheduleSave({ title: t })}
          placeholder="Title"
          placeholderTextColor={colors.muted}
          style={[styles.title, { color: colors.onSurface }]}
          multiline
        />

        <TextInput
          testID="note-content-input"
          value={note.content}
          onChangeText={(t) => scheduleSave({ content: t })}
          placeholder="Start writing..."
          placeholderTextColor={colors.muted}
          style={[styles.body, { color: colors.onSurface }]}
          multiline
          textAlignVertical="top"
        />

        {/* Checklist */}
        {note.checklist.length > 0 && (
          <View style={{ marginTop: spacing.lg }}>
            {note.checklist.map((c) => (
              <View key={c.id} style={styles.checkRow} testID={`check-${c.id}`}>
                <Pressable
                  onPress={() => {
                    haptic.selection();
                    updateChecklistItem(c.id, { done: !c.done });
                  }}
                  style={[
                    styles.checkBox,
                    {
                      borderColor: colors.borderStrong,
                      backgroundColor: c.done ? colors.brand : 'transparent',
                    },
                  ]}
                >
                  {c.done && <Ionicons name="checkmark" size={14} color={colors.onBrandPrimary} />}
                </Pressable>
                <TextInput
                  value={c.text}
                  onChangeText={(t) => updateChecklistItem(c.id, { text: t })}
                  placeholder="List item"
                  placeholderTextColor={colors.muted}
                  style={[
                    styles.checkInput,
                    {
                      color: colors.onSurface,
                      textDecorationLine: c.done ? 'line-through' : 'none',
                      opacity: c.done ? 0.6 : 1,
                    },
                  ]}
                />
                <Pressable
                  onPress={() => removeChecklistItem(c.id)}
                  style={styles.iconBtn}
                  testID={`check-remove-${c.id}`}
                >
                  <Ionicons name="close" size={18} color={colors.muted} />
                </Pressable>
              </View>
            ))}
          </View>
        )}

        {/* Images */}
        {note.images.length > 0 && (
          <View style={styles.imageGrid}>
            {note.images.map((src, i) => (
              <View key={i} style={styles.imageWrap}>
                <Image source={{ uri: src }} style={styles.imageEl} contentFit="cover" />
                <Pressable
                  onPress={() => removeImage(i)}
                  style={styles.imageDel}
                  testID={`image-del-${i}`}
                >
                  <Ionicons name="close" size={16} color="#fff" />
                </Pressable>
              </View>
            ))}
          </View>
        )}

        {/* Drawing pad */}
        {showDrawing && (
          <View>
            <View style={styles.drawingHeaderRow}>
              <Text
                style={{
                  color: colors.onSurface,
                  fontSize: typeScale.lg,
                  fontWeight: '700',
                }}
              >
                Handwriting
              </Text>
              <Pressable
                testID="save-drawing-btn"
                onPress={async () => {
                  const b64 = drawingRef.current?.snapshotBase64();
                  if (b64 && note) {
                    persistImmediately({ drawings: [...note.drawings, b64] });
                    drawingRef.current?.clear();
                  }
                }}
                style={[styles.savePenBtn, { backgroundColor: colors.brand }]}
              >
                <Ionicons name="save-outline" size={16} color={colors.onBrandPrimary} />
                <Text
                  style={{
                    color: colors.onBrandPrimary,
                    marginLeft: 6,
                    fontWeight: '700',
                  }}
                >
                  Save page
                </Text>
              </Pressable>
            </View>
            <DrawingPad ref={drawingRef} height={420} />
          </View>
        )}

        {/* Saved drawing pages */}
        {note.drawings.length > 0 && (
          <View style={{ marginTop: spacing.lg }}>
            <Text
              style={{
                color: colors.muted,
                fontSize: typeScale.sm,
                fontWeight: '600',
                textTransform: 'uppercase',
                letterSpacing: 1.2,
                marginBottom: spacing.sm,
              }}
            >
              Handwritten Pages
            </Text>
            {note.drawings.map((src, i) => (
              <View
                key={i}
                style={[
                  styles.drawingThumb,
                  { backgroundColor: colors.surfaceSecondary, borderColor: colors.border },
                ]}
              >
                <Image source={{ uri: src }} style={styles.drawingThumbImg} contentFit="contain" />
                <Pressable
                  testID={`drawing-del-${i}`}
                  onPress={() =>
                    persistImmediately({
                      drawings: note.drawings.filter((_, idx) => idx !== i),
                    })
                  }
                  style={styles.drawingDel}
                >
                  <Ionicons name="trash-outline" size={16} color="#fff" />
                </Pressable>
              </View>
            ))}
          </View>
        )}

        {/* AI summary card */}
        {!!aiSummary && (
          <View
            style={[
              styles.aiCard,
              { backgroundColor: colors.brandTertiary, borderColor: colors.brand },
            ]}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: spacing.xs }}>
              <Ionicons name="sparkles" size={16} color={colors.brand} />
              <Text style={{ marginLeft: 6, color: colors.brand, fontWeight: '700' }}>
                AI Summary
              </Text>
              <View style={{ flex: 1 }} />
              <Pressable onPress={() => setAiSummary(null)} testID="ai-close">
                <Ionicons name="close" size={16} color={colors.brand} />
              </Pressable>
            </View>
            <Text style={{ color: colors.onSurface, lineHeight: 20 }}>{aiSummary}</Text>
          </View>
        )}
      </ScrollView>

      {/* Bottom toolbar */}
      <View
        style={[
          styles.bottomBar,
          {
            backgroundColor: colors.surface,
            borderTopColor: colors.divider,
            paddingBottom: insets.bottom + spacing.xs,
          },
        ]}
      >
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 4, paddingHorizontal: spacing.xs }}>
          <ToolButton icon="text" label="B" onPress={() => insertFormatting('bold')} testID="fmt-bold" bold />
          <ToolButton icon="text" label="I" onPress={() => insertFormatting('italic')} testID="fmt-italic" italic />
          <ToolButton icon="reorder-three" onPress={() => insertFormatting('heading')} testID="fmt-heading" />
          <ToolButton icon="list" onPress={() => insertFormatting('bullet')} testID="fmt-bullet" />
          <Divider />
          <ToolButton icon="checkbox-outline" onPress={addChecklistItem} testID="add-check" />
          <ToolButton icon="image-outline" onPress={pickImage} testID="add-image" />
          <ToolButton
            icon="brush-outline"
            onPress={() => setShowDrawing((s) => !s)}
            testID="toggle-drawing"
            active={showDrawing}
          />
          <ToolButton
            icon={aiLoading ? 'hourglass-outline' : 'sparkles-outline'}
            onPress={summarize}
            testID="ai-summarize"
          />
        </ScrollView>
      </View>

      {/* More menu modal */}
      <Modal visible={showMore} transparent animationType="fade" onRequestClose={() => setShowMore(false)}>
        <Pressable style={styles.backdrop} onPress={() => setShowMore(false)}>
          <View
            style={[styles.menu, { backgroundColor: colors.surfaceSecondary, top: insets.top + 56 }]}
          >
            <MenuItem
              icon="folder-outline"
              label={currentFolder ? `Folder: ${currentFolder.name}` : 'Move to folder'}
              onPress={() => {
                setShowMore(false);
                setShowFolderPicker(true);
              }}
              testID="menu-folder"
            />
            <MenuItem
              icon={note.locked ? 'lock-open-outline' : 'lock-closed-outline'}
              label={note.locked ? 'Unlock note' : 'Lock note'}
              onPress={() => {
                toggleLock();
                setShowMore(false);
              }}
              testID="menu-lock"
            />
            <MenuItem
              icon="trash-outline"
              label="Delete note"
              destructive
              onPress={() => {
                setShowMore(false);
                deleteNote();
              }}
              testID="menu-delete"
            />
            <MenuItem
              icon="settings-outline"
              label="Settings"
              onPress={() => {
                setShowMore(false);
                router.push('/settings');
              }}
              testID="menu-settings"
            />
          </View>
        </Pressable>
      </Modal>

      {/* Folder picker */}
      <Modal
        visible={showFolderPicker}
        transparent
        animationType="slide"
        onRequestClose={() => setShowFolderPicker(false)}
      >
        <Pressable style={styles.backdrop} onPress={() => setShowFolderPicker(false)}>
          <Pressable
            style={[
              styles.sheet,
              { backgroundColor: colors.surface, paddingBottom: insets.bottom + spacing.lg },
            ]}
          >
            <Text style={[styles.sheetTitle, { color: colors.onSurface }]}>Move to folder</Text>
            <Pressable
              onPress={() => {
                persistImmediately({ folder_id: null });
                setShowFolderPicker(false);
              }}
              style={[styles.folderRow, { borderBottomColor: colors.divider }]}
              testID="folder-none"
            >
              <View style={[styles.folderDot, { backgroundColor: colors.muted }]} />
              <Text style={{ color: colors.onSurface, fontSize: typeScale.lg }}>No folder</Text>
            </Pressable>
            {folders.map((f) => (
              <Pressable
                key={f.id}
                onPress={() => {
                  persistImmediately({ folder_id: f.id });
                  setShowFolderPicker(false);
                }}
                style={[styles.folderRow, { borderBottomColor: colors.divider }]}
                testID={`folder-pick-${f.id}`}
              >
                <View style={[styles.folderDot, { backgroundColor: f.color }]} />
                <Text style={{ color: colors.onSurface, fontSize: typeScale.lg }}>{f.name}</Text>
              </Pressable>
            ))}
            {folders.length === 0 && (
              <Text style={{ color: colors.muted, textAlign: 'center', marginTop: spacing.lg }}>
                No folders yet. Create one from the Folders screen.
              </Text>
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </KeyboardAvoidingView>
  );
}

function ToolButton({
  icon,
  label,
  onPress,
  active,
  testID,
  bold,
  italic,
}: {
  icon: any;
  label?: string;
  onPress: () => void;
  active?: boolean;
  testID?: string;
  bold?: boolean;
  italic?: boolean;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      style={{
        minWidth: 44,
        height: 44,
        paddingHorizontal: 10,
        borderRadius: 22,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: active ? colors.brand : 'transparent',
        flexDirection: 'row',
      }}
    >
      {label ? (
        <Text
          style={{
            color: active ? colors.onBrandPrimary : colors.onSurface,
            fontWeight: bold ? '800' : '500',
            fontStyle: italic ? 'italic' : 'normal',
            fontSize: 18,
          }}
        >
          {label}
        </Text>
      ) : (
        <Ionicons name={icon} size={22} color={active ? colors.onBrandPrimary : colors.onSurface} />
      )}
    </Pressable>
  );
}

function Divider() {
  const { colors } = useTheme();
  return <View style={{ width: 1, height: 24, backgroundColor: colors.divider, marginHorizontal: 6, alignSelf: 'center' }} />;
}

function MenuItem({
  icon,
  label,
  onPress,
  destructive,
  testID,
}: {
  icon: any;
  label: string;
  onPress: () => void;
  destructive?: boolean;
  testID?: string;
}) {
  const { colors } = useTheme();
  const c = destructive ? colors.error : colors.onSurface;
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        padding: spacing.md,
        backgroundColor: pressed ? colors.surfaceTertiary : 'transparent',
        borderRadius: radius.sm,
      })}
    >
      <Ionicons name={icon} size={20} color={c} />
      <Text style={{ marginLeft: 12, fontSize: typeScale.lg, color: c }}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.xs,
    paddingBottom: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  iconBtn: { padding: spacing.sm, minWidth: 40, alignItems: 'center' },
  title: {
    fontSize: typeScale.xxl,
    fontWeight: '700',
    paddingVertical: spacing.sm,
  },
  body: {
    fontSize: typeScale.lg,
    lineHeight: 24,
    minHeight: 200,
    paddingVertical: spacing.sm,
  },
  checkRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6 },
  checkBox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.md,
  },
  checkInput: { flex: 1, fontSize: typeScale.lg, paddingVertical: 0 },
  imageGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.lg },
  imageWrap: { width: 100, height: 100, borderRadius: radius.md, overflow: 'hidden' },
  imageEl: { width: '100%', height: '100%' },
  imageDel: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  drawingHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.lg,
  },
  savePenBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    height: 36,
    borderRadius: radius.pill,
  },
  drawingThumb: {
    height: 200,
    borderRadius: radius.md,
    borderWidth: 1,
    overflow: 'hidden',
    marginBottom: spacing.sm,
    padding: 6,
  },
  drawingThumbImg: { width: '100%', height: '100%' },
  drawingDel: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  aiCard: {
    marginTop: spacing.lg,
    padding: spacing.lg,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  bottomBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: spacing.xs,
  },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.3)' },
  menu: {
    position: 'absolute',
    right: spacing.md,
    minWidth: 220,
    borderRadius: radius.md,
    padding: spacing.xs,
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    padding: spacing.lg,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
  },
  sheetTitle: { fontSize: typeScale.xl, fontWeight: '700', marginBottom: spacing.lg },
  folderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  folderDot: { width: 14, height: 14, borderRadius: 7, marginRight: spacing.md },
});
