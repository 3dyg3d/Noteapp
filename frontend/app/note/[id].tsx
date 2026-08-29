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
  useWindowDimensions,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';

import { useTheme } from '@/src/theme/ThemeContext';
import { spacing, radius, typeScale } from '@/src/theme/tokens';
import {
  NotesApi,
  FoldersApi,
  LabelsApi,
  ApiError,
  Note,
  Folder,
  Label,
  ChecklistItem,
} from '@/src/api/client';
import { haptic } from '@/src/state/useAppSettings';
import { usePatchQueue } from '@/src/hooks/usePatchQueue';
import { lockStore } from '@/src/state/lockStore';
import { useToast } from '@/src/components/Toast';
import { useOpenTabs } from '@/src/state/useOpenTabs';
import OpenTabsStrip from '@/src/components/OpenTabsStrip';
import DrawingPad from '@/src/components/DrawingPad';
import SaveIndicator from '@/src/components/SaveIndicator';
import { labelColors } from '@/src/theme/tokens';

function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export default function NoteEditor() {
  const { id, mode: queryMode, unlocked } = useLocalSearchParams<{
    id: string;
    mode?: string;
    unlocked?: string;
  }>();
  const router = useRouter();
  const { colors, isDark } = useTheme();
  const insets = useSafeAreaInsets();
  const { width: winW } = useWindowDimensions();
  const { openTab, renameTab } = useOpenTabs();

  const [note, setNote] = useState<Note | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [labels, setLabels] = useState<Label[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showDrawing, setShowDrawing] = useState(queryMode === 'drawing');
  const [showMore, setShowMore] = useState(false);
  const [showFolderPicker, setShowFolderPicker] = useState(false);
  const [showLabelPicker, setShowLabelPicker] = useState(false);
  const [labelDraftName, setLabelDraftName] = useState('');

  const drawingRef = useRef<any | null>(null);
  const toast = useToast();

  // Server version of the note we last read, for conflict detection.
  const versionRef = useRef<number | undefined>(undefined);

  /**
   * All writes go through one queue. It merges patches rather than replacing
   * them, flushes on unmount and on backgrounding, serialises requests, and
   * surfaces failures instead of swallowing them.
   */
  // `onError` needs to offer a retry, but that retry belongs to the queue being
  // constructed. A ref breaks the cycle.
  const queueRef = useRef<ReturnType<typeof usePatchQueue<Note>> | null>(null);

  const queue = usePatchQueue<Note>({
    save: async (patch) => {
      const saved = await NotesApi.update(id as string, patch, versionRef.current);
      versionRef.current = saved.version;
    },
    delay: 600,
    onError: (err) => {
      const api = err instanceof ApiError ? err : null;
      if (api?.isConflict) {
        // Another device won. Re-read rather than fighting over the note.
        toast.show({ message: 'This note changed elsewhere. Reloading.', tone: 'info' });
        void reload();
        return;
      }
      toast.show({
        message: api?.userMessage ?? 'Could not save your changes.',
        tone: 'destructive',
        // Sticky: an unsaved-changes warning must not time out on its own.
        duration: -1,
        actionLabel: 'Retry',
        onAction: () => queueRef.current?.retry(),
      });
    },
  });

  queueRef.current = queue;

  const reload = useCallback(async () => {
    try {
      const fresh = await NotesApi.get(id as string);
      versionRef.current = fresh.version;
      setNote(fresh);
    } catch (e) {
      console.warn('reload', e);
    }
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setNote(null); // clear previous note so old content doesn't briefly show when switching tabs
    (async () => {
      try {
        const [n, f, l] = await Promise.all([
          NotesApi.get(id as string),
          FoldersApi.list(),
          LabelsApi.list(),
        ]);
        if (cancelled) return;

        // The lock gate lives here, on the screen that renders the content.
        // Previously it lived only on a separate route, so any deep link
        // straight to /note/[id] walked past it.
        if (n.locked && unlocked !== '1' && (await lockStore.isConfigured())) {
          router.replace(`/lock?noteId=${n.id}`);
          return;
        }

        versionRef.current = n.version;
        setNote(n);
        setFolders(f);
        setLabels(l);
        openTab({ id: n.id, title: n.title || 'Untitled', type: 'text' });
      } catch (e) {
        if (cancelled) return;
        // A failed load used to render as a blank editor, which looks exactly
        // like an empty note and invites the person to type over nothing.
        setLoadError(e instanceof ApiError ? e.userMessage : 'Could not open this note.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, unlocked, router, openTab]);

  /** Optimistic local update plus a queued write. */
  const scheduleSave = useCallback(
    (updates: Partial<Note>) => {
      setNote((prev) => (prev ? { ...prev, ...updates } : prev));
      queue.push(updates);
    },
    [queue]
  );

  /** Same queue, but skip the quiet period for deliberate one-off actions. */
  const persistImmediately = useCallback(
    async (updates: Partial<Note>) => {
      setNote((prev) => (prev ? { ...prev, ...updates } : prev));
      queue.push(updates);
      await queue.flush();
    },
    [queue]
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

  const noteLabels = useMemo(
    () =>
      ((note?.label_ids || [])
        .map((lid) => labels.find((l) => l.id === lid))
        .filter(Boolean) as Label[]),
    [note?.label_ids, labels]
  );

  const toggleLabelOnNote = useCallback(
    (labelId: string) => {
      if (!note) return;
      const current = new Set(note.label_ids || []);
      if (current.has(labelId)) current.delete(labelId);
      else current.add(labelId);
      persistImmediately({ label_ids: Array.from(current) });
    },
    [note, persistImmediately]
  );

  const createLabelFromEditor = useCallback(async () => {
    const name = labelDraftName.trim();
    if (!name) return;
    try {
      // Pick a color deterministically from the palette based on existing count.
      const color = labelColors[labels.length % labelColors.length];
      const created = await LabelsApi.create({ name, color });
      const next = [...labels.filter((l) => l.id !== created.id), created];
      setLabels(next);
      setLabelDraftName('');
      // Auto-apply to the current note.
      if (note) {
        const currentIds = new Set(note.label_ids || []);
        currentIds.add(created.id);
        persistImmediately({ label_ids: Array.from(currentIds) });
      }
    } catch (e) {
      console.warn('create label failed', e);
    }
  }, [labelDraftName, labels, note, persistImmediately]);

  if (loadError) {
    // A failed load used to fall through to the blank-surface branch below,
    // which is indistinguishable from an empty note. Someone would start typing
    // into an editor that had nothing behind it.
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: colors.surface,
          alignItems: 'center',
          justifyContent: 'center',
          padding: spacing.xl,
        }}
      >
        <Ionicons name="cloud-offline-outline" size={40} color={colors.muted} />
        <Text
          testID="note-load-error"
          style={{
            color: colors.onSurface,
            fontSize: typeScale.base,
            textAlign: 'center',
            marginTop: spacing.md,
          }}
        >
          {loadError}
        </Text>
        <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg }}>
          <Pressable
            testID="note-load-back"
            accessibilityRole="button"
            onPress={() => router.back()}
            style={{
              paddingHorizontal: spacing.lg,
              paddingVertical: spacing.sm,
              borderRadius: radius.pill,
              borderWidth: 1,
              borderColor: colors.border,
            }}
          >
            <Text style={{ color: colors.onSurface }}>Go back</Text>
          </Pressable>
          <Pressable
            testID="note-load-retry"
            accessibilityRole="button"
            onPress={() => {
              setLoadError(null);
              setLoading(true);
              void reload().finally(() => setLoading(false));
            }}
            style={{
              paddingHorizontal: spacing.lg,
              paddingVertical: spacing.sm,
              borderRadius: radius.pill,
              backgroundColor: colors.brand,
            }}
          >
            <Text style={{ color: colors.onBrandPrimary, fontWeight: '700' }}>Try again</Text>
          </Pressable>
        </View>
      </View>
    );
  }

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
              <SaveIndicator
                status={queue.status}
                hasUnsaved={queue.hasUnsaved}
                onRetry={queue.retry}
                compact
              />
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

        {/* Labels chips row (tap the + chip to open the manager) */}
        <View style={styles.noteLabelRow} testID="note-labels-row">
          {noteLabels.map((l) => (
            <Pressable
              key={l.id}
              testID={`note-label-${l.id}`}
              onPress={() => setShowLabelPicker(true)}
              style={[styles.noteLabelChip, { backgroundColor: l.color + '2E', borderColor: l.color }]}
            >
              <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: l.color, marginRight: 6 }} />
              <Text style={{ color: l.color, fontWeight: '700', fontSize: typeScale.sm }} numberOfLines={1}>
                {l.name}
              </Text>
            </Pressable>
          ))}
          <Pressable
            testID="note-labels-add"
            onPress={() => setShowLabelPicker(true)}
            style={[styles.noteLabelChip, { borderColor: colors.divider, borderStyle: 'dashed' }]}
          >
            <Ionicons name="pricetag-outline" size={12} color={colors.muted} />
            <Text style={{ color: colors.muted, fontWeight: '700', fontSize: typeScale.sm, marginLeft: 4 }}>
              {noteLabels.length ? 'Manage labels' : 'Add label'}
            </Text>
          </Pressable>
        </View>

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
              icon="pricetag-outline"
              label={noteLabels.length ? `Labels (${noteLabels.length})` : 'Add labels'}
              onPress={() => {
                setShowMore(false);
                setShowLabelPicker(true);
              }}
              testID="menu-labels"
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

      {/* Labels picker — toggle labels & create new ones inline */}
      <Modal
        visible={showLabelPicker}
        transparent
        animationType="slide"
        onRequestClose={() => setShowLabelPicker(false)}
      >        <Pressable style={styles.backdrop} onPress={() => setShowLabelPicker(false)}>
          <Pressable
            onPress={(e) => e.stopPropagation && e.stopPropagation()}
            style={[
              styles.sheet,
              { backgroundColor: colors.surface, paddingBottom: insets.bottom + spacing.lg, maxHeight: '75%' },
            ]}
          >
            <Text style={[styles.sheetTitle, { color: colors.onSurface }]}>Labels</Text>
            <View style={styles.labelCreateRow}>
              <TextInput
                testID="label-new-input"
                value={labelDraftName}
                onChangeText={setLabelDraftName}
                placeholder="New label name"
                placeholderTextColor={colors.muted}
                style={[
                  styles.labelInput,
                  {
                    color: colors.onSurface,
                    backgroundColor: colors.surfaceSecondary,
                    borderColor: colors.divider,
                  },
                ]}
                returnKeyType="done"
                onSubmitEditing={createLabelFromEditor}
                maxLength={40}
              />
              <Pressable
                testID="label-create-btn"
                onPress={createLabelFromEditor}
                style={{
                  paddingHorizontal: spacing.lg,
                  height: 44,
                  borderRadius: radius.pill,
                  backgroundColor: labelDraftName.trim() ? colors.brand : colors.surfaceSecondary,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
                disabled={!labelDraftName.trim()}
              >
                <Text style={{ color: labelDraftName.trim() ? colors.onBrandPrimary : colors.muted, fontWeight: '700' }}>
                  Create
                </Text>
              </Pressable>
            </View>
            {labels.length === 0 ? (
              <Text style={{ color: colors.muted, textAlign: 'center', marginTop: spacing.lg }}>
                No labels yet. Type a name above and tap Create.
              </Text>
            ) : (
              <ScrollView>
                {labels.map((l) => {
                  const on = (note.label_ids || []).includes(l.id);
                  return (
                    <Pressable
                      key={l.id}
                      testID={`label-toggle-${l.id}`}
                      onPress={() => toggleLabelOnNote(l.id)}
                      style={[styles.folderRow, { borderBottomColor: colors.divider }]}
                    >
                      <View style={[styles.folderDot, { backgroundColor: l.color }]} />
                      <Text style={{ color: colors.onSurface, fontSize: typeScale.lg, flex: 1 }}>{l.name}</Text>
                      <View
                        style={{
                          width: 22,
                          height: 22,
                          borderRadius: 11,
                          borderWidth: 2,
                          borderColor: on ? colors.brand : colors.divider,
                          backgroundColor: on ? colors.brand : 'transparent',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        {on && <Ionicons name="checkmark" size={14} color={colors.onBrandPrimary} />}
                      </View>
                    </Pressable>
                  );
                })}
              </ScrollView>
            )}
            <Pressable
              onPress={() => setShowLabelPicker(false)}
              style={{
                marginTop: spacing.md,
                paddingVertical: spacing.md,
                borderRadius: radius.sm,
                backgroundColor: colors.brand,
                alignItems: 'center',
              }}
              testID="label-picker-done"
            >
              <Text style={{ color: colors.onBrandPrimary, fontWeight: '700' }}>Done</Text>
            </Pressable>
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
  onPress: (e?: any) => void;
  destructive?: boolean;
  testID?: string;
}) {
  const { colors } = useTheme();
  const c = destructive ? colors.error : colors.onSurface;
  return (
    <Pressable
      testID={testID}
      onPress={(e) => onPress(e)}
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
  noteLabelRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 6,
    marginTop: 4,
    marginBottom: spacing.xs,
  },
  noteLabelChip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radius.pill,
    borderWidth: 1,
    maxWidth: 200,
  },
  labelCreateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  labelInput: {
    flex: 1,
    height: 44,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    fontSize: typeScale.lg,
    borderWidth: 1,
  },
});
