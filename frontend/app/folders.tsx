import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  TextInput,
  ActivityIndicator,
  Modal,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

import { useTheme } from '@/src/theme/ThemeContext';
import { spacing, radius, typeScale, folderColors } from '@/src/theme/tokens';
import { FoldersApi, Folder } from '@/src/api/client';

export default function FoldersScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [folders, setFolders] = useState<Folder[]>([]);
  const [loading, setLoading] = useState(true);

  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState('');
  const [color, setColor] = useState(folderColors[0]);
  const [editing, setEditing] = useState<Folder | null>(null);

  const load = useCallback(async () => {
    try {
      setFolders(await FoldersApi.list());
    } catch (e) {
      console.warn(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const openAdd = () => {
    setEditing(null);
    setName('');
    setColor(folderColors[0]);
    setShowAdd(true);
  };

  const openEdit = (f: Folder) => {
    setEditing(f);
    setName(f.name);
    setColor(f.color);
    setShowAdd(true);
  };

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      if (editing) {
        await FoldersApi.update(editing.id, { name: trimmed, color });
      } else {
        await FoldersApi.create({ name: trimmed, color });
      }
      setShowAdd(false);
      load();
    } catch (e) {
      console.warn(e);
    }
  };

  const remove = async (f: Folder) => {
    try {
      await FoldersApi.remove(f.id);
      load();
    } catch (e) {
      console.warn(e);
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.surface }]}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <Pressable onPress={() => router.back()} testID="folders-back" style={styles.iconBtn}>
          <Ionicons name="chevron-back" size={26} color={colors.onSurface} />
        </Pressable>
        <Text style={[styles.title, { color: colors.onSurface }]}>Folders</Text>
        <Pressable onPress={openAdd} testID="folders-add" style={styles.iconBtn}>
          <Ionicons name="add" size={26} color={colors.brand} />
        </Pressable>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.brand} />
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: insets.bottom + 80 }}>
          {folders.length === 0 && (
            <View style={[styles.empty, { backgroundColor: colors.surfaceSecondary }]}>
              <Ionicons name="folder-open-outline" size={48} color={colors.brand} />
              <Text style={{ color: colors.onSurface, fontSize: typeScale.lg, marginTop: spacing.md, fontWeight: '600' }}>
                No folders yet
              </Text>
              <Text style={{ color: colors.muted, marginTop: 6, textAlign: 'center' }}>
                Tap + to create a folder and organize your notes.
              </Text>
            </View>
          )}
          {folders.map((f) => (
            <View
              key={f.id}
              style={[styles.row, { backgroundColor: colors.surfaceSecondary }]}
              testID={`folder-row-${f.id}`}
            >
              <View style={[styles.dot, { backgroundColor: f.color }]} />
              <Text style={[styles.rowName, { color: colors.onSurface }]} numberOfLines={1}>
                {f.name}
              </Text>
              <Pressable onPress={() => openEdit(f)} style={styles.smallBtn} testID={`folder-edit-${f.id}`}>
                <Ionicons name="create-outline" size={20} color={colors.onSurface} />
              </Pressable>
              <Pressable onPress={() => remove(f)} style={styles.smallBtn} testID={`folder-del-${f.id}`}>
                <Ionicons name="trash-outline" size={20} color={colors.error} />
              </Pressable>
            </View>
          ))}
        </ScrollView>
      )}

      <Modal visible={showAdd} transparent animationType="slide" onRequestClose={() => setShowAdd(false)}>
        <Pressable style={styles.backdrop} onPress={() => setShowAdd(false)}>
          <Pressable style={[styles.sheet, { backgroundColor: colors.surface, paddingBottom: insets.bottom + spacing.lg }]}>
            <Text style={{ fontSize: typeScale.xl, fontWeight: '700', color: colors.onSurface, marginBottom: spacing.lg }}>
              {editing ? 'Edit folder' : 'New folder'}
            </Text>
            <TextInput
              testID="folder-name-input"
              value={name}
              onChangeText={setName}
              placeholder="Folder name"
              placeholderTextColor={colors.muted}
              style={[
                styles.input,
                { color: colors.onSurface, backgroundColor: colors.surfaceSecondary },
              ]}
              autoFocus
            />
            <Text style={{ color: colors.muted, marginTop: spacing.lg, marginBottom: spacing.sm }}>Color</Text>
            <View style={styles.colorRow}>
              {folderColors.map((c) => (
                <Pressable
                  key={c}
                  testID={`folder-color-${c}`}
                  onPress={() => setColor(c)}
                  style={[
                    styles.colorDot,
                    {
                      backgroundColor: c,
                      borderColor: color === c ? colors.onSurface : 'transparent',
                    },
                  ]}
                />
              ))}
            </View>
            <Pressable
              testID="folder-save"
              onPress={save}
              style={[styles.saveBtn, { backgroundColor: colors.brand }]}
            >
              <Text style={{ color: colors.onBrandPrimary, fontWeight: '700', fontSize: typeScale.lg }}>
                {editing ? 'Save' : 'Create'}
              </Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
  },
  iconBtn: { padding: spacing.sm, minWidth: 40, alignItems: 'center' },
  title: { flex: 1, textAlign: 'center', fontSize: typeScale.xl, fontWeight: '700' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  empty: { alignItems: 'center', padding: spacing.xxl, borderRadius: radius.lg, marginTop: spacing.xl },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.md,
    borderRadius: radius.md,
    marginBottom: spacing.sm,
  },
  dot: { width: 14, height: 14, borderRadius: 7, marginRight: spacing.md },
  rowName: { flex: 1, fontSize: typeScale.lg, fontWeight: '600' },
  smallBtn: { padding: spacing.sm },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.3)' },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    padding: spacing.lg,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
  },
  input: {
    height: 48,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    fontSize: typeScale.lg,
  },
  colorRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  colorDot: { width: 36, height: 36, borderRadius: 18, borderWidth: 3 },
  saveBtn: {
    marginTop: spacing.xl,
    height: 50,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
