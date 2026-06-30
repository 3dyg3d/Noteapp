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
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { BlurView } from 'expo-blur';

import { useTheme } from '@/src/theme/ThemeContext';
import { spacing, radius, typeScale } from '@/src/theme/tokens';
import { NotesApi, FoldersApi, Note, Folder } from '@/src/api/client';

type ViewMode = 'grid' | 'list';

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
  const [activeFolder, setActiveFolder] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('grid');

  const load = useCallback(async () => {
    try {
      const [n, f] = await Promise.all([
        NotesApi.list(search.trim() || undefined, activeFolder),
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
  }, [search, activeFolder]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [search, activeFolder, load]);

  const pinned = useMemo(() => notes.filter((n) => n.pinned), [notes]);
  const others = useMemo(() => notes.filter((n) => !n.pinned), [notes]);

  const createNote = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    try {
      const note = await NotesApi.create({
        title: '',
        content: '',
        folder_id: activeFolder,
      });
      router.push(`/note/${note.id}`);
    } catch (e) {
      console.warn(e);
    }
  };

  const folderById = (id: string | null | undefined) =>
    id ? folders.find((f) => f.id === id) : undefined;

  const renderNoteCard = (note: Note) => {
    const folder = folderById(note.folder_id);
    const cardWidth = viewMode === 'grid' ? '48%' : '100%';
    return (
      <Pressable
        key={note.id}
        testID={`note-card-${note.id}`}
        onPress={() => {
          if (note.locked) {
            router.push(`/lock?noteId=${note.id}`);
          } else {
            router.push(`/note/${note.id}`);
          }
        }}
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
            <Ionicons
              name="lock-closed"
              size={14}
              color={colors.muted}
              style={{ marginRight: 6 }}
            />
          )}
          <Text style={[styles.cardDate, { color: colors.muted }]}>
            {formatDate(note.updated_at)}
          </Text>
        </View>
        <Text
          numberOfLines={1}
          style={[styles.cardTitle, { color: colors.onSurface }]}
        >
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
            <Text style={[styles.cardMetaText, { color: colors.muted }]}>
              {note.images.length}
            </Text>
          </View>
        )}
      </Pressable>
    );
  };

  const isEmpty = !loading && notes.length === 0;

  return (
    <View style={[styles.container, { backgroundColor: colors.surface }]}>
      {/* Sticky Header (frosted) */}
      <BlurView
        intensity={isDark ? 40 : 60}
        tint={isDark ? 'dark' : 'light'}
        style={[styles.header, { paddingTop: insets.top + spacing.sm }]}
      >
        <View style={styles.headerTopRow}>
          <Text style={[styles.bigTitle, { color: colors.onSurface }]} testID="home-title">
            Notes
          </Text>
          <View style={styles.headerActions}>
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
            <Pressable
              testID="folders-btn"
              onPress={() => router.push('/folders')}
              style={[styles.iconBtn, { backgroundColor: colors.surfaceSecondary }]}
            >
              <Ionicons name="folder-outline" size={20} color={colors.onSurface} />
            </Pressable>
            <Pressable
              testID="settings-btn"
              onPress={() => router.push('/settings')}
              style={[styles.iconBtn, { backgroundColor: colors.surfaceSecondary }]}
            >
              <Ionicons name="settings-outline" size={20} color={colors.onSurface} />
            </Pressable>
          </View>
        </View>

        {/* Search */}
        <View
          style={[styles.searchBar, { backgroundColor: colors.surfaceSecondary }]}
        >
          <Ionicons name="search" size={18} color={colors.muted} />
          <TextInput
            testID="search-input"
            placeholder="Search notes"
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

        {/* Folder chips */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chipRow}
          style={styles.chipScroll}
        >
          <Chip
            label="All"
            active={activeFolder === null}
            color={colors.brand}
            onPress={() => setActiveFolder(null)}
            testID="chip-all"
          />
          {folders.map((f) => (
            <Chip
              key={f.id}
              label={f.name}
              dotColor={f.color}
              active={activeFolder === f.id}
              color={colors.brand}
              onPress={() => setActiveFolder(f.id)}
              testID={`chip-folder-${f.id}`}
            />
          ))}
        </ScrollView>
      </BlurView>

      {/* Content */}
      <FlatList
        testID="notes-list"
        data={[]} // we render content via ListHeader/Footer for sectioning
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
          paddingTop: 200, // space below sticky header
          paddingBottom: insets.bottom + 100,
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
                <Ionicons name="document-text-outline" size={56} color={colors.brand} />
                <Text style={[styles.emptyTitle, { color: colors.onSurface }]}>
                  No notes yet
                </Text>
                <Text style={[styles.emptySub, { color: colors.muted }]}>
                  Tap the + button to create your first note
                </Text>
                <Pressable
                  testID="empty-create-btn"
                  onPress={createNote}
                  style={[styles.emptyBtn, { backgroundColor: colors.brand }]}
                >
                  <Text style={{ color: colors.onBrandPrimary, fontWeight: '600' }}>
                    Create Note
                  </Text>
                </Pressable>
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

      {/* FAB */}
      <Pressable
        testID="fab-create-note"
        onPress={createNote}
        style={({ pressed }) => [
          styles.fab,
          {
            backgroundColor: colors.brand,
            bottom: insets.bottom + spacing.lg,
            transform: [{ scale: pressed ? 0.95 : 1 }],
          },
        ]}
      >
        <Ionicons name="add" size={28} color={colors.onBrandPrimary} />
      </Pressable>
    </View>
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

function Chip({
  label,
  active,
  color,
  onPress,
  dotColor,
  testID,
}: {
  label: string;
  active: boolean;
  color: string;
  onPress: () => void;
  dotColor?: string;
  testID?: string;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      style={{
        height: 36,
        paddingHorizontal: spacing.lg,
        borderRadius: radius.pill,
        backgroundColor: active ? color : colors.surfaceSecondary,
        flexDirection: 'row',
        alignItems: 'center',
        flexShrink: 0,
      }}
    >
      {!!dotColor && (
        <View
          style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            backgroundColor: dotColor,
            marginRight: 6,
          }}
        />
      )}
      <Text
        style={{
          color: active ? colors.onBrandPrimary : colors.onSurface,
          fontWeight: active ? '700' : '500',
          fontSize: typeScale.base,
        }}
      >
        {label}
      </Text>
    </Pressable>
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
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  bigTitle: { fontSize: typeScale.xxxl, fontWeight: '700' },
  headerActions: { flexDirection: 'row', gap: spacing.sm },
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
  chipScroll: { marginTop: spacing.md },
  chipRow: { gap: spacing.sm, paddingRight: spacing.lg },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  card: {
    padding: spacing.lg,
    borderRadius: radius.lg,
    marginBottom: spacing.md,
    minHeight: 120,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.xs },
  cardDate: { fontSize: typeScale.sm },
  cardTitle: { fontSize: typeScale.lg, fontWeight: '700', marginBottom: spacing.xs },
  cardPreview: { fontSize: typeScale.base, lineHeight: 18 },
  cardMeta: { flexDirection: 'row', alignItems: 'center', marginTop: spacing.sm, gap: 4 },
  cardMetaText: { fontSize: typeScale.sm },
  empty: {
    padding: spacing.xxl,
    borderRadius: radius.lg,
    alignItems: 'center',
    marginTop: spacing.xl,
  },
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
});
