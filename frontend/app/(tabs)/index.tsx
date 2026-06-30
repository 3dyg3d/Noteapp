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
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { BlurView } from 'expo-blur';

import { useTheme } from '@/src/theme/ThemeContext';
import { spacing, radius, typeScale } from '@/src/theme/tokens';
import { NotesApi, FoldersApi, Note, Folder, ChecklistItem, NoteStatus } from '@/src/api/client';

type ViewMode = 'grid' | 'list';
// Drawer category: filter for the home list
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
    label: 'Drawing / S Pen',
    icon: 'brush-outline',
    description: 'Open a blank canvas with stylus support',
    apply: () => ({ title: 'Drawing', content: '' }),
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
    if (sameDay) {
      return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

function previewText(note: Note): string {
  const parts: string[] = [];
  if (note.content) parts.push(note.content);
  if (note.checklist.length) {
    parts.push(note.checklist.map((c) => `• ${c.text}`).join('  '));
  }
  return parts.join('  ').replace(/\n+/g, ' ').slice(0, 140);
}

export default function HomeScreen() {
  const router = useRouter();
  const { colors, isDark } = useTheme();
  const insets = useSafeAreaInsets();

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
  const [actionNote, setActionNote] = useState<Note | null>(null);
  const [showMovePicker, setShowMovePicker] = useState(false);

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

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [search, category, load]);

  const pinned = useMemo(
    () => (category === 'all' ? notes.filter((n) => n.pinned) : []),
    [notes, category]
  );
  const others = useMemo(
    () => (category === 'all' ? notes.filter((n) => !n.pinned) : notes),
    [notes, category]
  );

  const folderById = (id: string | null | undefined) =>
    id ? folders.find((f) => f.id === id) : undefined;

  // --- FAB / template picker ---
  const onFabPress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    setShowTemplate(true);
  };

  const createFromTemplate = async (tpl: Template) => {
    setShowTemplate(false);
    try {
      const seed = tpl.apply();
      const note = await NotesApi.create({
        ...seed,
        folder_id: folderFilter,
      });
      router.push(`/note/${note.id}${tpl.mode === 'drawing' ? '?mode=drawing' : ''}`);
    } catch (e) {
      console.warn(e);
    }
  };

  // --- Long-press actions ---
  const openActions = (note: Note) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    setActionNote(note);
  };
  const closeActions = () => {
    setActionNote(null);
    setShowMovePicker(false);
  };
  const togglePinAction = async () => {
    if (!actionNote) return;
    await NotesApi.update(actionNote.id, { pinned: !actionNote.pinned });
    closeActions();
    load();
  };
  const toggleLockAction = async () => {
    if (!actionNote) return;
    await NotesApi.update(actionNote.id, { locked: !actionNote.locked });
    closeActions();
    load();
  };
  const duplicateAction = async () => {
    if (!actionNote) return;
    await NotesApi.create({
      title: actionNote.title ? `${actionNote.title} (copy)` : '',
      content: actionNote.content,
      checklist: actionNote.checklist,
      images: actionNote.images,
      drawings: actionNote.drawings,
      folder_id: actionNote.folder_id,
      pinned: false,
      locked: false,
    });
    closeActions();
    load();
  };
  const deleteAction = async () => {
    if (!actionNote) return;
    await NotesApi.remove(actionNote.id, category === 'trash');
    closeActions();
    load();
  };
  const restoreAction = async () => {
    if (!actionNote) return;
    await NotesApi.restore(actionNote.id);
    closeActions();
    load();
  };
  const moveToFolder = async (folderId: string | null) => {
    if (!actionNote) return;
    await NotesApi.update(actionNote.id, { folder_id: folderId });
    closeActions();
    load();
  };

  const emptyTrash = async () => {
    await NotesApi.emptyTrash();
    load();
  };

  const categoryLabel = useMemo(() => {
    if (category === 'all') return 'All notes';
    if (category === 'pinned') return 'Pinned';
    if (category === 'trash') return 'Trash';
    const f = folderById(category);
    return f?.name || 'Notes';
  }, [category, folders]);

  const renderNoteCard = (note: Note) => {
    const folder = folderById(note.folder_id);
    const cardWidth = viewMode === 'grid' ? '48%' : '100%';
    return (
      <Pressable
        key={note.id}
        testID={`note-card-${note.id}`}
        onPress={() => {
          if (category === 'trash') {
            openActions(note);
            return;
          }
          if (note.locked) router.push(`/lock?noteId=${note.id}`);
          else router.push(`/note/${note.id}`);
        }}
        onLongPress={() => openActions(note)}
        delayLongPress={300}
        style={({ pressed }) => [
          styles.card,
          {
            backgroundColor: colors.surfaceSecondary,
            width: cardWidth as any,
            borderLeftColor: folder?.color || 'transparent',
            borderLeftWidth: folder ? 3 : 0,
            opacity: pressed ? 0.85 : 1,
          },
        ]}
      >
        <View style={styles.cardHeader}>
          {note.pinned && (
            <Ionicons name="pin" size={14} color={colors.brand} style={{ marginRight: 6 }} />
          )}
          {note.locked && (
            <Ionicons name="lock-closed" size={14} color={colors.muted} style={{ marginRight: 6 }} />
          )}
          <Text style={[styles.cardDate, { color: colors.muted }]}>{formatDate(note.updated_at)}</Text>
        </View>
        <Text numberOfLines={1} style={[styles.cardTitle, { color: colors.onSurface }]}>
          {note.title || 'Untitled note'}
        </Text>
        {!note.locked && (
          <Text
            numberOfLines={viewMode === 'grid' ? 5 : 2}
            style={[styles.cardPreview, { color: colors.onSurfaceSecondary }]}
          >
            {previewText(note) || 'No additional text'}
          </Text>
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
        <View style={styles.headerTopRow}>
          <Pressable
            testID="open-drawer-btn"
            onPress={() => {
              Haptics.selectionAsync().catch(() => {});
              setDrawerOpen(true);
            }}
            style={[styles.iconBtn, { backgroundColor: colors.surfaceSecondary }]}
          >
            <Ionicons name="menu" size={22} color={colors.onSurface} />
          </Pressable>
          <Text style={[styles.bigTitle, { color: colors.onSurface }]} testID="home-title">
            {categoryLabel}
          </Text>
          <Pressable
            testID="toggle-view-btn"
            onPress={() => {
              Haptics.selectionAsync().catch(() => {});
              setViewMode((v) => (v === 'grid' ? 'list' : 'grid'));
            }}
            style={[styles.iconBtn, { backgroundColor: colors.surfaceSecondary }]}
          >
            <Ionicons
              name={viewMode === 'grid' ? 'list-outline' : 'grid-outline'}
              size={20}
              color={colors.onSurface}
            />
          </Pressable>
        </View>

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

        {category === 'trash' && notes.length > 0 && (
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

      {/* Notes grid */}
      <FlatList
        testID="notes-list"
        data={[]}
        keyExtractor={() => 'static'}
        renderItem={null as any}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              load();
            }}
            tintColor={colors.brand}
          />
        }
        contentContainerStyle={{
          paddingTop: category === 'trash' && notes.length > 0 ? 230 : 180,
          paddingBottom: insets.bottom + 140,
          paddingHorizontal: spacing.lg,
        }}
        ListHeaderComponent={
          <View>
            {loading && (
              <View style={{ paddingVertical: spacing.xxl, alignItems: 'center' }}>
                <ActivityIndicator color={colors.brand} />
              </View>
            )}
            {isEmpty && (
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
                    <Text style={{ color: colors.onBrandPrimary, fontWeight: '600' }}>
                      Create Note
                    </Text>
                  </Pressable>
                )}
              </View>
            )}

            {!!pinned.length && (
              <>
                <SectionLabel label="Pinned" color={colors.muted} />
                <View style={styles.grid}>{pinned.map(renderNoteCard)}</View>
              </>
            )}
            {!!others.length && (
              <>
                {!!pinned.length && <SectionLabel label="Others" color={colors.muted} />}
                <View style={styles.grid}>{others.map(renderNoteCard)}</View>
              </>
            )}
          </View>
        }
      />

      {/* FAB (hidden in trash) */}
      {category !== 'trash' && (
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

      {/* Left drawer */}
      <Modal visible={drawerOpen} transparent animationType="fade" onRequestClose={() => setDrawerOpen(false)}>
        <Pressable style={styles.drawerBackdrop} onPress={() => setDrawerOpen(false)}>
          <Pressable
            style={[
              styles.drawerPanel,
              { backgroundColor: colors.surface, paddingTop: insets.top + spacing.lg },
            ]}
            onPress={(e) => e.stopPropagation()}
          >
            <Text style={[styles.drawerBrand, { color: colors.brand }]}>GalaxyNotes</Text>
            <Text style={[styles.drawerSub, { color: colors.muted }]}>Your second brain</Text>

            <View style={{ height: spacing.lg }} />

            <DrawerRow
              icon="document-text-outline"
              label="All notes"
              active={category === 'all'}
              onPress={() => {
                setCategory('all');
                setDrawerOpen(false);
              }}
              testID="drawer-all"
            />
            <DrawerRow
              icon="pin-outline"
              label="Pinned"
              active={category === 'pinned'}
              onPress={() => {
                setCategory('pinned');
                setDrawerOpen(false);
              }}
              testID="drawer-pinned"
            />
            <DrawerRow
              icon="trash-outline"
              label="Trash"
              active={category === 'trash'}
              onPress={() => {
                setCategory('trash');
                setDrawerOpen(false);
              }}
              testID="drawer-trash"
            />

            <Text style={[styles.drawerSection, { color: colors.muted }]}>FOLDERS</Text>

            <ScrollView style={{ maxHeight: 280 }}>
              {folders.length === 0 && (
                <Text style={{ color: colors.muted, paddingHorizontal: spacing.md, paddingVertical: spacing.sm }}>
                  No folders yet
                </Text>
              )}
              {folders.map((f) => (
                <DrawerRow
                  key={f.id}
                  iconColor={f.color}
                  icon="folder-outline"
                  label={f.name}
                  active={category === f.id}
                  onPress={() => {
                    setCategory(f.id);
                    setDrawerOpen(false);
                  }}
                  testID={`drawer-folder-${f.id}`}
                />
              ))}
            </ScrollView>

            <View style={{ flex: 1 }} />

            <View style={[styles.drawerDivider, { backgroundColor: colors.divider }]} />
            <DrawerRow
              icon="folder-open-outline"
              label="Manage folders"
              onPress={() => {
                setDrawerOpen(false);
                router.push('/folders');
              }}
              testID="drawer-manage-folders"
            />
            <DrawerRow
              icon="settings-outline"
              label="Settings"
              onPress={() => {
                setDrawerOpen(false);
                router.push('/settings');
              }}
              testID="drawer-settings"
            />
            <View style={{ height: insets.bottom + spacing.lg }} />
          </Pressable>
        </Pressable>
      </Modal>

      {/* Template picker */}
      <Modal visible={showTemplate} transparent animationType="slide" onRequestClose={() => setShowTemplate(false)}>
        <Pressable style={styles.backdrop} onPress={() => setShowTemplate(false)}>
          <Pressable
            style={[styles.sheet, { backgroundColor: colors.surface, paddingBottom: insets.bottom + spacing.lg }]}
          >
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

      {/* Long-press action sheet */}
      <Modal
        visible={!!actionNote && !showMovePicker}
        transparent
        animationType="slide"
        onRequestClose={closeActions}
      >
        <Pressable style={styles.backdrop} onPress={closeActions}>
          <Pressable
            style={[styles.sheet, { backgroundColor: colors.surface, paddingBottom: insets.bottom + spacing.lg }]}
          >
            <View style={styles.sheetHandle} />
            <Text style={[styles.sheetTitle, { color: colors.onSurface }]} numberOfLines={1} testID="action-sheet-title">
              {actionNote?.title || 'Untitled note'}
            </Text>
            {category !== 'trash' && (
              <>
                <ActionRow
                  icon={actionNote?.pinned ? 'pin' : 'pin-outline'}
                  label={actionNote?.pinned ? 'Unpin' : 'Pin'}
                  onPress={togglePinAction}
                  testID="action-pin"
                />
                <ActionRow
                  icon={actionNote?.locked ? 'lock-open-outline' : 'lock-closed-outline'}
                  label={actionNote?.locked ? 'Unlock' : 'Lock'}
                  onPress={toggleLockAction}
                  testID="action-lock"
                />
                <ActionRow
                  icon="folder-outline"
                  label="Move to folder"
                  onPress={() => setShowMovePicker(true)}
                  testID="action-move"
                />
                <ActionRow icon="copy-outline" label="Duplicate" onPress={duplicateAction} testID="action-duplicate" />
                <ActionRow icon="trash-outline" label="Move to trash" destructive onPress={deleteAction} testID="action-delete" />
              </>
            )}
            {category === 'trash' && (
              <>
                <ActionRow icon="refresh" label="Restore" onPress={restoreAction} testID="action-restore" />
                <ActionRow
                  icon="trash-bin-outline"
                  label="Delete forever"
                  destructive
                  onPress={deleteAction}
                  testID="action-delete-forever"
                />
              </>
            )}
          </Pressable>
        </Pressable>
      </Modal>

      {/* Move-to-folder picker */}
      <Modal visible={!!actionNote && showMovePicker} transparent animationType="slide" onRequestClose={closeActions}>
        <Pressable style={styles.backdrop} onPress={closeActions}>
          <Pressable
            style={[styles.sheet, { backgroundColor: colors.surface, paddingBottom: insets.bottom + spacing.lg }]}
          >
            <View style={styles.sheetHandle} />
            <Text style={[styles.sheetTitle, { color: colors.onSurface }]}>Move to folder</Text>
            <Pressable
              onPress={() => moveToFolder(null)}
              style={[styles.folderRow, { borderBottomColor: colors.divider }]}
              testID="move-folder-none"
            >
              <View style={[styles.folderDot, { backgroundColor: colors.muted }]} />
              <Text style={{ color: colors.onSurface, fontSize: typeScale.lg }}>No folder</Text>
            </Pressable>
            {folders.map((f) => (
              <Pressable
                key={f.id}
                onPress={() => moveToFolder(f.id)}
                style={[styles.folderRow, { borderBottomColor: colors.divider }]}
                testID={`move-folder-${f.id}`}
              >
                <View style={[styles.folderDot, { backgroundColor: f.color }]} />
                <Text style={{ color: colors.onSurface, fontSize: typeScale.lg }}>{f.name}</Text>
              </Pressable>
            ))}
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

function DrawerRow({
  icon,
  iconColor,
  label,
  onPress,
  active,
  testID,
}: {
  icon: any;
  iconColor?: string;
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
      <Ionicons name={icon} size={20} color={iconColor || (active ? colors.brand : colors.onSurface)} />
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

function ActionRow({
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
        paddingVertical: spacing.md,
        paddingHorizontal: spacing.sm,
        borderRadius: radius.sm,
        backgroundColor: pressed ? colors.surfaceTertiary : 'transparent',
      })}
    >
      <Ionicons name={icon} size={22} color={c} />
      <Text style={{ marginLeft: spacing.md, fontSize: typeScale.lg, color: c }}>{label}</Text>
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
    top: 0,
    left: 0,
    right: 0,
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
  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: spacing.md },
  card: { padding: spacing.lg, borderRadius: radius.lg, marginBottom: spacing.md, minHeight: 120 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.xs },
  cardDate: { fontSize: typeScale.sm },
  cardTitle: { fontSize: typeScale.lg, fontWeight: '700', marginBottom: spacing.xs },
  cardPreview: { fontSize: typeScale.base, lineHeight: 18 },
  cardMeta: { flexDirection: 'row', alignItems: 'center', marginTop: spacing.sm, gap: 4 },
  cardMetaText: { fontSize: typeScale.sm },
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
  drawerBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', flexDirection: 'row' },
  drawerPanel: {
    width: '78%',
    maxWidth: 320,
    height: '100%',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
    borderTopRightRadius: radius.lg,
    borderBottomRightRadius: radius.lg,
  },
  drawerBrand: { fontSize: typeScale.xxl, fontWeight: '800' },
  drawerSub: { fontSize: typeScale.sm, marginTop: 4 },
  drawerSection: {
    fontSize: typeScale.sm,
    letterSpacing: 1.2,
    fontWeight: '600',
    marginTop: spacing.xl,
    marginBottom: spacing.sm,
    marginLeft: spacing.sm,
  },
  drawerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    marginVertical: 2,
  },
  drawerDivider: { height: 1, marginVertical: spacing.sm },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
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
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
