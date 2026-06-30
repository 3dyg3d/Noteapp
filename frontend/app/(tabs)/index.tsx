import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  FlatList,
  TextInput,
  ScrollView,
  RefreshControl,
  ActivityIndicator,
  Modal,
  useWindowDimensions,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';

import { useTheme } from '@/src/theme/ThemeContext';
import { spacing, radius, typeScale, folderColors } from '@/src/theme/tokens';
import { NotesApi, FoldersApi, Note, Folder, ChecklistItem, NoteStatus } from '@/src/api/client';
import { haptic } from '@/src/state/useAppSettings';

type ViewMode = 'grid' | 'list';
type CategoryKey = 'all' | 'pinned' | 'trash' | string; // string === folder id

interface Template {
  key: string;
  label: string;
  icon: any;
  description: string;
  apply: () => Partial<Note>;
  mode?: 'drawing';
}

const TEMPLATES: Template[] = [
  {
    key: 'blank',
    label: 'Blank note',
    icon: 'document-outline',
    description: 'Start with an empty page',
    apply: () => ({ title: '', content: '' }),
  },
  {
    key: 'checklist',
    label: 'Checklist',
    icon: 'checkbox-outline',
    description: 'A list of tasks to tick off',
    apply: () => ({
      title: 'Checklist',
      content: '',
      checklist: [
        { id: rid(), text: '', done: false },
        { id: rid(), text: '', done: false },
        { id: rid(), text: '', done: false },
      ] as ChecklistItem[],
    }),
  },
  {
    key: 'meeting',
    label: 'Meeting notes',
    icon: 'people-outline',
    description: 'Agenda, attendees, action items',
    apply: () => ({
      title: 'Meeting notes',
      content:
        'Date: \nAttendees: \n\nAgenda:\n• \n\nDiscussion:\n• \n\nDecisions:\n• \n\nAction items:\n',
      checklist: [
        { id: rid(), text: '', done: false },
        { id: rid(), text: '', done: false },
      ] as ChecklistItem[],
    }),
  },
  {
    key: 'journal',
    label: 'Journal entry',
    icon: 'book-outline',
    description: 'A daily reflection',
    apply: () => ({
      title: `Journal — ${new Date().toLocaleDateString()}`,
      content: 'How I feel today:\n\n\nWhat went well:\n• \n\nWhat I learned:\n• \n\nTomorrow I will:\n• \n',
    }),
  },
  {
    key: 'drawing',
    label: 'Handwriting / S Pen',
    icon: 'brush-outline',
    description: 'Full canvas with pens, shapes, paper styles',
    apply: () => ({ title: 'Handwritten note', content: '', note_type: 'handwriting' as const }),
    mode: 'drawing',
  },
];

function rid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function formatDate(iso: string) {
  try {
    const d = new Date(iso);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

function previewText(note: Note): string {
  const parts: string[] = [];
  if (note.content) parts.push(note.content);
  if (note.checklist.length) parts.push(note.checklist.map((c) => `• ${c.text}`).join('  '));
  return parts.join('  ').replace(/\n+/g, ' ').slice(0, 140);
}

// Build a flat ordered list of {folder, depth} from the flat array using parent_id
function buildFolderTree(flat: Folder[]): { folder: Folder; depth: number; hasChildren: boolean }[] {
  const byParent = new Map<string | null, Folder[]>();
  for (const f of flat) {
    const key = f.parent_id || null;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(f);
  }
  for (const arr of byParent.values()) arr.sort((a, b) => a.name.localeCompare(b.name));

  const result: { folder: Folder; depth: number; hasChildren: boolean }[] = [];
  const walk = (parent: string | null, depth: number) => {
    const children = byParent.get(parent) || [];
    for (const f of children) {
      const childList = byParent.get(f.id) || [];
      result.push({ folder: f, depth, hasChildren: childList.length > 0 });
      walk(f.id, depth + 1);
    }
  };
  walk(null, 0);
  return result;
}

export default function HomeScreen() {
  const router = useRouter();
  const { colors, isDark } = useTheme();
  const insets = useSafeAreaInsets();
  const { width: winW } = useWindowDimensions();

  // Responsive column count: phones=2, tablets scale up
  const numColumns = useMemo(() => {
    if (winW >= 1400) return 6;
    if (winW >= 1100) return 5;
    if (winW >= 850) return 4;
    if (winW >= 620) return 3;
    return 2;
  }, [winW]);
  const cardPxWidth = useMemo(() => {
    const horizPad = spacing.lg * 2;
    const totalGap = spacing.md * (numColumns - 1);
    return (winW - horizPad - totalGap) / numColumns;
  }, [winW, numColumns]);

  const [notes, setNotes] = useState<Note[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<CategoryKey>('all');
  const [viewMode, setViewMode] = useState<ViewMode>('grid');

  // Modals
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [showTemplate, setShowTemplate] = useState(false);
  const [showMovePicker, setShowMovePicker] = useState(false);
  const [folderModal, setFolderModal] = useState<{
    parentId: string | null;
    folder?: Folder; // edit existing
  } | null>(null);

  // Drawer expand state
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Multi-select
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const selectionMode = selectedIds.size > 0;

  const status: NoteStatus = category === 'trash' ? 'trash' : 'active';
  const folderFilter = useMemo(() => {
    if (category === 'all' || category === 'pinned' || category === 'trash') return null;
    return category;
  }, [category]);

  const load = useCallback(async () => {
    try {
      const [n, f] = await Promise.all([
        NotesApi.list({
          q: search.trim() || undefined,
          folderId: folderFilter,
          status,
          pinned: category === 'pinned' ? true : undefined,
        }),
        FoldersApi.list(),
      ]);
      setNotes(n);
      setFolders(f);
    } catch (e) {
      console.warn('load failed', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [search, folderFilter, status, category]);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [search, category, load]);

  const pinnedNotes = useMemo(
    () => (category === 'all' ? notes.filter((n) => n.pinned) : []),
    [notes, category]
  );
  const otherNotes = useMemo(
    () => (category === 'all' ? notes.filter((n) => !n.pinned) : notes),
    [notes, category]
  );

  const folderById = (id: string | null | undefined) =>
    id ? folders.find((f) => f.id === id) : undefined;

  // FAB
  const onFabPress = () => {
    haptic.light();
    setShowTemplate(true);
  };
  const createFromTemplate = async (tpl: Template) => {
    setShowTemplate(false);
    try {
      const seed = tpl.apply();
      const note = await NotesApi.create({ ...seed, folder_id: folderFilter });
      if (tpl.mode === 'drawing') {
        router.push(`/draw/${note.id}`);
      } else {
        router.push(`/note/${note.id}`);
      }
    } catch (e) {
      console.warn(e);
    }
  };

  // --- Selection ---
  const enterSelectionWith = (note: Note) => {
    haptic.medium();
    setSelectedIds(new Set([note.id]));
  };
  const toggleSelect = (note: Note) => {
    haptic.selection();
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(note.id)) next.delete(note.id);
      else next.add(note.id);
      return next;
    });
  };
  const clearSelection = () => setSelectedIds(new Set());
  const selectAllVisible = () => setSelectedIds(new Set(notes.map((n) => n.id)));
  const allSelected = selectionMode && notes.length > 0 && selectedIds.size === notes.length;

  const bulkUpdate = async (patch: Partial<Note>) => {
    const ids = Array.from(selectedIds);
    await Promise.all(ids.map((id) => NotesApi.update(id, patch)));
    clearSelection();
    load();
  };
  const bulkPin = async () => {
    const anyUnpinned = notes.some((n) => selectedIds.has(n.id) && !n.pinned);
    await bulkUpdate({ pinned: anyUnpinned });
  };
  const bulkDuplicate = async () => {
    const targets = notes.filter((n) => selectedIds.has(n.id));
    await Promise.all(
      targets.map((n) =>
        NotesApi.create({
          title: n.title ? `${n.title} (copy)` : '',
          content: n.content,
          checklist: n.checklist,
          images: n.images,
          drawings: n.drawings,
          folder_id: n.folder_id,
          pinned: false,
          locked: false,
        })
      )
    );
    clearSelection();
    load();
  };
  const bulkDelete = async () => {
    const ids = Array.from(selectedIds);
    const permanent = category === 'trash';
    await Promise.all(ids.map((id) => NotesApi.remove(id, permanent)));
    clearSelection();
    load();
  };
  const bulkRestore = async () => {
    const ids = Array.from(selectedIds);
    await Promise.all(ids.map((id) => NotesApi.restore(id)));
    clearSelection();
    load();
  };
  const bulkMoveTo = async (folderId: string | null) => {
    await bulkUpdate({ folder_id: folderId });
    setShowMovePicker(false);
  };

  const emptyTrash = async () => {
    await NotesApi.emptyTrash();
    load();
  };

  const categoryLabel = useMemo(() => {
    if (category === 'all') return 'All notes';
    if (category === 'pinned') return 'Pinned';
    if (category === 'trash') return 'Trash';
    return folderById(category)?.name || 'Notes';
  }, [category, folders]);

  // --- Folder tree drawer rendering ---
  const tree = useMemo(() => buildFolderTree(folders), [folders]);
  const visibleTree = useMemo(() => {
    // Hide rows whose any ancestor is collapsed
    const collapsedSet = new Set<string>();
    for (const f of folders) {
      if (!expanded.has(f.id)) collapsedSet.add(f.id);
    }
    const out: typeof tree = [];
    // Walk: a row is visible if all ancestors are expanded
    const folderMap = new Map(folders.map((f) => [f.id, f]));
    for (const row of tree) {
      let visible = true;
      let p = row.folder.parent_id;
      while (p) {
        if (collapsedSet.has(p)) { visible = false; break; }
        p = folderMap.get(p)?.parent_id || null;
      }
      if (visible) out.push(row);
    }
    return out;
  }, [tree, folders, expanded]);

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Folder modal save handler
  const saveFolderModal = async (name: string, color: string) => {
    if (!folderModal) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    if (folderModal.folder) {
      await FoldersApi.update(folderModal.folder.id, { name: trimmed, color });
    } else {
      await FoldersApi.create({ name: trimmed, color, parent_id: folderModal.parentId });
      if (folderModal.parentId) {
        setExpanded((prev) => new Set(prev).add(folderModal.parentId as string));
      }
    }
    setFolderModal(null);
    load();
  };

  const deleteFolderFromModal = async () => {
    if (!folderModal?.folder) return;
    await FoldersApi.remove(folderModal.folder.id);
    setFolderModal(null);
    load();
  };

  // --- Card renderer ---
  const renderNoteCard = (note: Note) => {
    const folder = folderById(note.folder_id);
    const cardWidth = viewMode === 'grid' ? cardPxWidth : undefined;
    const isSelected = selectedIds.has(note.id);
    return (
      <Pressable
        key={note.id}
        testID={`note-card-${note.id}`}
        onPress={() => {
          if (selectionMode) { toggleSelect(note); return; }
          if (category === 'trash') { enterSelectionWith(note); return; }
          if (note.locked) router.push(`/lock?noteId=${note.id}`);
          else if (note.note_type === 'handwriting') router.push(`/draw/${note.id}`);
          else router.push(`/note/${note.id}`);
        }}
        onLongPress={() => enterSelectionWith(note)}
        delayLongPress={300}
        style={({ pressed }) => [
          styles.card,
          {
            backgroundColor: isSelected ? colors.brandTertiary : colors.surfaceSecondary,
            width: cardWidth,
            alignSelf: viewMode === 'list' ? 'stretch' : 'flex-start',
            borderLeftColor: folder?.color || 'transparent',
            borderLeftWidth: folder ? 3 : 0,
            borderWidth: isSelected ? 2 : 0,
            borderColor: isSelected ? colors.brand : 'transparent',
            opacity: pressed ? 0.85 : 1,
          },
        ]}
      >
        {selectionMode && (
          <View style={[styles.selectMark, { backgroundColor: isSelected ? colors.brand : colors.surface, borderColor: colors.brand }]}>
            {isSelected && <Ionicons name="checkmark" size={14} color={colors.onBrandPrimary} />}
          </View>
        )}
        <View style={styles.cardHeader}>
          {note.pinned && <Ionicons name="pin" size={14} color={colors.brand} style={{ marginRight: 6 }} />}
          {note.locked && <Ionicons name="lock-closed" size={14} color={colors.muted} style={{ marginRight: 6 }} />}
          <Text style={[styles.cardDate, { color: colors.muted }]}>{formatDate(note.updated_at)}</Text>
        </View>
        <Text numberOfLines={1} style={[styles.cardTitle, { color: colors.onSurface }]}>
          {note.title || 'Untitled note'}
        </Text>
        {!note.locked && note.note_type !== 'handwriting' && (
          <Text
            numberOfLines={viewMode === 'grid' ? 5 : 2}
            style={[styles.cardPreview, { color: colors.onSurfaceSecondary }]}
          >
            {previewText(note) || 'No additional text'}
          </Text>
        )}
        {!note.locked && note.note_type === 'handwriting' && (
          <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: spacing.xs }}>
            <Ionicons name="brush" size={14} color={colors.brand} />
            <Text style={[styles.cardPreview, { color: colors.brand, marginLeft: 4, fontWeight: '600' }]}>
              Handwritten note
            </Text>
          </View>
        )}
        {note.locked && (
          <Text style={[styles.cardPreview, { color: colors.muted, fontStyle: 'italic' }]}>
            Tap to unlock
          </Text>
        )}
        {!!note.images.length && (
          <View style={styles.cardMeta}>
            <Ionicons name="image-outline" size={12} color={colors.muted} />
            <Text style={[styles.cardMetaText, { color: colors.muted }]}>{note.images.length}</Text>
          </View>
        )}
      </Pressable>
    );
  };

  const isEmpty = !loading && notes.length === 0;

  return (
    <View style={[styles.container, { backgroundColor: colors.surface }]}>
      {/* Sticky header */}
      <BlurView
        intensity={isDark ? 40 : 60}
        tint={isDark ? 'dark' : 'light'}
        style={[styles.header, { paddingTop: insets.top + spacing.sm }]}
      >
        {!selectionMode ? (
          <View style={styles.headerTopRow}>
            <Pressable
              testID="open-drawer-btn"
              onPress={() => { haptic.selection(); setDrawerOpen(true); }}
              style={[styles.iconBtn, { backgroundColor: colors.surfaceSecondary }]}
            >
              <Ionicons name="menu" size={22} color={colors.onSurface} />
            </Pressable>
            <Text style={[styles.bigTitle, { color: colors.onSurface }]} testID="home-title">
              {categoryLabel}
            </Text>
            <Pressable
              testID="toggle-view-btn"
              onPress={() => { haptic.selection(); setViewMode((v) => (v === 'grid' ? 'list' : 'grid')); }}
              style={[styles.iconBtn, { backgroundColor: colors.surfaceSecondary }]}
            >
              <Ionicons
                name={viewMode === 'grid' ? 'list-outline' : 'grid-outline'}
                size={20}
                color={colors.onSurface}
              />
            </Pressable>
          </View>
        ) : (
          <View style={styles.headerTopRow}>
            <Pressable
              testID="selection-close-btn"
              onPress={clearSelection}
              style={[styles.iconBtn, { backgroundColor: colors.surfaceSecondary }]}
            >
              <Ionicons name="close" size={22} color={colors.onSurface} />
            </Pressable>
            <Text style={[styles.bigTitle, { color: colors.onSurface }]} testID="selection-count">
              {selectedIds.size} selected
            </Text>
            <Pressable
              testID="select-all-btn"
              onPress={() => (allSelected ? clearSelection() : selectAllVisible())}
              style={[styles.iconBtn, { backgroundColor: colors.surfaceSecondary }]}
            >
              <Ionicons
                name={allSelected ? 'checkbox' : 'checkbox-outline'}
                size={20}
                color={allSelected ? colors.brand : colors.onSurface}
              />
            </Pressable>
          </View>
        )}

        {!selectionMode && (
          <View style={[styles.searchBar, { backgroundColor: colors.surfaceSecondary }]}>
            <Ionicons name="search" size={18} color={colors.muted} />
            <TextInput
              testID="search-input"
              placeholder={category === 'trash' ? 'Search in trash' : 'Search notes'}
              placeholderTextColor={colors.muted}
              value={search}
              onChangeText={setSearch}
              style={[styles.searchInput, { color: colors.onSurface }]}
              returnKeyType="search"
            />
            {!!search && (
              <Pressable onPress={() => setSearch('')} testID="search-clear">
                <Ionicons name="close-circle" size={18} color={colors.muted} />
              </Pressable>
            )}
          </View>
        )}

        {!selectionMode && category === 'trash' && notes.length > 0 && (
          <Pressable
            testID="empty-trash-btn"
            onPress={emptyTrash}
            style={[styles.trashBanner, { backgroundColor: colors.surfaceSecondary }]}
          >
            <Ionicons name="trash-bin-outline" size={16} color={colors.error} />
            <Text style={{ marginLeft: spacing.sm, color: colors.error, fontWeight: '600' }}>
              Empty trash ({notes.length})
            </Text>
          </Pressable>
        )}
      </BlurView>

      {/* List */}
      <FlatList
        testID="notes-list"
        data={[]}
        keyExtractor={() => 'static'}
        renderItem={null as any}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { setRefreshing(true); load(); }}
            tintColor={colors.brand}
          />
        }
        contentContainerStyle={{
          paddingTop: selectionMode ? 120 : (category === 'trash' && notes.length > 0 ? 230 : 180),
          paddingBottom: insets.bottom + (selectionMode ? 160 : 140),
          paddingHorizontal: spacing.lg,
        }}
        ListHeaderComponent={
          <View>
            {loading && (
              <View style={{ paddingVertical: spacing.xxl, alignItems: 'center' }}>
                <ActivityIndicator color={colors.brand} />
              </View>
            )}
            {isEmpty && !selectionMode && (
              <View style={[styles.empty, { backgroundColor: colors.surfaceSecondary }]}>
                <Ionicons
                  name={category === 'trash' ? 'trash-outline' : 'document-text-outline'}
                  size={56}
                  color={colors.brand}
                />
                <Text style={[styles.emptyTitle, { color: colors.onSurface }]}>
                  {category === 'trash' ? 'Trash is empty' : 'No notes here'}
                </Text>
                <Text style={[styles.emptySub, { color: colors.muted }]}>
                  {category === 'trash'
                    ? 'Deleted notes will show up here'
                    : 'Tap + to create a new note'}
                </Text>
                {category !== 'trash' && (
                  <Pressable
                    testID="empty-create-btn"
                    onPress={onFabPress}
                    style={[styles.emptyBtn, { backgroundColor: colors.brand }]}
                  >
                    <Text style={{ color: colors.onBrandPrimary, fontWeight: '600' }}>Create Note</Text>
                  </Pressable>
                )}
              </View>
            )}
            {!!pinnedNotes.length && (
              <>
                <SectionLabel label="Pinned" color={colors.muted} />
                <View style={styles.grid}>{pinnedNotes.map(renderNoteCard)}</View>
              </>
            )}
            {!!otherNotes.length && (
              <>
                {!!pinnedNotes.length && <SectionLabel label="Others" color={colors.muted} />}
                <View style={styles.grid}>{otherNotes.map(renderNoteCard)}</View>
              </>
            )}
          </View>
        }
      />

      {/* FAB (hidden in selection / trash) */}
      {!selectionMode && category !== 'trash' && (
        <Pressable
          testID="fab-create-note"
          onPress={onFabPress}
          style={({ pressed }) => [
            styles.fab,
            {
              backgroundColor: colors.brand,
              bottom: insets.bottom + 70,
              transform: [{ scale: pressed ? 0.95 : 1 }],
            },
          ]}
        >
          <Ionicons name="add" size={28} color={colors.onBrandPrimary} />
        </Pressable>
      )}

      {/* Bulk action bar */}
      {selectionMode && (
        <View
          testID="bulk-action-bar"
          style={[
            styles.bulkBar,
            {
              backgroundColor: colors.surface,
              borderTopColor: colors.divider,
              paddingBottom: insets.bottom + spacing.sm,
            },
          ]}
        >
          {category !== 'trash' ? (
            <>
              <BulkBtn icon="pin-outline" label="Pin" onPress={bulkPin} testID="bulk-pin" />
              <BulkBtn icon="folder-outline" label="Move" onPress={() => setShowMovePicker(true)} testID="bulk-move" />
              <BulkBtn icon="copy-outline" label="Duplicate" onPress={bulkDuplicate} testID="bulk-duplicate" />
              <BulkBtn
                icon="trash-outline"
                label="Trash"
                onPress={bulkDelete}
                destructive
                testID="bulk-delete"
              />
            </>
          ) : (
            <>
              <BulkBtn icon="refresh" label="Restore" onPress={bulkRestore} testID="bulk-restore" />
              <BulkBtn
                icon="trash-bin-outline"
                label="Delete forever"
                onPress={bulkDelete}
                destructive
                testID="bulk-delete-forever"
              />
            </>
          )}
        </View>
      )}

      {/* Left drawer */}
      <Modal visible={drawerOpen} transparent animationType="fade" onRequestClose={() => setDrawerOpen(false)}>
        <Pressable style={styles.drawerBackdrop} onPress={() => setDrawerOpen(false)}>
          <Pressable
            style={[styles.drawerPanel, { backgroundColor: colors.surface, paddingTop: insets.top + spacing.lg }]}
            onPress={(e) => e.stopPropagation()}
          >
            <Text style={[styles.drawerBrand, { color: colors.brand }]}>GalaxyNotes</Text>
            <Text style={[styles.drawerSub, { color: colors.muted }]}>Your second brain</Text>

            <View style={{ height: spacing.lg }} />

            <DrawerRow
              icon="document-text-outline"
              label="All notes"
              active={category === 'all'}
              onPress={() => { setCategory('all'); setDrawerOpen(false); }}
              testID="drawer-all"
            />
            <DrawerRow
              icon="pin-outline"
              label="Pinned"
              active={category === 'pinned'}
              onPress={() => { setCategory('pinned'); setDrawerOpen(false); }}
              testID="drawer-pinned"
            />
            <DrawerRow
              icon="trash-outline"
              label="Trash"
              active={category === 'trash'}
              onPress={() => { setCategory('trash'); setDrawerOpen(false); }}
              testID="drawer-trash"
            />

            <View style={styles.drawerSectionRow}>
              <Text style={[styles.drawerSection, { color: colors.muted }]}>FOLDERS</Text>
              <Pressable
                testID="drawer-new-folder"
                onPress={() => setFolderModal({ parentId: null })}
                style={[styles.smallAddBtn, { backgroundColor: colors.brandTertiary }]}
              >
                <Ionicons name="add" size={16} color={colors.brand} />
                <Text style={{ color: colors.brand, fontWeight: '700', marginLeft: 4, fontSize: typeScale.sm }}>
                  New
                </Text>
              </Pressable>
            </View>

            <ScrollView style={{ maxHeight: 360 }}>
              {folders.length === 0 && (
                <Text style={{ color: colors.muted, paddingHorizontal: spacing.md, paddingVertical: spacing.sm }}>
                  No folders yet. Tap "New" to create one.
                </Text>
              )}
              {visibleTree.map(({ folder: f, depth, hasChildren }) => {
                const isOpen = expanded.has(f.id);
                const isActive = category === f.id;
                return (
                  <View key={f.id} style={{ flexDirection: 'row', alignItems: 'center', paddingLeft: depth * 18 }}>
                    <Pressable
                      onPress={() => toggleExpand(f.id)}
                      style={styles.expandBtn}
                      testID={`drawer-expand-${f.id}`}
                    >
                      <Ionicons
                        name={hasChildren ? (isOpen ? 'chevron-down' : 'chevron-forward') : 'remove'}
                        size={14}
                        color={hasChildren ? colors.onSurface : 'transparent'}
                      />
                    </Pressable>
                    <Pressable
                      testID={`drawer-folder-${f.id}`}
                      onPress={() => { setCategory(f.id); setDrawerOpen(false); }}
                      onLongPress={() => setFolderModal({ parentId: f.parent_id, folder: f })}
                      delayLongPress={350}
                      style={({ pressed }) => [
                        styles.drawerRow,
                        {
                          flex: 1,
                          backgroundColor: isActive
                            ? colors.brandTertiary
                            : pressed
                            ? colors.surfaceSecondary
                            : 'transparent',
                        },
                      ]}
                    >
                      <View style={[styles.folderDot, { backgroundColor: f.color, marginRight: spacing.md }]} />
                      <Text
                        numberOfLines={1}
                        style={{
                          flex: 1,
                          fontSize: typeScale.lg,
                          fontWeight: isActive ? '700' : '500',
                          color: isActive ? colors.brand : colors.onSurface,
                        }}
                      >
                        {f.name}
                      </Text>
                    </Pressable>
                    <Pressable
                      testID={`drawer-subfolder-${f.id}`}
                      onPress={() => setFolderModal({ parentId: f.id })}
                      style={styles.iconBtnSmall}
                    >
                      <Ionicons name="add" size={18} color={colors.muted} />
                    </Pressable>
                  </View>
                );
              })}
            </ScrollView>

            <Text style={{ color: colors.muted, fontSize: typeScale.sm, marginTop: spacing.sm, paddingHorizontal: spacing.md }}>
              Tip: long-press a folder to edit or delete.
            </Text>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Template picker */}
      <Modal visible={showTemplate} transparent animationType="slide" onRequestClose={() => setShowTemplate(false)}>
        <Pressable style={styles.backdrop} onPress={() => setShowTemplate(false)}>
          <Pressable style={[styles.sheet, { backgroundColor: colors.surface, paddingBottom: insets.bottom + spacing.lg }]}>
            <View style={styles.sheetHandle} />
            <Text style={[styles.sheetTitle, { color: colors.onSurface }]} testID="template-sheet-title">
              Choose a template
            </Text>
            {TEMPLATES.map((tpl) => (
              <Pressable
                key={tpl.key}
                testID={`tpl-${tpl.key}`}
                onPress={() => createFromTemplate(tpl)}
                style={({ pressed }) => [
                  styles.tplRow,
                  { backgroundColor: pressed ? colors.surfaceTertiary : colors.surfaceSecondary },
                ]}
              >
                <View style={[styles.tplIcon, { backgroundColor: colors.brandTertiary }]}>
                  <Ionicons name={tpl.icon} size={22} color={colors.brand} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: colors.onSurface, fontWeight: '700', fontSize: typeScale.lg }}>
                    {tpl.label}
                  </Text>
                  <Text style={{ color: colors.muted, fontSize: typeScale.sm, marginTop: 2 }}>
                    {tpl.description}
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={20} color={colors.muted} />
              </Pressable>
            ))}
          </Pressable>
        </Pressable>
      </Modal>

      {/* Bulk Move-to-folder picker */}
      <Modal visible={showMovePicker} transparent animationType="slide" onRequestClose={() => setShowMovePicker(false)}>
        <Pressable style={styles.backdrop} onPress={() => setShowMovePicker(false)}>
          <Pressable style={[styles.sheet, { backgroundColor: colors.surface, paddingBottom: insets.bottom + spacing.lg, maxHeight: '70%' }]}>
            <View style={styles.sheetHandle} />
            <Text style={[styles.sheetTitle, { color: colors.onSurface }]}>
              Move {selectedIds.size} note{selectedIds.size > 1 ? 's' : ''} to…
            </Text>
            <ScrollView>
              <Pressable
                onPress={() => bulkMoveTo(null)}
                style={[styles.folderRow, { borderBottomColor: colors.divider }]}
                testID="move-folder-none"
              >
                <View style={[styles.folderDot, { backgroundColor: colors.muted }]} />
                <Text style={{ color: colors.onSurface, fontSize: typeScale.lg }}>No folder</Text>
              </Pressable>
              {tree.map(({ folder: f, depth }) => (
                <Pressable
                  key={f.id}
                  onPress={() => bulkMoveTo(f.id)}
                  style={[styles.folderRow, { borderBottomColor: colors.divider, paddingLeft: spacing.md + depth * 16 }]}
                  testID={`move-folder-${f.id}`}
                >
                  <View style={[styles.folderDot, { backgroundColor: f.color }]} />
                  <Text style={{ color: colors.onSurface, fontSize: typeScale.lg }}>{f.name}</Text>
                </Pressable>
              ))}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Folder create / edit modal */}
      <FolderModal
        visible={!!folderModal}
        folder={folderModal?.folder}
        parentName={folderModal?.parentId ? folderById(folderModal.parentId)?.name : undefined}
        onCancel={() => setFolderModal(null)}
        onSave={saveFolderModal}
        onDelete={folderModal?.folder ? deleteFolderFromModal : undefined}
      />
    </View>
  );
}

function FolderModal({
  visible,
  folder,
  parentName,
  onCancel,
  onSave,
  onDelete,
}: {
  visible: boolean;
  folder?: Folder;
  parentName?: string;
  onCancel: () => void;
  onSave: (name: string, color: string) => void;
  onDelete?: () => void;
}) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [name, setName] = useState('');
  const [color, setColor] = useState(folderColors[0]);

  useEffect(() => {
    if (visible) {
      setName(folder?.name || '');
      setColor(folder?.color || folderColors[0]);
    }
  }, [visible, folder]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}>
      <Pressable style={styles.backdrop} onPress={onCancel}>
        <Pressable style={[styles.sheet, { backgroundColor: colors.surface, paddingBottom: insets.bottom + spacing.lg }]}>
          <View style={styles.sheetHandle} />
          <Text style={{ fontSize: typeScale.xl, fontWeight: '700', color: colors.onSurface, marginBottom: spacing.xs }}>
            {folder ? 'Edit folder' : 'New folder'}
          </Text>
          {!!parentName && !folder && (
            <Text style={{ color: colors.muted, marginBottom: spacing.md }}>
              Inside <Text style={{ color: colors.brand, fontWeight: '700' }}>{parentName}</Text>
            </Text>
          )}
          <TextInput
            testID="folder-name-input"
            value={name}
            onChangeText={setName}
            placeholder="Folder name"
            placeholderTextColor={colors.muted}
            style={[styles.input, { color: colors.onSurface, backgroundColor: colors.surfaceSecondary }]}
            autoFocus
          />
          <Text style={{ color: colors.muted, marginTop: spacing.lg, marginBottom: spacing.sm }}>Color</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
            {folderColors.map((c) => (
              <Pressable
                key={c}
                testID={`folder-color-${c}`}
                onPress={() => setColor(c)}
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 18,
                  backgroundColor: c,
                  borderWidth: 3,
                  borderColor: color === c ? colors.onSurface : 'transparent',
                }}
              />
            ))}
          </View>
          <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xl }}>
            {folder && onDelete && (
              <Pressable
                testID="folder-delete"
                onPress={onDelete}
                style={[styles.btn, { borderColor: colors.error, borderWidth: 1 }]}
              >
                <Text style={{ color: colors.error, fontWeight: '700' }}>Delete</Text>
              </Pressable>
            )}
            <Pressable
              testID="folder-save"
              onPress={() => onSave(name, color)}
              style={[styles.btn, { flex: 1, backgroundColor: colors.brand }]}
            >
              <Text style={{ color: colors.onBrandPrimary, fontWeight: '700' }}>
                {folder ? 'Save' : 'Create'}
              </Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function DrawerRow({
  icon,
  label,
  onPress,
  active,
  testID,
}: {
  icon: any;
  label: string;
  onPress: () => void;
  active?: boolean;
  testID?: string;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      style={({ pressed }) => [
        styles.drawerRow,
        {
          backgroundColor: active
            ? colors.brandTertiary
            : pressed
            ? colors.surfaceSecondary
            : 'transparent',
        },
      ]}
    >
      <Ionicons name={icon} size={20} color={active ? colors.brand : colors.onSurface} />
      <Text
        style={{
          marginLeft: spacing.md,
          fontSize: typeScale.lg,
          fontWeight: active ? '700' : '500',
          color: active ? colors.brand : colors.onSurface,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function BulkBtn({
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
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: spacing.sm,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Ionicons name={icon} size={22} color={c} />
      <Text style={{ marginTop: 2, fontSize: typeScale.sm, color: c, fontWeight: '600' }}>{label}</Text>
    </Pressable>
  );
}

function SectionLabel({ label, color }: { label: string; color: string }) {
  return (
    <Text
      style={{
        fontSize: typeScale.sm,
        color,
        textTransform: 'uppercase',
        letterSpacing: 1.2,
        marginTop: spacing.lg,
        marginBottom: spacing.sm,
        marginLeft: spacing.xs,
        fontWeight: '600',
      }}
    >
      {label}
    </Text>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    position: 'absolute',
    top: 0, left: 0, right: 0,
    zIndex: 10,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
  },
  headerTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.md,
    gap: spacing.sm,
  },
  bigTitle: { fontSize: typeScale.xxl, fontWeight: '700', flex: 1 },
  iconBtn: {
    width: 40,
    height: 40,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconBtnSmall: { padding: spacing.xs },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    height: 44,
    borderRadius: radius.md,
    gap: spacing.sm,
  },
  searchInput: { flex: 1, fontSize: typeScale.lg, paddingVertical: 0 },
  trashBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    marginTop: spacing.sm,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-start',
    gap: spacing.md,
  },
  card: { padding: spacing.lg, borderRadius: radius.lg, marginBottom: spacing.md, minHeight: 120 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.xs },
  cardDate: { fontSize: typeScale.sm },
  cardTitle: { fontSize: typeScale.lg, fontWeight: '700', marginBottom: spacing.xs },
  cardPreview: { fontSize: typeScale.base, lineHeight: 18 },
  cardMeta: { flexDirection: 'row', alignItems: 'center', marginTop: spacing.sm, gap: 4 },
  cardMetaText: { fontSize: typeScale.sm },
  selectMark: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 2,
  },
  empty: { padding: spacing.xxl, borderRadius: radius.lg, alignItems: 'center', marginTop: spacing.xl },
  emptyTitle: { fontSize: typeScale.xl, fontWeight: '700', marginTop: spacing.lg },
  emptySub: { fontSize: typeScale.base, marginTop: spacing.xs, textAlign: 'center' },
  emptyBtn: {
    marginTop: spacing.lg,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: radius.pill,
  },
  fab: {
    position: 'absolute',
    right: spacing.lg,
    width: 60,
    height: 60,
    borderRadius: 30,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 6,
  },
  bulkBar: {
    position: 'absolute',
    left: 0, right: 0, bottom: 56,
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: spacing.xs,
  },
  drawerBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', flexDirection: 'row' },
  drawerPanel: {
    width: '82%',
    maxWidth: 340,
    height: '100%',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
    borderTopRightRadius: radius.lg,
    borderBottomRightRadius: radius.lg,
  },
  drawerBrand: { fontSize: typeScale.xxl, fontWeight: '800' },
  drawerSub: { fontSize: typeScale.sm, marginTop: 4 },
  drawerSectionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: spacing.xl,
    marginBottom: spacing.sm,
    paddingLeft: spacing.sm,
  },
  drawerSection: {
    flex: 1,
    fontSize: typeScale.sm,
    letterSpacing: 1.2,
    fontWeight: '600',
  },
  smallAddBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.pill,
  },
  drawerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    marginVertical: 1,
  },
  expandBtn: { width: 22, alignItems: 'center', justifyContent: 'center' },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
  sheet: {
    position: 'absolute',
    left: 0, right: 0, bottom: 0,
    padding: spacing.lg,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
  },
  sheetHandle: {
    width: 44,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#0002',
    alignSelf: 'center',
    marginBottom: spacing.md,
  },
  sheetTitle: { fontSize: typeScale.lg, fontWeight: '700', marginBottom: spacing.md },
  folderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  folderDot: { width: 14, height: 14, borderRadius: 7, marginRight: spacing.md },
  tplRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.md,
    borderRadius: radius.md,
    marginBottom: spacing.sm,
    gap: spacing.md,
  },
  tplIcon: {
    width: 44, height: 44, borderRadius: 22,
    alignItems: 'center', justifyContent: 'center',
  },
  input: {
    height: 48,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    fontSize: typeScale.lg,
  },
  btn: {
    paddingHorizontal: spacing.xl,
    height: 48,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
