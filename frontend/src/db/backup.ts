/**
 * Backup and restore.
 *
 * Everything lives in one SQLite file in app-private storage, so uninstalling
 * the app deletes every note with no way back. A backup is a single JSON file
 * the user saves wherever they like (Downloads, a USB stick, a cloud folder),
 * independent of the app.
 *
 * Restore MERGES, it never wipes:
 *  - a note that isn't in the database is added;
 *  - a note that is keeps whichever copy was edited more recently, so
 *    restoring an old backup can't roll back newer work;
 *  - folders are matched by id;
 *  - labels are matched by id, then by name, because label names are unique in
 *    the database and a backup from another install will have different ids
 *    for the same label. Notes are re-pointed at the label that already exists.
 */

import { getDb } from '@/src/db';

export const BACKUP_FORMAT = 'geodesic-notes-backup';
export const BACKUP_VERSION = 1;

/** Columns copied verbatim. Listed explicitly so a stray key can never reach SQL. */
const NOTE_COLUMNS = [
  'id', 'title', 'content', 'checklist', 'images', 'drawings', 'drawing_data',
  'preview', 'note_type', 'folder_id', 'label_ids', 'color', 'pinned', 'favorite',
  'locked', 'image_count', 'created_at', 'updated_at', 'deleted_at', 'version',
] as const;
const FOLDER_COLUMNS = ['id', 'name', 'color', 'parent_id', 'created_at'] as const;

/**
 * Values for NOT NULL columns a backup might lack (an older backup, or a hand-
 * edited one). Inserting NULL there would fail, and inside the transaction one
 * bad row would abort the entire restore.
 */
const NOTE_DEFAULTS: Row = {
  title: '', content: '', checklist: '[]', images: '[]', drawings: '[]',
  note_type: 'text', label_ids: '[]', pinned: 0, favorite: 0, locked: 0,
  image_count: 0, version: 1,
};
const LABEL_COLUMNS = ['id', 'name', 'color', 'created_at'] as const;

type Row = Record<string, unknown>;

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  version: number;
  exportedAt: string;
  counts: { notes: number; folders: number; labels: number };
  notes: Row[];
  folders: Row[];
  labels: Row[];
}

export interface RestoreSummary {
  notesAdded: number;
  notesUpdated: number;
  notesSkipped: number;
  foldersAdded: number;
  labelsAdded: number;
  labelsMerged: number;
}

/** Everything, including notes in the trash: a backup that drops them isn't one. */
export async function buildBackup(): Promise<BackupFile> {
  const db = await getDb();
  const [notes, folders, labels] = await Promise.all([
    db.getAllAsync<Row>(`SELECT ${NOTE_COLUMNS.join(', ')} FROM notes`),
    db.getAllAsync<Row>(`SELECT ${FOLDER_COLUMNS.join(', ')} FROM folders`),
    db.getAllAsync<Row>(`SELECT ${LABEL_COLUMNS.join(', ')} FROM labels`),
  ]);
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    counts: { notes: notes.length, folders: folders.length, labels: labels.length },
    notes,
    folders,
    labels,
  };
}

/** A filename that sorts by date and never collides within a day of exports. */
export function backupFileName(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `geodesic-notes-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}.json`;
}

/** Throws a readable error if `raw` isn't a backup this version understands. */
export function parseBackup(raw: string): BackupFile {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("That file isn't a Geodesic Notes backup (it isn't valid JSON).");
  }
  const b = data as Partial<BackupFile>;
  if (!b || b.format !== BACKUP_FORMAT) {
    throw new Error("That file isn't a Geodesic Notes backup.");
  }
  if (typeof b.version !== 'number' || b.version > BACKUP_VERSION) {
    throw new Error('This backup was made by a newer version of the app. Update the app, then restore.');
  }
  if (!Array.isArray(b.notes) || !Array.isArray(b.folders) || !Array.isArray(b.labels)) {
    throw new Error('This backup file is incomplete or damaged.');
  }
  return b as BackupFile;
}

/** Drop null/undefined so defaults fill them; nullable columns simply stay NULL. */
function stripNulls(r: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(r)) if (v !== null && v !== undefined) out[k] = v;
  return out;
}

function pick(row: Row, cols: readonly string[]): unknown[] {
  return cols.map((c) => {
    const v = row[c];
    if (v === undefined) return null;
    // Booleans from older exports become SQLite integers.
    if (typeof v === 'boolean') return v ? 1 : 0;
    // Arrays/objects (never stored that way, but tolerate hand-edited files).
    if (v !== null && typeof v === 'object') return JSON.stringify(v);
    return v as string | number | null;
  });
}

export async function restoreBackup(backup: BackupFile): Promise<RestoreSummary> {
  const db = await getDb();
  const summary: RestoreSummary = {
    notesAdded: 0, notesUpdated: 0, notesSkipped: 0,
    foldersAdded: 0, labelsAdded: 0, labelsMerged: 0,
  };

  // One transaction: a restore that fails halfway changes nothing.
  await db.execAsync('BEGIN');
  try {
    // ---- labels: match by id, then by name ----
    const labelIdMap = new Map<string, string>();
    for (const l of backup.labels) {
      const id = String(l.id ?? '');
      const name = String(l.name ?? '').trim();
      if (!id || !name) continue;
      const byId = await db.getFirstAsync<{ id: string }>('SELECT id FROM labels WHERE id = ?', [id]);
      if (byId) { labelIdMap.set(id, id); continue; }
      const byName = await db.getFirstAsync<{ id: string }>(
        'SELECT id FROM labels WHERE name = ? COLLATE NOCASE', [name]
      );
      if (byName) {
        labelIdMap.set(id, byName.id);
        summary.labelsMerged++;
        continue;
      }
      await db.runAsync(
        `INSERT INTO labels (${LABEL_COLUMNS.join(', ')}) VALUES (${LABEL_COLUMNS.map(() => '?').join(', ')})`,
        pick({ ...l, created_at: l.created_at ?? new Date().toISOString() }, LABEL_COLUMNS) as any[]
      );
      labelIdMap.set(id, id);
      summary.labelsAdded++;
    }

    // ---- folders: match by id ----
    for (const f of backup.folders) {
      const id = String(f.id ?? '');
      if (!id || !String(f.name ?? '').trim()) continue;
      const exists = await db.getFirstAsync<{ id: string }>('SELECT id FROM folders WHERE id = ?', [id]);
      if (exists) continue;
      await db.runAsync(
        `INSERT INTO folders (${FOLDER_COLUMNS.join(', ')}) VALUES (${FOLDER_COLUMNS.map(() => '?').join(', ')})`,
        pick({ ...f, color: f.color ?? '#7B8C73', created_at: f.created_at ?? new Date().toISOString() }, FOLDER_COLUMNS) as any[]
      );
      summary.foldersAdded++;
    }

    // ---- notes: add, or keep the newer copy ----
    for (const n of backup.notes) {
      const id = String(n.id ?? '');
      if (!id || !n.created_at || !n.updated_at) { summary.notesSkipped++; continue; }

      // Re-point label ids at the labels that actually exist now.
      let labelIds: string[] = [];
      try {
        const raw = typeof n.label_ids === 'string' ? JSON.parse(n.label_ids) : n.label_ids;
        if (Array.isArray(raw)) labelIds = raw.map(String);
      } catch {}
      const remapped = Array.from(new Set(labelIds.map((x) => labelIdMap.get(x) ?? x)));
      const row: Row = { ...NOTE_DEFAULTS, ...stripNulls(n), label_ids: JSON.stringify(remapped) };
      // Backups from before Pinned was folded into Favorites.
      if (row.pinned === 1 || row.pinned === true) { row.favorite = 1; row.pinned = 0; }

      const existing = await db.getFirstAsync<{ updated_at: string }>(
        'SELECT updated_at FROM notes WHERE id = ?', [id]
      );
      if (!existing) {
        await db.runAsync(
          `INSERT INTO notes (${NOTE_COLUMNS.join(', ')}) VALUES (${NOTE_COLUMNS.map(() => '?').join(', ')})`,
          pick(row, NOTE_COLUMNS) as any[]
        );
        summary.notesAdded++;
      } else if (String(n.updated_at) > existing.updated_at) {
        const cols = NOTE_COLUMNS.filter((c) => c !== 'id');
        await db.runAsync(
          `UPDATE notes SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
          [...pick(row, cols), id] as any[]
        );
        summary.notesUpdated++;
      } else {
        // The copy on the device is the same or newer; leave it alone.
        summary.notesSkipped++;
      }
    }

    await db.execAsync('COMMIT');
  } catch (e) {
    await db.execAsync('ROLLBACK').catch(() => {});
    throw e;
  }
  return summary;
}
