import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  Platform,
  BackHandler,
  ToastAndroid,
  Animated as RNAnimated,
  PanResponder,
  useWindowDimensions,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

import { useTheme } from '@/src/theme/ThemeContext';
import { spacing, radius, typeScale, folderColors, labelColors } from '@/src/theme/tokens';
import { NotesApi, FoldersApi, LabelsApi, Note, Folder, Label, ChecklistItem, NoteStatus } from '@/src/api/client';
import { haptic, useAppSettings } from '@/src/state/useAppSettings';
import PaperPreview, { PaperType } from '@/src/components/PaperPreview';
import HandwritingThumbnail from '@/src/components/HandwritingThumbnail';

type ViewMode = 'grid' | 'list';
// A category may be one of the fixed views, a folder id, or a label id
// prefixed with `label:` so we can distinguish them from folder ids.
type CategoryKey = 'all' | 'pinned' | 'recent' | 'trash' | 'folders' | string;
type SortBy = 'updated' | 'created' | 'title';

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

/**
 * Convert a `#RRGGBB` hex color into an rgba() string with the given alpha.
 * Falls back gracefully to the raw color if parsing fails.
 */
function withAlpha(hex: string, alpha: number): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return hex;
  const int = parseInt(m[1], 16);
  const r = (int >> 16) & 0xff;
  const g = (int >> 8) & 0xff;
  const b = int & 0xff;
  return `rgba(${r},${g},${b},${alpha})`;
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
  // Base column count purely from viewport width — each breakpoint targets a
  // comfortable card size for typical readable text.
  const baseColumns = useMemo(() => {
    if (winW >= 1400) return 6;
    if (winW >= 1100) return 5;
    if (winW >= 850) return 4;
    if (winW >= 620) return 3;
    return 2;
  }, [winW]);
  // The user can zoom the home grid via pinch or the size cycle in the header.
  // `homeTileScale` is a persisted multiplier where <1 = smaller tiles (more per
  // row) and >1 = larger tiles (fewer per row). We convert it into a column count
  // relative to the base, then clamp to something legible on every viewport.
  const { settings, update: updateSettings } = useAppSettings();
  const tileScale = settings.homeTileScale ?? 1.0;
  const numColumns = useMemo(() => {
    const raw = Math.round(baseColumns / tileScale);
    const maxCols = winW >= 620 ? 8 : 4;
    return Math.max(1, Math.min(maxCols, raw));
  }, [baseColumns, tileScale, winW]);
  const cardPxWidth = useMemo(() => {
    const horizPad = spacing.lg * 2;
    const totalGap = spacing.md * (numColumns - 1);
    return (winW - horizPad - totalGap) / numColumns;
  }, [winW, numColumns]);
  // Uniform card height so every note tile in the grid lines up evenly, regardless
  // of preview length / labels / thumbnail. A portrait-ish 1.35 aspect ratio feels
  // like a real page peek without stretching. List mode ignores this — its rows
  // still auto-size.
  const cardPxHeight = useMemo(() => Math.round(cardPxWidth * 1.35), [cardPxWidth]);

  const [notes, setNotes] = useState<Note[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [labels, setLabels] = useState<Label[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<CategoryKey>('all');
  const [viewMode, setViewMode] = useState<ViewMode>('grid');
  const [sortBy, setSortBy] = useState<SortBy>('updated');
  const [showSortMenu, setShowSortMenu] = useState(false);

  // Modals
  const isTablet = winW >= 720;
  const [drawerOpen, setDrawerOpen] = useState<boolean>(() => winW >= 720);
  const closeDrawerIfPhone = useCallback(() => {
    if (!isTablet) setDrawerOpen(false);
  }, [isTablet]);
  const SIDEBAR_WIDTH = 300;
  const [showTemplate, setShowTemplate] = useState(false);
  const [showMovePicker, setShowMovePicker] = useState(false);
  const [folderModal, setFolderModal] = useState<{
    parentId: string | null;
    folder?: Folder; // edit existing
    anchor?: { x: number; y: number; w: number; h: number } | null;
  } | null>(null);

  // Label editor modal (create or edit an existing tag). `label` is only set
  // when editing.
  const [labelModal, setLabelModal] = useState<{
    label?: Label;
    anchor?: { x: number; y: number; w: number; h: number } | null;
  } | null>(null);
  // Bulk-assign labels picker for selected notes.
  const [showLabelPicker, setShowLabelPicker] = useState(false);

  // Drawer expand state
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Multi-select
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const selectionMode = selectedIds.size > 0;

  // Info modal — surface metadata for a single note or a folder.
  const [infoTarget, setInfoTarget] = useState<{ kind: 'note'; note: Note } | { kind: 'folder'; folder: Folder } | null>(null);

  const status: NoteStatus = category === 'trash' ? 'trash' : 'active';
  // Label filter: category prefixed with `label:` filters notes by that label
  // on the server.
  const labelFilter = useMemo(() => {
    if (typeof category === 'string' && category.startsWith('label:')) {
      return category.slice('label:'.length);
    }
    return null;
  }, [category]);
  const folderFilter = useMemo(() => {
    if (category === 'all' || category === 'pinned' || category === 'recent' || category === 'trash' || category === 'folders') return null;
    if (labelFilter) return null;
    return category;
  }, [category, labelFilter]);

  const load = useCallback(async () => {
    try {
      const [n, f, l] = await Promise.all([
        NotesApi.list({
          q: search.trim() || undefined,
          folderId: folderFilter,
          labelId: labelFilter,
          status,
          pinned: category === 'pinned' ? true : undefined,
        }),
        FoldersApi.list(),
        LabelsApi.list(),
      ]);
      setNotes(n);
      setFolders(f);
      setLabels(l);
    } catch (e) {
      console.warn('load failed', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [search, folderFilter, labelFilter, status, category]);

  useFocusEffect(useCallback(() => { load(); }, [load]));
  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [search, category, load]);

  // Sort & filter notes client-side based on chosen sort
  const sortedNotes = useMemo(() => {
    const arr = [...notes];
    if (sortBy === 'title') {
      arr.sort((a, b) => (a.title || 'Untitled').localeCompare(b.title || 'Untitled'));
    } else if (sortBy === 'created') {
      arr.sort((a, b) => b.created_at.localeCompare(a.created_at));
    } else {
      arr.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    }
    if (category === 'recent') return arr.slice(0, 20);
    return arr;
  }, [notes, sortBy, category]);

  const pinnedNotes = useMemo(
    () => (category === 'all' ? sortedNotes.filter((n) => n.pinned) : []),
    [sortedNotes, category]
  );
  const otherNotes = useMemo(
    () => (category === 'all' ? sortedNotes.filter((n) => !n.pinned) : sortedNotes),
    [sortedNotes, category]
  );

  const folderById = (id: string | null | undefined) =>
    id ? folders.find((f) => f.id === id) : undefined;

  // ---- File-manager-style folder navigation ----
  const currentFolder = useMemo(
    () => folders.find((f) => f.id === category),
    [category, folders]
  );
  const insideFolder = !!currentFolder;
  const childFoldersOf = useCallback(
    (parentId: string | null) =>
      folders
        .filter((f) => (f.parent_id ?? null) === parentId)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [folders]
  );
  const folderViewChildren = useMemo(() => {
    if (category === 'folders') return childFoldersOf(null);
    if (insideFolder) return childFoldersOf(category as string);
    return [];
  }, [category, insideFolder, childFoldersOf]);
  const isFileManagerView = category === 'folders' || insideFolder;
  // At folder view root, also list notes that don't belong to any folder
  const folderViewNotes = useMemo(
    () => (category === 'folders' ? sortedNotes.filter((n) => !n.folder_id) : []),
    [sortedNotes, category]
  );
  const goBack = () => {
    haptic.selection();
    if (currentFolder?.parent_id) setCategory(currentFolder.parent_id);
    else setCategory('folders');
  };

  // FAB
  const onFabPress = () => {
    haptic.light();
    setShowTemplate(true);
  };
  // Handwriting prep popup (paper size + template + color + line spacing before opening canvas)
  const [showHwPrep, setShowHwPrep] = useState(false);
  const [hwSize, setHwSize] = useState<'a4' | 'a5' | 'letter' | 'index' | 'custom'>('a4');
  const [hwCustomW, setHwCustomW] = useState<string>('1024');
  const [hwCustomH, setHwCustomH] = useState<string>('1366');
  const [hwTemplate, setHwTemplate] = useState<'blank' | 'ruled' | 'narrow' | 'grid' | 'dotted' | 'cornell' | 'planner' | 'todo'>('blank');
  const [hwPaperColor, setHwPaperColor] = useState<string>('#FBFAF6'); // hex, defaults to White
  const [hwLineSpacing, setHwLineSpacing] = useState<number>(32);
  const [hwTitle, setHwTitle] = useState<string>('');
  const [hwFolderId, setHwFolderId] = useState<string | null>(null);
  const [hwOrientation, setHwOrientation] = useState<'portrait' | 'landscape'>('portrait');
  const [showHwColorPicker, setShowHwColorPicker] = useState(false);
  const [showHwFolderPicker, setShowHwFolderPicker] = useState(false);

  // Persistent favourite colors (3 slots). Read/written via useAppSettings. The
  // hook itself is called near the top of the component (see homeTileScale
  // section) so this comment simply re-uses that same `settings` object.
  const favoriteHwColors = useMemo(() => {
    const arr = (settings.favoriteHwColors || []).slice(0, 3);
    while (arr.length < 3) arr.push('#FBFAF6');
    return arr;
  }, [settings.favoriteHwColors]);

  const HW_PAPER_COLORS: { hex: string; label: string }[] = [
    { hex: '#FBFAF6', label: 'White' },
    { hex: '#F4ECDA', label: 'Cream' },
    { hex: '#FFF4C4', label: 'Yellow' },
    { hex: '#E1F0E0', label: 'Mint' },
    { hex: '#DCE6F0', label: 'Sky' },
    { hex: '#F5DDDD', label: 'Rose' },
    { hex: '#ECECEC', label: 'Gray' },
    { hex: '#0a0a0a', label: 'Black' },
    { hex: '#FFD8A8', label: 'Peach' },
    { hex: '#D7E9D8', label: 'Sage' },
    { hex: '#E6DAF8', label: 'Lavender' },
    { hex: '#FFC8D6', label: 'Pink' },
  ];

  const saveFavoriteHwColor = (hex: string, slot: number) => {
    const next = [...favoriteHwColors];
    next[slot] = hex;
    updateSettings({ favoriteHwColors: next });
  };

  const hwSupportsSpacing = (t: typeof hwTemplate) =>
    t === 'ruled' || t === 'narrow' || t === 'grid' || t === 'dotted' || t === 'cornell' || t === 'planner' || t === 'todo';

  const createFromTemplate = async (tpl: Template) => {
    setShowTemplate(false);
    if (tpl.mode === 'drawing') {
      // Reset the prep popup defaults from the current context
      setHwTitle('');
      setHwFolderId(folderFilter);
      setHwPaperColor(favoriteHwColors[0] || '#FBFAF6');
      setShowHwPrep(true);
      return;
    }
    try {
      const seed = tpl.apply();
      const note = await NotesApi.create({ ...seed, folder_id: folderFilter });
      router.push(`/note/${note.id}`);
    } catch (e) {
      console.warn(e);
    }
  };

  const startHandwriting = async () => {
    setShowHwPrep(false);
    try {
      // For custom or any size, swap W/H if landscape
      let customSize: { w: number; h: number } | undefined;
      if (hwSize === 'custom') {
        const w = Math.max(200, Math.min(8000, parseInt(hwCustomW, 10) || 1024));
        const h = Math.max(200, Math.min(8000, parseInt(hwCustomH, 10) || 1366));
        customSize =
          hwOrientation === 'landscape' && h > w
            ? { w: h, h: w }
            : hwOrientation === 'portrait' && w > h
            ? { w: h, h: w }
            : { w, h };
      }
      const drawing_data = JSON.stringify({
        paper: hwTemplate,
        paperSize: hwSize,
        customSize,
        paperColor: hwPaperColor, // hex
        orientation: hwOrientation,
        lineSpacing: hwSupportsSpacing(hwTemplate) ? hwLineSpacing : undefined,
        items: [],
      });
      const note = await NotesApi.create({
        title: hwTitle.trim() || 'Handwritten note',
        content: '',
        note_type: 'handwriting',
        drawing_data,
        folder_id: hwFolderId,
      });
      router.push(`/draw/${note.id}`);
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

  // ---- Back-button / swipe-back handling ----
  // Prevents accidental app exit from the home screen. Instead we unwind context
  // layer-by-layer: modals → selection → drawer → sub-view → folder-nav → exit
  // confirmation ("Press back again to exit"). Only registered while home is focused.
  const lastBackAtRef = useRef<number>(0);
  const [exitHintVisible, setExitHintVisible] = useState(false);
  const exitHintFade = useRef(new RNAnimated.Value(0)).current;
  const exitHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showExitHint = useCallback(() => {
    // Native Android toast where available for a familiar look.
    if (Platform.OS === 'android') {
      try { ToastAndroid.show('Press back again to exit', ToastAndroid.SHORT); } catch {}
    }
    // Also show our custom in-app pill so users on iOS / web also see it.
    setExitHintVisible(true);
    RNAnimated.timing(exitHintFade, {
      toValue: 1,
      duration: 160,
      useNativeDriver: true,
    }).start();
    if (exitHintTimerRef.current) clearTimeout(exitHintTimerRef.current);
    exitHintTimerRef.current = setTimeout(() => {
      RNAnimated.timing(exitHintFade, {
        toValue: 0,
        duration: 220,
        useNativeDriver: true,
      }).start(() => setExitHintVisible(false));
    }, 1800);
  }, [exitHintFade]);

  useEffect(() => () => {
    if (exitHintTimerRef.current) clearTimeout(exitHintTimerRef.current);
  }, []);

  // Central layered back handler. Returns true if the press was consumed.
  const consumeBackPress = useCallback(() => {
    // 1. Any open sheet / modal — dismiss it first.
    if (folderModal) { setFolderModal(null); return true; }
    if (labelModal) { setLabelModal(null); return true; }
    if (showLabelPicker) { setShowLabelPicker(false); return true; }
    if (showMovePicker) { setShowMovePicker(false); return true; }
    if (showTemplate) { setShowTemplate(false); return true; }
    if (showHwPrep) { setShowHwPrep(false); return true; }
    if (showHwColorPicker) { setShowHwColorPicker(false); return true; }
    if (showHwFolderPicker) { setShowHwFolderPicker(false); return true; }
    if (showSortMenu) { setShowSortMenu(false); return true; }
    if (infoTarget) { setInfoTarget(null); return true; }
    // 2. Selection mode → clear it.
    if (selectionMode) { clearSelection(); return true; }
    // 3. Phone drawer is open → close it.
    if (!isTablet && drawerOpen) { setDrawerOpen(false); return true; }
    // 4. Inside a folder → navigate one folder up.
    if (insideFolder) { goBack(); return true; }
    // 5. Any filtered view (label / trash / pinned / recents / folders) → back to All.
    if (category !== 'all') { setCategory('all'); return true; }
    // 6. Confirm exit — first press shows the hint, second within 2s exits.
    const now = Date.now();
    if (now - lastBackAtRef.current < 2000) {
      lastBackAtRef.current = 0;
      return false; // release to the OS so the app can exit
    }
    lastBackAtRef.current = now;
    showExitHint();
    return true;
  }, [
    folderModal, labelModal, showLabelPicker, showMovePicker, showTemplate,
    showHwPrep, showHwColorPicker, showHwFolderPicker, showSortMenu, infoTarget,
    selectionMode, isTablet, drawerOpen, insideFolder, category, showExitHint,
  ]);

  // Only listen while home is focused so pushed screens (note editor, draw)
  // aren't affected. Android hardware/gesture back both fire this event.
  useFocusEffect(
    useCallback(() => {
      const sub = BackHandler.addEventListener('hardwareBackPress', consumeBackPress);
      return () => sub.remove();
    }, [consumeBackPress])
  );

  const categoryLabel = useMemo(() => {
    if (category === 'all') return 'All notes';
    if (category === 'pinned') return 'Pinned';
    if (category === 'recent') return 'Recents';
    if (category === 'trash') return 'Trash';
    if (category === 'folders') return 'Folders';
    if (labelFilter) {
      const l = labels.find((ll) => ll.id === labelFilter);
      return l ? `# ${l.name}` : 'Label';
    }
    return folderById(category)?.name || 'Notes';
  }, [category, folders, labels, labelFilter]);

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

  // ---- Anchor helpers for folder / label create-edit popovers ----
  // Measure the pressed "+" button (or long-pressed row) in window coordinates so
  // the popover can render right next to it — just like the tool popovers in the
  // handwriting toolbar. Falls back to a centred sheet if measurement fails.
  const measureAnchor = (
    e: any
  ): Promise<{ x: number; y: number; w: number; h: number } | null> => {
    return new Promise((resolve) => {
      const t = e?.currentTarget;
      if (t && typeof t.measureInWindow === 'function') {
        t.measureInWindow((x: number, y: number, w: number, h: number) => {
          if (typeof x === 'number' && typeof y === 'number' && w > 0 && h > 0) {
            resolve({ x, y, w, h });
          } else {
            resolve(null);
          }
        });
      } else {
        // Web/tap-fallback: use the tap coordinates and a rough size.
        const px = e?.nativeEvent?.pageX;
        const py = e?.nativeEvent?.pageY;
        if (typeof px === 'number' && typeof py === 'number') {
          resolve({ x: px - 22, y: py - 14, w: 44, h: 28 });
        } else {
          resolve(null);
        }
      }
    });
  };

  const openFolderCreate = async (parentId: string | null, e: any) => {
    const anchor = await measureAnchor(e);
    setFolderModal({ parentId, anchor });
  };

  const openFolderEdit = async (folder: Folder, e: any) => {
    const anchor = await measureAnchor(e);
    setFolderModal({ parentId: folder.parent_id, folder, anchor });
  };

  const openLabelCreate = async (e: any) => {
    const anchor = await measureAnchor(e);
    setLabelModal({ anchor });
  };

  const openLabelEdit = async (label: Label, e: any) => {
    const anchor = await measureAnchor(e);
    setLabelModal({ label, anchor });
  };

  // Label modal save/delete handlers.
  const saveLabelModal = async (name: string, color: string) => {
    if (!labelModal) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      if (labelModal.label) {
        await LabelsApi.update(labelModal.label.id, { name: trimmed, color });
      } else {
        await LabelsApi.create({ name: trimmed, color });
      }
    } catch (e) {
      console.warn('label save failed', e);
    }
    setLabelModal(null);
    load();
  };

  const deleteLabelFromModal = async () => {
    if (!labelModal?.label) return;
    try {
      await LabelsApi.remove(labelModal.label.id);
    } catch (e) {
      console.warn('label delete failed', e);
    }
    // If we were viewing that label, reset the category.
    if (labelFilter === labelModal.label.id) setCategory('all');
    setLabelModal(null);
    load();
  };

  // Toggle a label across all currently-selected notes.
  // If any selected note is missing the label, add it to everyone;
  // otherwise remove it from everyone.
  const bulkToggleLabel = async (labelId: string) => {
    const targets = notes.filter((n) => selectedIds.has(n.id));
    if (targets.length === 0) return;
    const anyMissing = targets.some((n) => !(n.label_ids || []).includes(labelId));
    await Promise.all(
      targets.map((n) => {
        const current = new Set(n.label_ids || []);
        if (anyMissing) current.add(labelId);
        else current.delete(labelId);
        return NotesApi.update(n.id, { label_ids: Array.from(current) });
      })
    );
    load();
  };

  // --- Card renderer ---
  const renderNoteCard = (note: Note) => {
    const folder = folderById(note.folder_id);
    const isGrid = viewMode === 'grid';
    const cardWidth = isGrid ? cardPxWidth : undefined;
    const cardHeight = isGrid ? cardPxHeight : undefined;
    const isSelected = selectedIds.has(note.id);
    const noteLabels = (note.label_ids || [])
      .map((lid) => labels.find((ll) => ll.id === lid))
      .filter(Boolean) as Label[];
    // Grid mode: content-only card, with title + date rendered as a caption
    // UNDER the card so the tile itself looks like a clean preview (no border
    // around a name/date block). List mode keeps the classic in-card layout.
    if (isGrid) {
      return (
        <View
          key={note.id}
          style={{ width: cardWidth, alignItems: 'stretch', marginBottom: spacing.md }}
        >
          <Pressable
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
              {
                width: '100%',
                height: cardHeight,
                borderRadius: radius.lg,
                backgroundColor: isSelected ? colors.brandTertiary : colors.surfaceSecondary,
                borderLeftColor: folder?.color || 'transparent',
                borderLeftWidth: folder ? 3 : 0,
                borderWidth: isSelected ? 2 : 0,
                borderColor: isSelected ? colors.brand : 'transparent',
                opacity: pressed ? 0.85 : 1,
                overflow: 'hidden',
                padding: spacing.md,
              },
            ]}
          >
            {selectionMode && (
              <View style={[styles.selectMark, { backgroundColor: isSelected ? colors.brand : colors.surface, borderColor: colors.brand }]}>
                {isSelected && <Ionicons name="checkmark" size={14} color={colors.onBrandPrimary} />}
              </View>
            )}
            {!note.locked && note.note_type !== 'handwriting' && (
              <Text
                numberOfLines={6}
                style={[styles.cardPreview, { color: colors.onSurfaceSecondary, marginTop: 0 }]}
              >
                {previewText(note) || 'No additional text'}
              </Text>
            )}
            {!note.locked && note.note_type === 'handwriting' && (
              <View style={{ flex: 1 }}>
                {note.drawing_data ? (
                  <HandwritingThumbnail
                    drawingData={note.drawing_data}
                    width={cardPxWidth - spacing.md * 2}
                    height={Math.max(80, (cardPxHeight ?? Math.round(cardPxWidth * 0.9)) - spacing.md * 2)}
                    radius={6}
                  />
                ) : (
                  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <Ionicons name="brush" size={14} color={colors.brand} />
                    <Text style={[styles.cardPreview, { color: colors.brand, marginLeft: 4, fontWeight: '600' }]}>
                      Handwritten note
                    </Text>
                  </View>
                )}
              </View>
            )}
            {note.locked && (
              <Text style={[styles.cardPreview, { color: colors.muted, fontStyle: 'italic' }]}>
                Tap to unlock
              </Text>
            )}
            {!!note.images.length && (
              <View style={[styles.cardMeta, { position: 'absolute', top: 8, right: 8 }]}>
                <Ionicons name="image-outline" size={12} color={colors.muted} />
                <Text style={[styles.cardMetaText, { color: colors.muted }]}>{note.images.length}</Text>
              </View>
            )}
          </Pressable>

          {/* Caption row — title + date + pin/lock icons live UNDER the card,
              matching iOS Photos-style tiles. Labels flow below the caption. */}
          <View style={{ paddingHorizontal: 4, paddingTop: spacing.xs }}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              {note.pinned && <Ionicons name="pin" size={12} color={colors.brand} style={{ marginRight: 4 }} />}
              {note.locked && <Ionicons name="lock-closed" size={12} color={colors.muted} style={{ marginRight: 4 }} />}
              <Text
                numberOfLines={1}
                style={{
                  flex: 1,
                  fontSize: typeScale.base,
                  fontWeight: '700',
                  color: colors.onSurface,
                }}
              >
                {note.title || 'Untitled note'}
              </Text>
            </View>
            <Text style={{ fontSize: typeScale.sm, color: colors.muted, marginTop: 2 }}>
              {formatDate(note.updated_at)}
            </Text>
            {noteLabels.length > 0 && (
              <View style={[styles.labelChipRow, { marginTop: 4 }]}>
                {noteLabels.slice(0, 3).map((l) => (
                  <View
                    key={l.id}
                    style={[styles.labelChip, { backgroundColor: withAlpha(l.color, 0.18), borderColor: l.color }]}
                  >
                    <View style={[styles.labelChipDot, { backgroundColor: l.color }]} />
                    <Text numberOfLines={1} style={[styles.labelChipText, { color: l.color }]}>
                      {l.name}
                    </Text>
                  </View>
                ))}
                {noteLabels.length > 3 && (
                  <Text style={{ color: colors.muted, fontSize: typeScale.sm, marginLeft: 4 }}>+{noteLabels.length - 3}</Text>
                )}
              </View>
            )}
          </View>
        </View>
      );
    }

    // ---- List mode (unchanged): compact single-row card with everything inside.
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
            height: cardHeight,
            alignSelf: 'stretch',
            borderLeftColor: folder?.color || 'transparent',
            borderLeftWidth: folder ? 3 : 0,
            borderWidth: isSelected ? 2 : 0,
            borderColor: isSelected ? colors.brand : 'transparent',
            opacity: pressed ? 0.85 : 1,
            overflow: 'hidden',
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
            numberOfLines={2}
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
        {noteLabels.length > 0 && (
          <View style={styles.labelChipRow}>
            {noteLabels.slice(0, 3).map((l) => (
              <View
                key={l.id}
                style={[styles.labelChip, { backgroundColor: withAlpha(l.color, 0.18), borderColor: l.color }]}
              >
                <View style={[styles.labelChipDot, { backgroundColor: l.color }]} />
                <Text numberOfLines={1} style={[styles.labelChipText, { color: l.color }]}>
                  {l.name}
                </Text>
              </View>
            ))}
            {noteLabels.length > 3 && (
              <Text style={{ color: colors.muted, fontSize: typeScale.sm, marginLeft: 4 }}>+{noteLabels.length - 3}</Text>
            )}
          </View>
        )}
      </Pressable>
    );
  };

  const isEmpty = !loading && notes.length === 0;

  // Home-grid pinch state (PanResponder-based, since RNGH's Pinch loses to
  // FlatList's ScrollView on some Android builds). Tracks the initial finger
  // distance + starting `homeTileScale` so we can compute a stable scale
  // multiplier as the fingers move.
  const pinchStateRef = useRef({ startDistance: 0, startScale: 1, active: false });

  // File-manager view (folder tiles + folder notes list). Extracted from the
  // FlatList's ListHeaderComponent so the return JSX stays readable and the
  // isFileManagerView branch can be reused if we ever add a second grid target.
  const renderFileManager = () => (
    <View>
      {/* Breadcrumb / current location when inside a folder */}
      {insideFolder && (
        <View style={styles.breadcrumbRow}>
          <Pressable
            testID="breadcrumb-root"
            onPress={() => { haptic.selection(); setCategory('folders'); }}
            style={({ pressed }) => [styles.breadcrumbChip, { backgroundColor: pressed ? colors.surfaceTertiary : colors.surfaceSecondary }]}
          >
            <Ionicons name="folder-open-outline" size={14} color={colors.brand} />
            <Text style={[styles.breadcrumbText, { color: colors.brand }]}>Folders</Text>
          </Pressable>
          <Ionicons name="chevron-forward" size={14} color={colors.muted} style={{ marginHorizontal: 4 }} />
          <Text numberOfLines={1} style={[styles.breadcrumbText, { color: colors.onSurface, fontWeight: '700' }]}>
            {currentFolder?.name}
          </Text>
        </View>
      )}

      {/* Folder tiles grid */}
      <View style={styles.grid}>
        <Pressable
          testID="folder-tile-add"
          onPress={(e) =>
            openFolderCreate(insideFolder ? (category as string) : null, e)
          }
          style={({ pressed }) => [
            styles.folderTile,
            {
              width: cardPxWidth,
              backgroundColor: colors.brandTertiary,
              opacity: pressed ? 0.8 : 1,
            },
          ]}
        >
          <Ionicons name="add-circle-outline" size={40} color={colors.brand} />
          <Text style={{ color: colors.brand, fontWeight: '700', marginTop: spacing.sm }}>
            New folder
          </Text>
        </Pressable>
        {folderViewChildren.map((f) => (
          <Pressable
            key={f.id}
            testID={`folder-tile-${f.id}`}
            onPress={() => { haptic.selection(); setCategory(f.id); }}
            onLongPress={(e) => openFolderEdit(f, e)}
            delayLongPress={350}
            style={({ pressed }) => [
              styles.folderTile,
              {
                width: cardPxWidth,
                backgroundColor: colors.surfaceSecondary,
                borderTopWidth: 6,
                borderTopColor: f.color,
                opacity: pressed ? 0.85 : 1,
              },
            ]}
          >
            <Ionicons name="folder" size={36} color={f.color} />
            <Text
              numberOfLines={1}
              style={{
                marginTop: spacing.sm,
                fontWeight: '700',
                color: colors.onSurface,
                fontSize: typeScale.base,
                maxWidth: '100%',
              }}
            >
              {f.name}
            </Text>
          </Pressable>
        ))}
      </View>

      {/* Notes section (unfiled at root, in-folder notes when inside) */}
      {category === 'folders' && folderViewNotes.length > 0 && (
        <>
          <SectionLabel label="Notes" color={colors.muted} />
          <View style={styles.grid}>{folderViewNotes.map(renderNoteCard)}</View>
        </>
      )}
      {insideFolder && otherNotes.length > 0 && (
        <>
          {folderViewChildren.length > 0 && (
            <SectionLabel label="Notes" color={colors.muted} />
          )}
          <View style={styles.grid}>{otherNotes.map(renderNoteCard)}</View>
        </>
      )}

      {/* Empty hint for file manager views */}
      {folderViewChildren.length === 0 &&
        (category === 'folders'
          ? folderViewNotes.length === 0
          : otherNotes.length === 0) && (
          <View
            style={[
              styles.empty,
              { backgroundColor: colors.surfaceSecondary, marginTop: spacing.lg },
            ]}
          >
            <Ionicons name="folder-open-outline" size={48} color={colors.brand} />
            <Text style={[styles.emptyTitle, { color: colors.onSurface }]}>
              {category === 'folders' ? 'No folders yet' : 'This folder is empty'}
            </Text>
            <Text style={[styles.emptySub, { color: colors.muted }]}>
              {category === 'folders'
                ? 'Tap "New folder" to create one, or use + to add an unfiled note.'
                : 'Tap + to add a note, or create a sub-folder.'}
            </Text>
          </View>
        )}
    </View>
  );

  // Shared drawer body (used by both the inline sidebar and the phone modal)
  const drawerInner = (
    <>
      <Text style={[styles.drawerBrand, { color: colors.brand }]}>GalaxyNotes</Text>
      <Text style={[styles.drawerSub, { color: colors.muted }]}>Your second brain</Text>

      <View style={{ height: spacing.lg }} />

      <DrawerRow
        icon="document-text-outline"
        label="All notes"
        active={category === 'all'}
        onPress={() => { setCategory('all'); closeDrawerIfPhone(); }}
        testID="drawer-all"
      />
      <DrawerRow
        icon="star-outline"
        label="Favorites"
        active={category === 'pinned'}
        onPress={() => { setCategory('pinned'); closeDrawerIfPhone(); }}
        testID="drawer-pinned"
      />
      <DrawerRow
        icon="time-outline"
        label="Recents"
        active={category === 'recent'}
        onPress={() => { setCategory('recent'); closeDrawerIfPhone(); }}
        testID="drawer-recent"
      />
      <DrawerRow
        icon="grid-outline"
        label="Folders"
        active={category === 'folders'}
        onPress={() => { setCategory('folders'); closeDrawerIfPhone(); }}
        testID="drawer-folders-view"
      />
      <DrawerRow
        icon="trash-outline"
        label="Trash"
        active={category === 'trash'}
        onPress={() => { setCategory('trash'); closeDrawerIfPhone(); }}
        testID="drawer-trash"
      />

      <View style={styles.drawerSectionRow}>
        <Text style={[styles.drawerSection, { color: colors.muted }]}>FOLDERS</Text>
        <Pressable
          testID="drawer-new-folder"
          onPress={(e) => openFolderCreate(null, e)}
          style={[styles.smallAddBtn, { backgroundColor: colors.brandTertiary }]}
        >
          <Ionicons name="add" size={16} color={colors.brand} />
          <Text style={{ color: colors.brand, fontWeight: '700', marginLeft: 4, fontSize: typeScale.sm }}>
            New
          </Text>
        </Pressable>
      </View>

      <ScrollView style={{ flex: 1 }}>
        {folders.length === 0 && (
          <Text style={{ color: colors.muted, paddingHorizontal: spacing.md, paddingVertical: spacing.sm }}>
            No folders yet. Tap &quot;New&quot; to create one.
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
                onPress={() => { setCategory(f.id); closeDrawerIfPhone(); }}
                onLongPress={(e) => openFolderEdit(f, e)}
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
                onPress={(e) => openFolderCreate(f.id, e)}
                style={styles.iconBtnSmall}
              >
                <Ionicons name="add" size={18} color={colors.muted} />
              </Pressable>
            </View>
          );
        })}

        {folders.length > 0 && (
          <Text style={{ color: colors.muted, fontSize: typeScale.sm, marginTop: 2, marginBottom: spacing.sm, paddingHorizontal: spacing.md }}>
            Tip: long-press a folder to edit or delete.
          </Text>
        )}

        {/* ---- Labels section (tags) — sits directly under the folder tree so
            both categorisation lists stay together within the same scrollable
            column, instead of being pushed to the bottom of the drawer. ---- */}
        <View style={styles.drawerSectionRow}>
          <Text style={[styles.drawerSection, { color: colors.muted }]}>LABELS</Text>
          <Pressable
            testID="drawer-new-label"
            onPress={(e) => openLabelCreate(e)}
            style={[styles.smallAddBtn, { backgroundColor: colors.brandTertiary }]}
          >
            <Ionicons name="add" size={16} color={colors.brand} />
            <Text style={{ color: colors.brand, fontWeight: '700', marginLeft: 4, fontSize: typeScale.sm }}>
              New
            </Text>
          </Pressable>
        </View>
        {labels.length === 0 ? (
          <Text style={{ color: colors.muted, paddingHorizontal: spacing.md, paddingVertical: spacing.sm }}>
            No labels yet. Tap &quot;New&quot; to create one.
          </Text>
        ) : (
          labels.map((l) => {
            const isActive = category === `label:${l.id}`;
            return (
              <Pressable
                key={l.id}
                testID={`drawer-label-${l.id}`}
                onPress={() => { setCategory(`label:${l.id}`); closeDrawerIfPhone(); }}
                onLongPress={(e) => openLabelEdit(l, e)}
                delayLongPress={350}
                style={({ pressed }) => [
                  styles.drawerRow,
                  {
                    backgroundColor: isActive
                      ? colors.brandTertiary
                      : pressed
                      ? colors.surfaceSecondary
                      : 'transparent',
                  },
                ]}
              >
                <View
                  style={{
                    width: 12,
                    height: 12,
                    borderRadius: 6,
                    marginLeft: 4,
                    marginRight: spacing.md,
                    backgroundColor: l.color,
                  }}
                />
                <Text
                  numberOfLines={1}
                  style={{
                    flex: 1,
                    fontSize: typeScale.lg,
                    fontWeight: isActive ? '700' : '500',
                    color: isActive ? colors.brand : colors.onSurface,
                  }}
                >
                  {l.name}
                </Text>
              </Pressable>
            );
          })
        )}
        {labels.length > 0 && (
          <Text style={{ color: colors.muted, fontSize: typeScale.sm, marginTop: 2, paddingHorizontal: spacing.md }}>
            Tip: long-press a label to edit or delete.
          </Text>
        )}
      </ScrollView>

      <View style={{ height: 1, backgroundColor: colors.divider, marginVertical: spacing.sm }} />
      <DrawerRow
        icon="settings-outline"
        label="Settings"
        onPress={() => { closeDrawerIfPhone(); router.push('/settings'); }}
        testID="drawer-settings"
      />
    </>
  );

  return (
    <View style={{ flex: 1, flexDirection: 'row', backgroundColor: colors.surface }}>
      {/* Persistent inline sidebar on tablets */}
      {isTablet && drawerOpen && (
        <View
          testID="inline-sidebar"
          style={{
            width: SIDEBAR_WIDTH,
            backgroundColor: colors.surface,
            borderRightWidth: StyleSheet.hairlineWidth,
            borderRightColor: colors.divider,
            paddingHorizontal: spacing.lg,
            paddingTop: insets.top + spacing.lg,
            paddingBottom: insets.bottom + spacing.lg,
          }}
        >
          {drawerInner}
        </View>
      )}

      <View style={[styles.container, { backgroundColor: colors.surface }]}>
      {/* Sticky header — kept opaque so scrolling content doesn't bleed
          through underneath. Using a `View` with the surface color (instead of
          the previous BlurView) gives a clean, solid bar on all platforms and
          matches the rest of the app chrome. A hairline divider at the bottom
          hints that content scrolls beneath it. */}
      <View
        style={[
          styles.header,
          {
            paddingTop: insets.top + spacing.sm,
            backgroundColor: colors.surface,
            borderBottomWidth: StyleSheet.hairlineWidth,
            borderBottomColor: colors.divider,
          },
        ]}
      >
        {!selectionMode ? (
          <View style={styles.headerTopRow}>
            <Pressable
              testID={insideFolder ? 'header-back-btn' : 'open-drawer-btn'}
              onPress={
                insideFolder
                  ? goBack
                  : () => { haptic.selection(); setDrawerOpen((o) => !o); }
              }
              style={[styles.iconBtn, { backgroundColor: colors.surfaceSecondary }]}
            >
              <Ionicons name={insideFolder ? 'arrow-back' : 'menu'} size={22} color={colors.onSurface} />
            </Pressable>
            <Text style={[styles.bigTitle, { color: colors.onSurface }]} testID="home-title">
              {categoryLabel}
            </Text>
            <Pressable
              testID="sort-btn"
              onPress={() => setShowSortMenu(true)}
              style={[styles.iconBtn, { backgroundColor: colors.surfaceSecondary }]}
            >
              <Ionicons name="swap-vertical-outline" size={20} color={colors.onSurface} />
            </Pressable>
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
            {/* Tile-size cycle — long-press or repeated tap cycles S / M / L / XL.
                Also affects the folder-view grid. The value is persisted via
                useAppSettings so users only tweak it once. */}
            <Pressable
              testID="tile-size-btn"
              onPress={() => {
                haptic.selection();
                const steps = [0.75, 1.0, 1.25, 1.6];
                const idx = steps.findIndex((s) => Math.abs(s - tileScale) < 0.05);
                const next = steps[(idx + 1) % steps.length] ?? 1.0;
                updateSettings({ homeTileScale: next });
              }}
              onLongPress={() => {
                haptic.selection();
                updateSettings({ homeTileScale: 1.0 });
              }}
              delayLongPress={400}
              style={[styles.iconBtn, { backgroundColor: colors.surfaceSecondary }]}
            >
              <Ionicons name="expand-outline" size={20} color={colors.onSurface} />
            </Pressable>
            <Pressable
              testID="settings-btn"
              onPress={() => router.push('/settings')}
              style={[styles.iconBtn, { backgroundColor: colors.surfaceSecondary }]}
            >
              <Ionicons name="settings-outline" size={20} color={colors.onSurface} />
            </Pressable>
          </View>
        ) : (
          <>
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
            {/* Inline bulk actions row at the top. On small phones the row
                easily overflows because of the number of actions — horizontal
                ScrollView lets users swipe through them instead of visibly
                overlapping. Each button has a min-width so labels never
                clip mid-word. */}
            <ScrollView
              testID="bulk-action-bar"
              horizontal
              showsHorizontalScrollIndicator={false}
              // Layout props (flexDirection, alignItems) belong to the CONTENT
              // container in RN ScrollView; putting them on `style` throws
              // "ScrollView child layout must be applied through the
              // contentContainerStyle prop".
              contentContainerStyle={{
                flexDirection: 'row',
                alignItems: 'center',
                paddingHorizontal: 2,
              }}
              style={{
                backgroundColor: colors.surfaceSecondary,
                borderRadius: radius.md,
                marginBottom: spacing.sm,
              }}
            >
              {category !== 'trash' ? (
                <>
                  <TopBulkBtn icon="pin-outline" label="Pin" onPress={bulkPin} testID="bulk-pin" />
                  <TopBulkBtn icon="folder-outline" label="Move" onPress={() => setShowMovePicker(true)} testID="bulk-move" />
                  <TopBulkBtn
                    icon="pricetag-outline"
                    label="Label"
                    onPress={() => setShowLabelPicker(true)}
                    testID="bulk-label"
                  />
                  <TopBulkBtn icon="copy-outline" label="Duplicate" onPress={bulkDuplicate} testID="bulk-duplicate" />
                  {selectedIds.size === 1 && (
                    <TopBulkBtn
                      icon="information-circle-outline"
                      label="Info"
                      onPress={() => {
                        const id = Array.from(selectedIds)[0];
                        const n = notes.find((nn) => nn.id === id);
                        if (n) setInfoTarget({ kind: 'note', note: n });
                      }}
                      testID="bulk-info"
                    />
                  )}
                  <TopBulkBtn icon="trash-outline" label="Trash" onPress={bulkDelete} destructive testID="bulk-delete" />
                </>
              ) : (
                <>
                  <TopBulkBtn icon="refresh" label="Restore" onPress={bulkRestore} testID="bulk-restore" />
                  <TopBulkBtn
                    icon="trash-bin-outline"
                    label="Delete forever"
                    onPress={bulkDelete}
                    destructive
                    testID="bulk-delete-forever"
                  />
                </>
              )}
            </ScrollView>
          </>
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
      </View>

      {/* Pinch to zoom home tiles.
          RNGH's Pinch gesture reliably races with the FlatList's internal
          ScrollView on some Android builds and never activates. Using a
          PanResponder that manually tracks 2+ touch points bypasses that
          race entirely — we only claim the responder when the SECOND finger
          lands, so single-finger scroll on the FlatList underneath is
          unaffected. */}
      {(() => {
        const state = pinchStateRef.current;
        const pinchPan = PanResponder.create({
          // Only claim the responder when a second finger is on the screen.
          onStartShouldSetPanResponder: (e) =>
            (e.nativeEvent.touches?.length ?? 0) >= 2,
          onMoveShouldSetPanResponder: (e) =>
            (e.nativeEvent.touches?.length ?? 0) >= 2,
          // Don't block scroll from starting.
          onStartShouldSetPanResponderCapture: () => false,
          onMoveShouldSetPanResponderCapture: (e) =>
            (e.nativeEvent.touches?.length ?? 0) >= 2,
          onPanResponderGrant: (e) => {
            const t = e.nativeEvent.touches;
            if (t.length >= 2) {
              const dx = t[0].pageX - t[1].pageX;
              const dy = t[0].pageY - t[1].pageY;
              state.startDistance = Math.hypot(dx, dy);
              state.startScale = tileScale;
              state.active = true;
            }
          },
          onPanResponderMove: (e) => {
            const t = e.nativeEvent.touches;
            if (!state.active || t.length < 2) return;
            const dx = t[0].pageX - t[1].pageX;
            const dy = t[0].pageY - t[1].pageY;
            const dist = Math.hypot(dx, dy);
            if (state.startDistance < 1) return;
            const ratio = dist / state.startDistance;
            const next = Math.max(0.5, Math.min(2.0, state.startScale * ratio));
            if (Math.abs(next - tileScale) < 0.03) return;
            updateSettings({ homeTileScale: next });
          },
          onPanResponderRelease: () => { state.active = false; },
          onPanResponderTerminate: () => { state.active = false; },
        });
        return (
          <View style={{ flex: 1 }} {...pinchPan.panHandlers}>
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
              paddingTop: selectionMode ? 200 : (category === 'trash' && notes.length > 0 ? 230 : 180),
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
                {isEmpty && !selectionMode && !isFileManagerView && (
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
                {isFileManagerView && renderFileManager()}
                {!isFileManagerView && !!pinnedNotes.length && (
                  <>
                    <SectionLabel label="Pinned" color={colors.muted} />
                    <View style={styles.grid}>{pinnedNotes.map(renderNoteCard)}</View>
                  </>
                )}
                {!isFileManagerView && !!otherNotes.length && (
                  <>
                    {!!pinnedNotes.length && <SectionLabel label="Others" color={colors.muted} />}
                    <View style={styles.grid}>{otherNotes.map(renderNoteCard)}</View>
                  </>
                )}
              </View>
            }
          />
        </View>
        );
      })()}

      {/* FAB (hidden in selection / trash) */}
      {!selectionMode && category !== 'trash' && (
        <Pressable
          testID="fab-create-note"
          onPress={onFabPress}
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
      )}

      {/* Exit-hint toast pill — floats near the bottom on all platforms.
          Auto-hides after ~1.8s. Only visible after the first back press. */}
      {exitHintVisible && (
        <RNAnimated.View
          pointerEvents="none"
          style={[
            styles.exitHint,
            {
              bottom: insets.bottom + spacing.lg + 92,
              backgroundColor: isDark ? 'rgba(255,255,255,0.92)' : 'rgba(20,22,28,0.92)',
              opacity: exitHintFade,
              transform: [{
                translateY: exitHintFade.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }),
              }],
            },
          ]}
        >
          <Ionicons name="log-out-outline" size={14} color={isDark ? '#111' : '#fff'} />
          <Text style={{ color: isDark ? '#111' : '#fff', marginLeft: 6, fontWeight: '700', fontSize: typeScale.sm }}>
            Press back again to exit
          </Text>
        </RNAnimated.View>
      )}

      {/* Bulk action bar (moved to top header — see selection mode) */}

      {/* Left drawer (phone only — overlay modal). On Android with edge-to-edge
          display the Modal doesn't extend under the status / nav bars unless
          `statusBarTranslucent` is enabled. Without it the panel visibly stops
          short of the bottom on small phones (e.g. S25 Ultra).
          Swipe-to-close: users can flick the drawer LEFT anywhere on its body
          to dismiss it. Implemented with `PanResponder` (works reliably across
          RN Web / Android / iOS without fighting the drawer's inner scroll). */}
      {!isTablet && (() => {
        const drawerPan = PanResponder.create({
          // Only claim horizontal drags; vertical drags flow through to inner scroll.
          onStartShouldSetPanResponder: () => false,
          onMoveShouldSetPanResponder: (_e, g) =>
            Math.abs(g.dx) > 6 && Math.abs(g.dx) > Math.abs(g.dy) * 1.2,
          onPanResponderMove: () => { /* no-op; only care about release */ },
          onPanResponderRelease: (_e, g) => {
            // Fast left flick OR significant leftward drag → close the drawer.
            if (g.dx < -60 || g.vx < -0.4) setDrawerOpen(false);
          },
          onPanResponderTerminationRequest: () => true,
        });
        return (
          <Modal
            visible={drawerOpen}
            transparent
            animationType="fade"
            statusBarTranslucent
            onRequestClose={() => setDrawerOpen(false)}
          >
            <Pressable style={styles.drawerBackdrop} onPress={() => setDrawerOpen(false)}>
              <Pressable
                {...drawerPan.panHandlers}
                style={[
                  styles.drawerPanel,
                  {
                    backgroundColor: colors.surface,
                    paddingTop: insets.top + spacing.lg,
                    paddingBottom: insets.bottom + spacing.sm,
                  },
                ]}
                onPress={(e) => e.stopPropagation()}
              >
                {drawerInner}
              </Pressable>
            </Pressable>
          </Modal>
        );
      })()}

      {/* Template picker — anchored above the FAB */}
      <Modal visible={showTemplate} transparent animationType="fade" onRequestClose={() => setShowTemplate(false)}>
        <Pressable style={styles.backdrop} onPress={() => setShowTemplate(false)}>
          <Pressable
            onPress={(e) => e.stopPropagation()}
            style={[
              styles.tplPopup,
              {
                backgroundColor: colors.surface,
                right: spacing.lg,
                bottom: insets.bottom + spacing.lg + 70, // just above the FAB
              },
            ]}
          >
            {TEMPLATES.map((tpl) => (
              <Pressable
                key={tpl.key}
                testID={`tpl-${tpl.key}`}
                onPress={() => createFromTemplate(tpl)}
                style={({ pressed }) => [
                  styles.tplPopupRow,
                  { backgroundColor: pressed ? colors.surfaceTertiary : 'transparent' },
                ]}
              >
                <View style={[styles.tplIconSmall, { backgroundColor: colors.brandTertiary }]}>
                  <Ionicons name={tpl.icon} size={18} color={colors.brand} />
                </View>
                <Text style={{ color: colors.onSurface, fontSize: typeScale.base, fontWeight: '600', marginLeft: spacing.sm }}>
                  {tpl.label}
                </Text>
              </Pressable>
            ))}
          </Pressable>
        </Pressable>
      </Modal>

      {/* Info modal — metadata for a note or folder */}
      <Modal
        visible={!!infoTarget}
        transparent
        animationType="fade"
        onRequestClose={() => setInfoTarget(null)}
      >
        <Pressable style={styles.backdrop} onPress={() => setInfoTarget(null)}>
          <Pressable
            style={[styles.sheet, { backgroundColor: colors.surface, paddingBottom: insets.bottom + spacing.lg, maxHeight: '85%' }]}
            onPress={(e) => e.stopPropagation && e.stopPropagation()}
          >
            <View style={styles.sheetHandle} />
            {infoTarget?.kind === 'note' && (() => {
              const n = infoTarget.note;
              // Compute a rough size (bytes of the serialised payload — proxy for on-disk size).
              const payload = JSON.stringify({
                title: n.title,
                content: n.content,
                checklist: n.checklist,
                drawing_data: n.drawing_data,
                images: n.images?.length ?? 0,
              });
              // In React Native, Blob may not be available in Hermes — fall back to a
              // UTF-8 byte estimate. This isn't exact but is close enough for a proxy.
              const sizeBytes = (() => {
                try { return new (globalThis as any).Blob([payload]).size; } catch {}
                try { return new TextEncoder().encode(payload).length; } catch {}
                return payload.length;
              })();
              const sizeLabel = sizeBytes < 1024 ? `${sizeBytes} B` : sizeBytes < 1024 * 1024 ? `${(sizeBytes / 1024).toFixed(1)} KB` : `${(sizeBytes / 1024 / 1024).toFixed(2)} MB`;
              const chars = (n.content || '').length + (n.checklist || []).reduce((sum, ci) => sum + (ci.text || '').length, 0);
              const words = (n.content || '').split(/\s+/).filter(Boolean).length;
              const imgCount = n.images?.length ?? 0;
              // Count handwritten pages if present.
              let pageCount = 0;
              let strokeCount = 0;
              if (n.drawing_data) {
                try {
                  const doc = JSON.parse(n.drawing_data);
                  pageCount = doc.pageCount ?? 1;
                  strokeCount = Array.isArray(doc.items) ? doc.items.length : 0;
                } catch {}
              }
              const folderName = n.folder_id ? (folders.find((f) => f.id === n.folder_id)?.name ?? 'Unknown folder') : 'None';
              return (
                <>
                  <Text style={[styles.sheetTitle, { color: colors.onSurface }]}>Note info</Text>
                  <ScrollView contentContainerStyle={{ paddingBottom: spacing.lg }} showsVerticalScrollIndicator={false}>
                    <InfoRow label="Title" value={n.title || 'Untitled'} colors={colors} />
                    <InfoRow label="Type" value={n.note_type === 'handwriting' ? 'Handwritten' : 'Text'} colors={colors} />
                    <InfoRow label="Created" value={fmtDate(n.created_at)} colors={colors} />
                    <InfoRow label="Modified" value={fmtDate(n.updated_at)} colors={colors} />
                    <InfoRow label="Folder" value={folderName} colors={colors} />
                    {(() => {
                      const noteLabels = (n.label_ids || [])
                        .map((lid) => labels.find((ll) => ll.id === lid))
                        .filter(Boolean) as Label[];
                      return noteLabels.length > 0 ? (
                        <View
                          style={{
                            paddingVertical: 10,
                            borderBottomWidth: 1,
                            borderBottomColor: colors.divider,
                          }}
                        >
                          <Text style={{ color: colors.muted, fontSize: typeScale.sm, fontWeight: '600', marginBottom: 6 }}>Labels</Text>
                          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4 }}>
                            {noteLabels.map((l) => (
                              <View
                                key={l.id}
                                style={[styles.labelChip, { backgroundColor: withAlpha(l.color, 0.18), borderColor: l.color }]}
                              >
                                <View style={[styles.labelChipDot, { backgroundColor: l.color }]} />
                                <Text style={[styles.labelChipText, { color: l.color }]}>{l.name}</Text>
                              </View>
                            ))}
                          </View>
                        </View>
                      ) : null;
                    })()}
                    <InfoRow label="Size" value={sizeLabel} colors={colors} />
                    {n.note_type === 'handwriting' ? (
                      <>
                        <InfoRow label="Pages" value={String(pageCount)} colors={colors} />
                        <InfoRow label="Strokes / shapes" value={String(strokeCount)} colors={colors} />
                      </>
                    ) : (
                      <>
                        <InfoRow label="Characters" value={String(chars)} colors={colors} />
                        <InfoRow label="Words" value={String(words)} colors={colors} />
                        {imgCount > 0 && <InfoRow label="Images" value={String(imgCount)} colors={colors} />}
                        {(n.checklist?.length ?? 0) > 0 && (
                          <InfoRow label="Checklist items" value={`${n.checklist.filter((c) => c.done).length}/${n.checklist.length} done`} colors={colors} />
                        )}
                      </>
                    )}
                    <InfoRow label="Pinned" value={n.pinned ? 'Yes' : 'No'} colors={colors} />
                    <InfoRow label="Locked" value={n.locked ? 'Yes' : 'No'} colors={colors} />
                    {n.deleted_at ? <InfoRow label="Trashed" value={fmtDate(n.deleted_at)} colors={colors} /> : null}
                    <InfoRow label="ID" value={n.id} colors={colors} mono />
                  </ScrollView>
                </>
              );
            })()}
            {infoTarget?.kind === 'folder' && (() => {
              const f = infoTarget.folder;
              const notesInside = notes.filter((n) => n.folder_id === f.id).length;
              const subfolders = folders.filter((ff) => ff.parent_id === f.id).length;
              const parentName = f.parent_id ? (folders.find((ff) => ff.id === f.parent_id)?.name ?? 'Unknown') : 'None (root)';
              return (
                <>
                  <Text style={[styles.sheetTitle, { color: colors.onSurface }]}>Folder info</Text>
                  <ScrollView contentContainerStyle={{ paddingBottom: spacing.lg }} showsVerticalScrollIndicator={false}>
                    <InfoRow label="Name" value={f.name} colors={colors} />
                    <InfoRow
                      label="Color"
                      value={f.color}
                      colors={colors}
                      accessory={<View style={{ width: 16, height: 16, borderRadius: 8, backgroundColor: f.color, marginLeft: 8 }} />}
                    />
                    <InfoRow label="Created" value={fmtDate(f.created_at)} colors={colors} />
                    <InfoRow label="Parent" value={parentName} colors={colors} />
                    <InfoRow label="Notes inside" value={String(notesInside)} colors={colors} />
                    <InfoRow label="Sub-folders" value={String(subfolders)} colors={colors} />
                    <InfoRow label="ID" value={f.id} colors={colors} mono />
                  </ScrollView>
                </>
              );
            })()}
            <Pressable
              onPress={() => setInfoTarget(null)}
              style={{ paddingVertical: spacing.md, borderRadius: radius.sm, backgroundColor: colors.brand, alignItems: 'center', marginTop: spacing.sm }}
              testID="info-close-btn"
            >
              <Text style={{ color: colors.onBrandPrimary, fontWeight: '700' }}>Close</Text>
            </Pressable>
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

      {/* Handwriting prep popup */}
      <Modal visible={showHwPrep} transparent animationType="fade" onRequestClose={() => setShowHwPrep(false)}>
        <Pressable
          style={[styles.backdrop, { alignItems: 'center', justifyContent: 'center', padding: spacing.lg }]}
          onPress={() => setShowHwPrep(false)}
        >
          <Pressable
            onPress={(e) => e.stopPropagation()}
            style={{
              width: '100%',
              maxWidth: 560,
              maxHeight: '88%',
              backgroundColor: colors.surface,
              borderRadius: radius.lg,
              padding: spacing.lg,
              shadowColor: '#000',
              shadowOffset: { width: 0, height: 10 },
              shadowOpacity: 0.22,
              shadowRadius: 24,
              elevation: 16,
            }}
          >
            <Text style={[styles.sheetTitle, { color: colors.onSurface, textAlign: 'center', marginBottom: spacing.md }]} testID="hw-prep-title">
              Set up your page
            </Text>

            <ScrollView showsVerticalScrollIndicator={false}>
              {/* Title */}
              <Text style={{ color: colors.muted, fontSize: typeScale.sm, fontWeight: '700', marginBottom: spacing.sm, letterSpacing: 1.2 }}>
                NOTE NAME
              </Text>
              <TextInput
                testID="hw-title-input"
                value={hwTitle}
                onChangeText={setHwTitle}
                placeholder="Untitled handwritten note"
                placeholderTextColor={colors.muted}
                style={[styles.input, { color: colors.onSurface, backgroundColor: colors.surfaceSecondary }]}
              />

              {/* Folder + Orientation row */}
              <View style={{ flexDirection: 'row', gap: spacing.md, marginTop: spacing.lg }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: colors.muted, fontSize: typeScale.sm, fontWeight: '700', marginBottom: spacing.sm, letterSpacing: 1.2 }}>
                    SAVE IN
                  </Text>
                  <Pressable
                    testID="hw-folder-btn"
                    onPress={() => { haptic.selection(); setShowHwFolderPicker(true); }}
                    style={({ pressed }) => [
                      styles.input,
                      {
                        flexDirection: 'row',
                        alignItems: 'center',
                        backgroundColor: colors.surfaceSecondary,
                        opacity: pressed ? 0.8 : 1,
                      },
                    ]}
                  >
                    <Ionicons
                      name="folder-outline"
                      size={18}
                      color={
                        hwFolderId
                          ? folders.find((f) => f.id === hwFolderId)?.color || colors.brand
                          : colors.muted
                      }
                    />
                    <Text
                      numberOfLines={1}
                      style={{
                        marginLeft: spacing.sm,
                        color: colors.onSurface,
                        fontSize: typeScale.base,
                        fontWeight: '600',
                        flex: 1,
                      }}
                    >
                      {hwFolderId
                        ? folders.find((f) => f.id === hwFolderId)?.name || 'Folder'
                        : 'No folder'}
                    </Text>
                    <Ionicons name="chevron-down" size={16} color={colors.muted} />
                  </Pressable>
                </View>

                <View style={{ width: 130 }}>
                  <Text style={{ color: colors.muted, fontSize: typeScale.sm, fontWeight: '700', marginBottom: spacing.sm, letterSpacing: 1.2 }}>
                    ORIENTATION
                  </Text>
                  <View style={{ flexDirection: 'row', gap: 6 }}>
                    <Pressable
                      testID="hw-orient-portrait"
                      onPress={() => { haptic.selection(); setHwOrientation('portrait'); }}
                      style={{
                        flex: 1,
                        height: 48,
                        borderRadius: radius.md,
                        borderWidth: hwOrientation === 'portrait' ? 2 : 1,
                        borderColor: hwOrientation === 'portrait' ? colors.brand : colors.border,
                        backgroundColor: hwOrientation === 'portrait' ? colors.brandTertiary : colors.surfaceSecondary,
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <Ionicons
                        name="phone-portrait-outline"
                        size={22}
                        color={hwOrientation === 'portrait' ? colors.brand : colors.onSurface}
                      />
                    </Pressable>
                    <Pressable
                      testID="hw-orient-landscape"
                      onPress={() => { haptic.selection(); setHwOrientation('landscape'); }}
                      style={{
                        flex: 1,
                        height: 48,
                        borderRadius: radius.md,
                        borderWidth: hwOrientation === 'landscape' ? 2 : 1,
                        borderColor: hwOrientation === 'landscape' ? colors.brand : colors.border,
                        backgroundColor: hwOrientation === 'landscape' ? colors.brandTertiary : colors.surfaceSecondary,
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <Ionicons
                        name="phone-landscape-outline"
                        size={22}
                        color={hwOrientation === 'landscape' ? colors.brand : colors.onSurface}
                      />
                    </Pressable>
                  </View>
                </View>
              </View>

              <Text style={{ color: colors.muted, fontSize: typeScale.sm, fontWeight: '700', marginTop: spacing.lg, marginBottom: spacing.sm, letterSpacing: 1.2 }}>
                PAPER SIZE
              </Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: spacing.sm }}>
                {(['a4', 'a5', 'letter', 'index', 'custom'] as const).map((s) => {
                  const label =
                    s === 'a4' ? 'A4' :
                    s === 'a5' ? 'A5' :
                    s === 'letter' ? 'Letter' :
                    s === 'index' ? 'Index' : 'Custom';
                  const active = hwSize === s;
                  return (
                    <Pressable
                      key={s}
                      onPress={() => { haptic.selection(); setHwSize(s); }}
                      testID={`hw-size-${s}`}
                      style={{
                        paddingHorizontal: spacing.lg,
                        paddingVertical: spacing.sm,
                        borderRadius: radius.pill,
                        backgroundColor: active ? colors.brand : colors.surfaceSecondary,
                      }}
                    >
                      <Text style={{ color: active ? colors.onBrandPrimary : colors.onSurface, fontWeight: active ? '700' : '500' }}>
                        {label}
                      </Text>
                    </Pressable>
                  );
                })}
              </ScrollView>

              {hwSize === 'custom' && (
                <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md, alignItems: 'center' }}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: colors.muted, fontSize: typeScale.sm, marginBottom: 4 }}>Width (px)</Text>
                    <TextInput
                      testID="hw-custom-w"
                      value={hwCustomW}
                      onChangeText={(t) => setHwCustomW(t.replace(/[^0-9]/g, ''))}
                      keyboardType="number-pad"
                      placeholder="1024"
                      placeholderTextColor={colors.muted}
                      style={[styles.input, { color: colors.onSurface, backgroundColor: colors.surfaceSecondary }]}
                    />
                  </View>
                  <Text style={{ color: colors.muted, fontSize: typeScale.xl, marginTop: spacing.lg }}>×</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: colors.muted, fontSize: typeScale.sm, marginBottom: 4 }}>Height (px)</Text>
                    <TextInput
                      testID="hw-custom-h"
                      value={hwCustomH}
                      onChangeText={(t) => setHwCustomH(t.replace(/[^0-9]/g, ''))}
                      keyboardType="number-pad"
                      placeholder="1366"
                      placeholderTextColor={colors.muted}
                      style={[styles.input, { color: colors.onSurface, backgroundColor: colors.surfaceSecondary }]}
                    />
                  </View>
                </View>
              )}

              <Text style={{ color: colors.muted, fontSize: typeScale.sm, fontWeight: '700', marginTop: spacing.lg, marginBottom: spacing.sm, letterSpacing: 1.2 }}>
                TEMPLATE
              </Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ gap: spacing.md, paddingVertical: spacing.xs, paddingRight: spacing.md }}
              >
                {(['blank', 'ruled', 'narrow', 'grid', 'dotted', 'cornell', 'planner', 'todo'] as const).map((t) => {
                  const active = hwTemplate === t;
                  const previewW = hwOrientation === 'landscape' ? 130 : 80;
                  const previewH = hwOrientation === 'landscape' ? 80 : 104;
                  const previewColor = hwPaperColor;
                  // luminance-based line color so the preview matches the canvas behaviour
                  const lum = (() => {
                    const h = (hwPaperColor || '#FFFFFF').replace('#', '');
                    if (h.length < 6) return 1;
                    const r = parseInt(h.slice(0, 2), 16);
                    const g = parseInt(h.slice(2, 4), 16);
                    const b = parseInt(h.slice(4, 6), 16);
                    return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
                  })();
                  const previewLine = lum < 0.45 ? '#7a7a7e' : '#C9D2E0';
                  // Scale spacing down for tiny preview
                  const previewSpacing = hwSupportsSpacing(t)
                    ? Math.max(6, Math.round((hwLineSpacing / 32) * (t === 'narrow' ? 12 : 16)))
                    : undefined;
                  return (
                    <Pressable
                      key={t}
                      onPress={() => { haptic.selection(); setHwTemplate(t); }}
                      testID={`hw-template-${t}`}
                      style={{ alignItems: 'center' }}
                    >
                      <View
                        style={{
                          padding: 4,
                          borderRadius: radius.md,
                          backgroundColor: active ? colors.brandTertiary : 'transparent',
                          borderWidth: 2,
                          borderColor: active ? colors.brand : colors.border,
                        }}
                      >
                        <PaperPreview
                          type={t as PaperType}
                          width={previewW}
                          height={previewH}
                          color={previewColor}
                          lineColor={previewLine}
                          lineSpacing={previewSpacing}
                          borderRadius={6}
                        />
                      </View>
                      <Text
                        style={{
                          marginTop: 6,
                          color: active ? colors.brand : colors.onSurface,
                          fontWeight: active ? '700' : '500',
                          fontSize: typeScale.sm,
                        }}
                      >
                        {t[0].toUpperCase() + t.slice(1)}
                      </Text>
                    </Pressable>
                  );
                })}
              </ScrollView>

              <Text style={{ color: colors.muted, fontSize: typeScale.sm, fontWeight: '700', marginTop: spacing.lg, marginBottom: spacing.sm, letterSpacing: 1.2 }}>
                PAPER COLOR
              </Text>
              <View style={{ flexDirection: 'row', gap: spacing.md, alignItems: 'center' }}>
                {favoriteHwColors.map((hex, idx) => {
                  const active = hwPaperColor.toLowerCase() === hex.toLowerCase();
                  return (
                    <Pressable
                      key={`fav-${idx}`}
                      onPress={() => { haptic.selection(); setHwPaperColor(hex); }}
                      testID={`hw-color-fav-${idx}`}
                      style={{
                        width: 48,
                        height: 48,
                        borderRadius: 24,
                        backgroundColor: hex,
                        borderWidth: active ? 3 : 1,
                        borderColor: active ? colors.brand : colors.border,
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      {active && <Ionicons name="checkmark" size={20} color={colors.brand} />}
                    </Pressable>
                  );
                })}
                <Pressable
                  onPress={() => { haptic.selection(); setShowHwColorPicker(true); }}
                  testID="hw-color-more"
                  style={({ pressed }) => ({
                    width: 48,
                    height: 48,
                    borderRadius: 24,
                    backgroundColor: colors.surfaceSecondary,
                    borderWidth: 1,
                    borderColor: colors.border,
                    alignItems: 'center',
                    justifyContent: 'center',
                    opacity: pressed ? 0.7 : 1,
                  })}
                >
                  <Ionicons name="color-palette-outline" size={22} color={colors.brand} />
                </Pressable>
              </View>

              {hwSupportsSpacing(hwTemplate) && (
                <>
                  <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: spacing.lg, marginBottom: spacing.sm }}>
                    <Text style={{ flex: 1, color: colors.muted, fontSize: typeScale.sm, fontWeight: '700', letterSpacing: 1.2 }}>
                      LINE SPACING
                    </Text>
                    <Text style={{ color: colors.brand, fontWeight: '700', fontSize: typeScale.sm }}>
                      {hwLineSpacing}px
                    </Text>
                  </View>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
                    {[
                      { val: 16, label: 'Tight' },
                      { val: 22, label: 'Narrow' },
                      { val: 28, label: 'Normal' },
                      { val: 36, label: 'Wide' },
                      { val: 48, label: 'X-Wide' },
                    ].map((opt) => {
                      const active = hwLineSpacing === opt.val;
                      return (
                        <Pressable
                          key={opt.val}
                          onPress={() => { haptic.selection(); setHwLineSpacing(opt.val); }}
                          testID={`hw-spacing-${opt.val}`}
                          style={{
                            paddingHorizontal: spacing.md,
                            paddingVertical: spacing.sm,
                            borderRadius: radius.pill,
                            backgroundColor: active ? colors.brand : colors.surfaceSecondary,
                          }}
                        >
                          <Text style={{ color: active ? colors.onBrandPrimary : colors.onSurface, fontWeight: active ? '700' : '500', fontSize: typeScale.sm }}>
                            {opt.label} · {opt.val}px
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </>
              )}

              <View style={{ height: spacing.lg }} />
            </ScrollView>

            <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md }}>
              <Pressable
                onPress={() => setShowHwPrep(false)}
                testID="hw-cancel"
                style={[styles.btn, { flex: 1, backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1 }]}
              >
                <Text style={{ color: colors.onSurface }}>Cancel</Text>
              </Pressable>
              <Pressable
                testID="hw-create"
                onPress={startHandwriting}
                style={[styles.btn, { flex: 2, backgroundColor: colors.brand }]}
              >
                <Text style={{ color: colors.onBrandPrimary, fontWeight: '700' }}>Start writing</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* HW color picker — full palette + "Save as default" */}
      <Modal visible={showHwColorPicker} transparent animationType="fade" onRequestClose={() => setShowHwColorPicker(false)}>
        <Pressable
          style={[styles.backdrop, { alignItems: 'center', justifyContent: 'center', padding: spacing.lg }]}
          onPress={() => setShowHwColorPicker(false)}
        >
          <Pressable
            onPress={(e) => e.stopPropagation()}
            style={{
              width: '100%',
              maxWidth: 420,
              backgroundColor: colors.surface,
              borderRadius: radius.lg,
              padding: spacing.lg,
              shadowColor: '#000',
              shadowOffset: { width: 0, height: 10 },
              shadowOpacity: 0.22,
              shadowRadius: 24,
              elevation: 16,
            }}
          >
            <Text style={[styles.sheetTitle, { color: colors.onSurface, textAlign: 'center' }]}>
              Choose paper color
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, justifyContent: 'center', marginTop: spacing.sm }}>
              {HW_PAPER_COLORS.map((c) => {
                const active = hwPaperColor.toLowerCase() === c.hex.toLowerCase();
                return (
                  <Pressable
                    key={c.hex}
                    onPress={() => { haptic.selection(); setHwPaperColor(c.hex); }}
                    testID={`hw-color-picker-${c.label.toLowerCase()}`}
                    style={{ alignItems: 'center', width: 64 }}
                  >
                    <View
                      style={{
                        width: 48,
                        height: 48,
                        borderRadius: 24,
                        backgroundColor: c.hex,
                        borderWidth: active ? 3 : 1,
                        borderColor: active ? colors.brand : colors.border,
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      {active && <Ionicons name="checkmark" size={20} color={colors.brand} />}
                    </View>
                    <Text
                      numberOfLines={1}
                      style={{
                        marginTop: 4,
                        fontSize: typeScale.sm - 1,
                        color: active ? colors.brand : colors.muted,
                        fontWeight: active ? '700' : '500',
                      }}
                    >
                      {c.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            <View style={{ height: 1, backgroundColor: colors.divider, marginVertical: spacing.lg }} />
            <Text style={{ color: colors.muted, fontSize: typeScale.sm, fontWeight: '700', letterSpacing: 1.2, marginBottom: spacing.sm }}>
              SAVE AS DEFAULT
            </Text>
            <Text style={{ color: colors.muted, fontSize: typeScale.sm, marginBottom: spacing.sm }}>
              Tap a slot below to overwrite it with the current colour.
            </Text>
            <View style={{ flexDirection: 'row', gap: spacing.md, justifyContent: 'center' }}>
              {favoriteHwColors.map((hex, idx) => (
                <Pressable
                  key={`save-slot-${idx}`}
                  onPress={() => { haptic.success(); saveFavoriteHwColor(hwPaperColor, idx); }}
                  testID={`hw-color-save-slot-${idx}`}
                  style={({ pressed }) => ({
                    alignItems: 'center',
                    opacity: pressed ? 0.7 : 1,
                  })}
                >
                  <View
                    style={{
                      width: 56,
                      height: 56,
                      borderRadius: 28,
                      backgroundColor: hex,
                      borderWidth: 1,
                      borderColor: colors.border,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Ionicons name="bookmark" size={18} color={colors.brand} />
                  </View>
                  <Text style={{ marginTop: 4, fontSize: typeScale.sm, color: colors.muted, fontWeight: '600' }}>
                    Slot {idx + 1}
                  </Text>
                </Pressable>
              ))}
            </View>

            <Pressable
              onPress={() => setShowHwColorPicker(false)}
              testID="hw-color-picker-close"
              style={[styles.btn, { marginTop: spacing.lg, backgroundColor: colors.brand }]}
            >
              <Text style={{ color: colors.onBrandPrimary, fontWeight: '700' }}>Done</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      {/* HW folder picker */}
      <Modal visible={showHwFolderPicker} transparent animationType="fade" onRequestClose={() => setShowHwFolderPicker(false)}>
        <Pressable
          style={[styles.backdrop, { alignItems: 'center', justifyContent: 'center', padding: spacing.lg }]}
          onPress={() => setShowHwFolderPicker(false)}
        >
          <Pressable
            onPress={(e) => e.stopPropagation()}
            style={{
              width: '100%',
              maxWidth: 420,
              maxHeight: '80%',
              backgroundColor: colors.surface,
              borderRadius: radius.lg,
              padding: spacing.lg,
              shadowColor: '#000',
              shadowOffset: { width: 0, height: 10 },
              shadowOpacity: 0.22,
              shadowRadius: 24,
              elevation: 16,
            }}
          >
            <Text style={[styles.sheetTitle, { color: colors.onSurface, textAlign: 'center' }]}>
              Save in folder
            </Text>
            <ScrollView style={{ marginTop: spacing.sm }}>
              <Pressable
                onPress={() => { setHwFolderId(null); setShowHwFolderPicker(false); }}
                style={[styles.folderRow, { borderBottomColor: colors.divider }]}
                testID="hw-folder-none"
              >
                <View style={[styles.folderDot, { backgroundColor: colors.muted }]} />
                <Text style={{ color: colors.onSurface, fontSize: typeScale.lg, flex: 1 }}>No folder</Text>
                {hwFolderId === null && <Ionicons name="checkmark" size={18} color={colors.brand} />}
              </Pressable>
              {tree.map(({ folder: f, depth }) => (
                <Pressable
                  key={f.id}
                  onPress={() => { setHwFolderId(f.id); setShowHwFolderPicker(false); }}
                  style={[styles.folderRow, { borderBottomColor: colors.divider, paddingLeft: spacing.md + depth * 16 }]}
                  testID={`hw-folder-${f.id}`}
                >
                  <View style={[styles.folderDot, { backgroundColor: f.color }]} />
                  <Text style={{ color: colors.onSurface, fontSize: typeScale.lg, flex: 1 }}>{f.name}</Text>
                  {hwFolderId === f.id && <Ionicons name="checkmark" size={18} color={colors.brand} />}
                </Pressable>
              ))}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Sort menu */}
      <Modal visible={showSortMenu} transparent animationType="fade" onRequestClose={() => setShowSortMenu(false)}>
        <Pressable style={styles.backdrop} onPress={() => setShowSortMenu(false)}>
          <Pressable
            style={[
              styles.sheet,
              { backgroundColor: colors.surface, paddingBottom: insets.bottom + spacing.lg, maxWidth: 480, alignSelf: 'center', borderRadius: radius.lg, marginBottom: insets.bottom + 80 },
            ]}
          >
            <View style={styles.sheetHandle} />
            <Text style={[styles.sheetTitle, { color: colors.onSurface }]}>Sort by</Text>
            {([
              { id: 'updated', label: 'Recently updated' },
              { id: 'created', label: 'Newest first' },
              { id: 'title', label: 'Title (A → Z)' },
            ] as { id: SortBy; label: string }[]).map((o) => (
              <Pressable
                key={o.id}
                onPress={() => { setSortBy(o.id); setShowSortMenu(false); }}
                testID={`sort-${o.id}`}
                style={({ pressed }) => [
                  styles.tplRow,
                  { backgroundColor: pressed ? colors.surfaceTertiary : sortBy === o.id ? colors.brandTertiary : colors.surfaceSecondary },
                ]}
              >
                <Ionicons
                  name={sortBy === o.id ? 'radio-button-on' : 'radio-button-off'}
                  size={20}
                  color={sortBy === o.id ? colors.brand : colors.muted}
                />
                <Text style={{ color: colors.onSurface, fontSize: typeScale.lg, marginLeft: spacing.md, fontWeight: sortBy === o.id ? '700' : '500' }}>
                  {o.label}
                </Text>
              </Pressable>
            ))}
          </Pressable>
        </Pressable>
      </Modal>

      {/* Folder create / edit modal */}
      <FolderModal
        visible={!!folderModal}
        folder={folderModal?.folder}
        parentName={folderModal?.parentId ? folderById(folderModal.parentId)?.name : undefined}
        anchor={folderModal?.anchor}
        onCancel={() => setFolderModal(null)}
        onSave={saveFolderModal}
        onDelete={folderModal?.folder ? deleteFolderFromModal : undefined}
        onInfo={folderModal?.folder ? () => {
          const f = folderModal.folder!;
          setFolderModal(null);
          setInfoTarget({ kind: 'folder', folder: f });
        } : undefined}
      />

      {/* Label create / edit modal */}
      <LabelModal
        visible={!!labelModal}
        label={labelModal?.label}
        anchor={labelModal?.anchor}
        onCancel={() => setLabelModal(null)}
        onSave={saveLabelModal}
        onDelete={labelModal?.label ? deleteLabelFromModal : undefined}
      />

      {/* Bulk-assign labels to selected notes */}
      <Modal visible={showLabelPicker} transparent animationType="slide" onRequestClose={() => setShowLabelPicker(false)}>
        <Pressable style={styles.backdrop} onPress={() => setShowLabelPicker(false)}>
          <Pressable
            onPress={(e) => e.stopPropagation && e.stopPropagation()}
            style={[styles.sheet, { backgroundColor: colors.surface, paddingBottom: insets.bottom + spacing.lg, maxHeight: '70%' }]}
          >
            <View style={styles.sheetHandle} />
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: spacing.md }}>
              <Text style={[styles.sheetTitle, { color: colors.onSurface, marginBottom: 0, flex: 1 }]}>
                Apply labels
              </Text>
              <Pressable
                testID="label-picker-new"
                onPress={() => { setShowLabelPicker(false); setLabelModal({}); }}
                style={[styles.smallAddBtn, { backgroundColor: colors.brandTertiary }]}
              >
                <Ionicons name="add" size={16} color={colors.brand} />
                <Text style={{ color: colors.brand, fontWeight: '700', marginLeft: 4, fontSize: typeScale.sm }}>New</Text>
              </Pressable>
            </View>
            {labels.length === 0 ? (
              <Text style={{ color: colors.muted, textAlign: 'center', marginTop: spacing.lg }}>
                No labels yet. Tap &quot;New&quot; to create one.
              </Text>
            ) : (
              <ScrollView>
                {labels.map((l) => {
                  // A label is considered "on" only if every selected note has it.
                  const targets = notes.filter((n) => selectedIds.has(n.id));
                  const allHave = targets.length > 0 && targets.every((n) => (n.label_ids || []).includes(l.id));
                  const someHave = !allHave && targets.some((n) => (n.label_ids || []).includes(l.id));
                  return (
                    <Pressable
                      key={l.id}
                      testID={`label-picker-${l.id}`}
                      onPress={() => bulkToggleLabel(l.id)}
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
                          borderColor: allHave ? colors.brand : colors.divider,
                          backgroundColor: allHave ? colors.brand : 'transparent',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        {allHave && <Ionicons name="checkmark" size={14} color={colors.onBrandPrimary} />}
                        {someHave && (
                          <View
                            style={{
                              width: 10,
                              height: 2,
                              backgroundColor: colors.brand,
                              borderRadius: 1,
                            }}
                          />
                        )}
                      </View>
                    </Pressable>
                  );
                })}
              </ScrollView>
            )}
            <Pressable
              onPress={() => setShowLabelPicker(false)}
              style={{ marginTop: spacing.sm, paddingVertical: spacing.md, borderRadius: radius.sm, backgroundColor: colors.brand, alignItems: 'center' }}
              testID="label-picker-done"
            >
              <Text style={{ color: colors.onBrandPrimary, fontWeight: '700' }}>Done</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
      </View>
    </View>
  );
}

/**
 * Convert an anchor rectangle (in window coordinates) into `{ left, top }`
 * absolute-positioning values for an anchored popover of the given size.
 *
 * Rules:
 *  - Prefer opening BELOW the anchor with its LEFT edge aligned to the anchor's
 *    left ("justified" — same UX as tool popovers in the handwriting toolbar).
 *  - If the popover would spill off the right edge, shift it left so it fits.
 *  - If the popover is too tall to fit below, flip and open ABOVE the anchor.
 *  - The result is clamped to the window with an 8 px margin so the popover
 *    never touches the screen edges.
 */
function anchoredPosition(
  anchor: { x: number; y: number; w: number; h: number },
  popW: number,
  popH: number,
  winW: number,
  winH: number,
  margin = 8,
  gap = 6
): { left: number; top: number } {
  let left = anchor.x;
  const maxLeft = winW - popW - margin;
  if (left > maxLeft) left = maxLeft;
  if (left < margin) left = margin;

  let top = anchor.y + anchor.h + gap; // below anchor
  if (top + popH + margin > winH) {
    // Flip above the anchor if there isn't enough room below.
    const flippedTop = anchor.y - popH - gap;
    if (flippedTop >= margin) top = flippedTop;
    else top = Math.max(margin, winH - popH - margin);
  }
  return { left, top };
}

function FolderModal({
  visible,
  folder,
  parentName,
  anchor,
  onCancel,
  onSave,
  onDelete,
  onInfo,
}: {
  visible: boolean;
  folder?: Folder;
  parentName?: string;
  anchor?: { x: number; y: number; w: number; h: number } | null;
  onCancel: () => void;
  onSave: (name: string, color: string) => void;
  onDelete?: () => void;
  onInfo?: () => void;
}) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { width: winW, height: winH } = useWindowDimensions();
  const wide = winW >= 720;
  const [name, setName] = useState('');
  const [color, setColor] = useState(folderColors[0]);

  useEffect(() => {
    if (visible) {
      setName(folder?.name || '');
      setColor(folder?.color || folderColors[0]);
    }
  }, [visible, folder]);

  // If an anchor is supplied, prefer an anchored popover (matches the tool-
  // popover UX from the handwriting toolbar). Otherwise fall back to the
  // tablet-centred popup or the phone bottom-sheet.
  const POP_W = 320;
  const POP_H_APPROX = 360;
  const anchoredPos = anchor
    ? anchoredPosition(anchor, POP_W, POP_H_APPROX, winW, winH)
    : null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType={anchoredPos ? 'fade' : (wide ? 'fade' : 'slide')}
      onRequestClose={onCancel}
    >
      <Pressable style={styles.backdrop} onPress={onCancel}>
        <Pressable
          onPress={(e) => e.stopPropagation && e.stopPropagation()}
          style={
            anchoredPos
              ? [
                  styles.folderPopup,
                  {
                    backgroundColor: colors.surface,
                    top: anchoredPos.top,
                    left: anchoredPos.left,
                    width: POP_W,
                  },
                ]
              : wide
              ? [
                  styles.folderPopup,
                  {
                    backgroundColor: colors.surface,
                    top: insets.top + spacing.xxl + 60,
                    left: spacing.lg,
                  },
                ]
              : [styles.sheet, { backgroundColor: colors.surface, paddingBottom: insets.bottom + spacing.lg }]
          }
        >
          {!anchoredPos && !wide && <View style={styles.sheetHandle} />}
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
            {folder && onInfo && (
              <Pressable
                testID="folder-info"
                onPress={onInfo}
                style={[styles.btn, { borderColor: colors.brand, borderWidth: 1, paddingHorizontal: spacing.md }]}
              >
                <Ionicons name="information-circle-outline" size={20} color={colors.brand} />
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

function LabelModal({
  visible,
  label,
  anchor,
  onCancel,
  onSave,
  onDelete,
}: {
  visible: boolean;
  label?: Label;
  anchor?: { x: number; y: number; w: number; h: number } | null;
  onCancel: () => void;
  onSave: (name: string, color: string) => void;
  onDelete?: () => void;
}) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { width: winW, height: winH } = useWindowDimensions();
  const wide = winW >= 720;
  const [name, setName] = useState('');
  const [color, setColor] = useState(labelColors[0]);

  useEffect(() => {
    if (visible) {
      setName(label?.name || '');
      setColor(label?.color || labelColors[0]);
    }
  }, [visible, label]);

  const POP_W = 320;
  const POP_H_APPROX = 300;
  const anchoredPos = anchor
    ? anchoredPosition(anchor, POP_W, POP_H_APPROX, winW, winH)
    : null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType={anchoredPos ? 'fade' : (wide ? 'fade' : 'slide')}
      onRequestClose={onCancel}
    >
      <Pressable style={styles.backdrop} onPress={onCancel}>
        <Pressable
          onPress={(e) => e.stopPropagation && e.stopPropagation()}
          style={
            anchoredPos
              ? [
                  styles.folderPopup,
                  {
                    backgroundColor: colors.surface,
                    top: anchoredPos.top,
                    left: anchoredPos.left,
                    width: POP_W,
                  },
                ]
              : wide
              ? [
                  styles.folderPopup,
                  {
                    backgroundColor: colors.surface,
                    top: insets.top + spacing.xxl + 60,
                    left: spacing.lg,
                  },
                ]
              : [styles.sheet, { backgroundColor: colors.surface, paddingBottom: insets.bottom + spacing.lg }]
          }
        >
          {!anchoredPos && !wide && <View style={styles.sheetHandle} />}
          <Text style={{ fontSize: typeScale.xl, fontWeight: '700', color: colors.onSurface, marginBottom: spacing.md }}>
            {label ? 'Edit label' : 'New label'}
          </Text>
          <TextInput
            testID="label-name-input"
            value={name}
            onChangeText={setName}
            placeholder="Label name"
            placeholderTextColor={colors.muted}
            style={[styles.input, { color: colors.onSurface, backgroundColor: colors.surfaceSecondary }]}
            autoFocus
            maxLength={40}
          />
          <Text style={{ color: colors.muted, marginTop: spacing.lg, marginBottom: spacing.sm }}>Color</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
            {labelColors.map((c) => (
              <Pressable
                key={c}
                testID={`label-color-${c}`}
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
            {label && onDelete && (
              <Pressable
                testID="label-delete"
                onPress={onDelete}
                style={[styles.btn, { borderColor: colors.error, borderWidth: 1 }]}
              >
                <Text style={{ color: colors.error, fontWeight: '700' }}>Delete</Text>
              </Pressable>
            )}
            <Pressable
              testID="label-cancel"
              onPress={onCancel}
              style={[styles.btn, { borderColor: colors.divider, borderWidth: 1 }]}
            >
              <Text style={{ color: colors.onSurface, fontWeight: '700' }}>Cancel</Text>
            </Pressable>
            <Pressable
              testID="label-save"
              onPress={() => onSave(name, color)}
              style={[styles.btn, { flex: 1, backgroundColor: colors.brand }]}
            >
              <Text style={{ color: colors.onBrandPrimary, fontWeight: '700' }}>
                {label ? 'Save' : 'Create'}
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

function TopBulkBtn({
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
  const c = destructive ? colors.error : colors.brand;
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      style={({ pressed }) => ({
        // Fixed min-width so labels never mid-word wrap. Sits inside a
        // horizontal ScrollView which lets extras stay reachable on small
        // phones instead of visibly overlapping.
        minWidth: 76,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: spacing.sm,
        paddingHorizontal: spacing.sm,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Ionicons name={icon} size={18} color={c} />
      <Text numberOfLines={1} style={{ marginLeft: 6, fontSize: typeScale.sm, color: c, fontWeight: '700' }}>{label}</Text>
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
  folderTile: {
    height: 130,
    padding: spacing.lg,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
  },
  topActionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radius.md,
    padding: 2,
    marginBottom: spacing.sm,
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
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-start',
    gap: spacing.md,
  },
  breadcrumbRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.md,
    paddingHorizontal: spacing.xs,
  },
  breadcrumbChip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.pill,
    gap: 4,
  },
  breadcrumbText: {
    fontSize: typeScale.sm,
    fontWeight: '600',
  },
  card: { padding: spacing.lg, borderRadius: radius.lg, marginBottom: spacing.md, minHeight: 120 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.xs },
  cardDate: { fontSize: typeScale.sm },
  cardTitle: { fontSize: typeScale.lg, fontWeight: '700', marginBottom: spacing.xs },
  cardPreview: { fontSize: typeScale.base, lineHeight: 18 },
  cardMeta: { flexDirection: 'row', alignItems: 'center', marginTop: spacing.sm, gap: 4 },
  cardMetaText: { fontSize: typeScale.sm },
  labelChipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: spacing.sm,
    gap: 4,
    alignItems: 'center',
  },
  labelChip: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radius.pill,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 2,
    maxWidth: '100%',
  },
  labelChipDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginRight: 4,
  },
  labelChipText: {
    fontSize: typeScale.sm,
    fontWeight: '700',
    maxWidth: 100,
  },
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
  exitHint: {
    position: 'absolute',
    alignSelf: 'center',
    left: 0,
    right: 0,
    marginHorizontal: 'auto' as any,
    flexDirection: 'row',
    alignItems: 'center',
    alignContent: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: radius.pill,
    // Constrained width so the pill sizes to its content while staying centered.
    maxWidth: 260,
    minWidth: 200,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.22,
    shadowRadius: 10,
    elevation: 10,
  },
  bulkBar: {
    position: 'absolute',
    left: 0, right: 0, bottom: 56,
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: spacing.xs,
  },
  folderPopup: {
    position: 'absolute',
    width: 320,
    padding: spacing.lg,
    borderRadius: radius.lg,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.18,
    shadowRadius: 16,
    elevation: 12,
  },
  drawerBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', flexDirection: 'row' },
  drawerPanel: {
    width: '82%',
    maxWidth: 340,
    // In a row-flex backdrop the default cross-axis behaviour is `stretch`, so
    // `alignSelf: stretch` guarantees the panel fills the parent's height even
    // on Android edge-to-edge phones where `height: '100%'` sometimes falls
    // short of the nav bar.
    alignSelf: 'stretch',
    paddingHorizontal: spacing.lg,
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
  tplPopup: {
    position: 'absolute',
    width: 240,
    padding: spacing.sm,
    paddingTop: spacing.md,
    borderRadius: radius.lg,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.18,
    shadowRadius: 16,
    elevation: 12,
  },
  tplPopupCentered: {
    width: '100%',
    maxWidth: 380,
    padding: spacing.lg,
    borderRadius: radius.lg,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.22,
    shadowRadius: 24,
    elevation: 16,
  },
  tplPopupRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.md,
  },
  tplIconSmall: {
    width: 32, height: 32, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center',
  },
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

// ---------- Info modal helpers ----------

/** Format an ISO-ish date string for the info modal ("Jun 12, 2026, 3:04 PM"). */
function fmtDate(iso?: string | null): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return d.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return String(iso);
  }
}

interface InfoRowProps {
  label: string;
  value: string;
  colors: any;
  mono?: boolean;
  accessory?: React.ReactNode;
}
function InfoRow({ label, value, colors, mono, accessory }: InfoRowProps) {
  return (
    <View
      style={{
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingVertical: 10,
        borderBottomWidth: 1,
        borderBottomColor: colors.divider,
      }}
    >
      <Text style={{ color: colors.muted, fontSize: typeScale.sm, fontWeight: '600' }}>{label}</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', flexShrink: 1, marginLeft: spacing.md }}>
        <Text
          numberOfLines={mono ? 1 : 2}
          ellipsizeMode={mono ? 'middle' : 'tail'}
          style={{
            color: colors.onSurface,
            fontSize: typeScale.sm,
            fontWeight: '600',
            textAlign: 'right',
            fontFamily: mono ? (Platform.OS === 'ios' ? 'Menlo' : 'monospace') : undefined,
          }}
        >
          {value}
        </Text>
        {accessory}
      </View>
    </View>
  );
}
