/**
 * Data layer.
 *
 * Same exported surface as the old HTTP client — `NotesApi.list()`,
 * `NotesApi.update()` and friends still take and return the same shapes — but
 * every call now reads and writes a local SQLite database instead of a server.
 * The screens did not need to change: they already awaited these functions and
 * never cared what was behind them.
 *
 * Everything is still `async`. It would be simpler to make these synchronous,
 * but keeping the promises means the calling code, the save queue and the error
 * handling all stay exactly as they were, and adding sync later would not mean
 * rewriting every screen again.
 */

import * as Crypto from 'expo-crypto';

import { getDb, likePattern, nowIso } from '@/src/db';

export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
}

/** The shape the notes list returns: no blobs, so cards stay cheap to load. */
export interface NoteSummary {
  id: string;
  title: string;
  content: string;
  checklist: ChecklistItem[];
  preview: string | null;
  note_type: 'text' | 'handwriting';
  folder_id: string | null;
  label_ids: string[];
  color: string | null;
  pinned: boolean;
  locked: boolean;
  has_drawing: boolean;
  image_count: number;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
  version: number;
}

/** The full record, loaded one note at a time. */
export interface Note extends Omit<NoteSummary, 'has_drawing' | 'image_count'> {
  images: string[];
  drawings: string[];
  drawing_data?: string | null;
}

export interface Folder {
  id: string;
  name: string;
  color: string;
  parent_id: string | null;
  created_at: string;
}

export interface Label {
  id: string;
  name: string;
  color: string;
  created_at: string;
}

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
}

/**
 * A failed operation.
 *
 * Kept from the HTTP client so call sites that branch on `isNotFound` or render
 * `userMessage` keep working. The network-specific cases can no longer happen
 * locally, but `isNetwork` stays defined rather than forcing every consumer to
 * be edited.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly detail: string;

  constructor(status: number, detail: string) {
    super(detail || `Operation failed (${status})`);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
  }

  get isNetwork(): boolean {
    return false;
  }
  get isConflict(): boolean {
    return this.status === 409;
  }
  get isNotFound(): boolean {
    return this.status === 404;
  }
  get isRetryable(): boolean {
    return this.status >= 500;
  }

  get userMessage(): string {
    if (this.isNotFound) return 'That note no longer exists.';
    if (this.status >= 500) return "Couldn't read the notes database.";
    return this.detail || 'Something went wrong.';
  }
}

const uuid = (): string => Crypto.randomUUID();

/** Wrap raw SQLite failures so callers see one error type. */
async function guard<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiError) throw err;
    console.warn(`[db] ${what} failed`, err);
    throw new ApiError(500, `Could not ${what}.`);
  }
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    // A corrupt cell should not take down the whole list.
    return fallback;
  }
}

interface NoteRow {
  id: string;
  title: string;
  content: string;
  checklist: string;
  images: string;
  drawings: string;
  drawing_data: string | null;
  preview: string | null;
  note_type: string;
  folder_id: string | null;
  label_ids: string;
  color: string | null;
  pinned: number;
  locked: number;
  image_count: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  version: number;
}

function toSummary(row: NoteRow): NoteSummary {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    checklist: parseJson<ChecklistItem[]>(row.checklist, []),
    preview: row.preview,
    note_type: (row.note_type as 'text' | 'handwriting') ?? 'text',
    folder_id: row.folder_id,
    label_ids: parseJson<string[]>(row.label_ids, []),
    color: row.color,
    pinned: !!row.pinned,
    locked: !!row.locked,
    has_drawing: !!row.preview || row.note_type === 'handwriting',
    image_count: row.image_count ?? 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
    deleted_at: row.deleted_at,
    version: row.version,
  };
}

function toNote(row: NoteRow): Note {
  const summary = toSummary(row);
  const { has_drawing: _h, image_count: _c, ...rest } = summary;
  return {
    ...rest,
    images: parseJson<string[]>(row.images, []),
    drawings: parseJson<string[]>(row.drawings, []),
    drawing_data: row.drawing_data,
  };
}

/** Columns the list reads. Deliberately excludes every blob column. */
const SUMMARY_COLUMNS = `
  id, title, content, checklist, preview, note_type, folder_id, label_ids,
  color, pinned, locked, image_count, created_at, updated_at, deleted_at, version,
  '[]' AS images, '[]' AS drawings, NULL AS drawing_data
`;

export type NoteStatus = 'active' | 'trash';

export interface ListOpts {
  q?: string;
  folderId?: string | null;
  labelId?: string | null;
  status?: NoteStatus;
  pinned?: boolean;
  limit?: number;
  offset?: number;
}

function buildWhere(opts: ListOpts): { sql: string; args: (string | number)[] } {
  const clauses: string[] = [];
  const args: (string | number)[] = [];

  clauses.push(opts.status === 'trash' ? 'deleted_at IS NOT NULL' : 'deleted_at IS NULL');

  if (opts.folderId) {
    clauses.push('folder_id = ?');
    args.push(opts.folderId);
  }
  if (opts.labelId) {
    // label_ids is a JSON array of ids; match the quoted id so "ab" cannot
    // match inside "abc".
    clauses.push('label_ids LIKE ?');
    args.push(`%"${opts.labelId}"%`);
  }
  if (typeof opts.pinned === 'boolean') {
    clauses.push('pinned = ?');
    args.push(opts.pinned ? 1 : 0);
  }
  if (opts.q && opts.q.trim()) {
    // ESCAPE matters: without it, searching for "100%" matches every note.
    clauses.push(
      "(title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\' OR checklist LIKE ? ESCAPE '\\')"
    );
    const pattern = likePattern(opts.q);
    args.push(pattern, pattern, pattern);
  }

  return { sql: clauses.join(' AND '), args };
}

/**
 * Fields a caller may write, and how each maps to a column.
 *
 * An explicit allow-list rather than iterating the patch object, so a stray key
 * can never be interpolated into SQL.
 */
const WRITABLE: Record<string, (v: unknown) => string | number | null> = {
  title: (v) => String(v ?? ''),
  content: (v) => String(v ?? ''),
  checklist: (v) => JSON.stringify(v ?? []),
  images: (v) => JSON.stringify(v ?? []),
  drawings: (v) => JSON.stringify(v ?? []),
  drawing_data: (v) => (v == null ? null : String(v)),
  preview: (v) => (v == null ? null : String(v)),
  note_type: (v) => (v === 'handwriting' ? 'handwriting' : 'text'),
  folder_id: (v) => (v == null ? null : String(v)),
  label_ids: (v) => JSON.stringify(v ?? []),
  color: (v) => (v == null ? null : String(v)),
  pinned: (v) => (v ? 1 : 0),
  locked: (v) => (v ? 1 : 0),
};

export const NotesApi = {
  async page(opts: ListOpts = {}): Promise<Page<NoteSummary>> {
    return guard('load notes', async () => {
      const db = await getDb();
      const { sql, args } = buildWhere(opts);
      const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
      const offset = Math.max(opts.offset ?? 0, 0);

      const countRow = await db.getFirstAsync<{ n: number }>(
        `SELECT COUNT(*) AS n FROM notes WHERE ${sql}`,
        args
      );
      const total = countRow?.n ?? 0;

      const rows = await db.getAllAsync<NoteRow>(
        `SELECT ${SUMMARY_COLUMNS} FROM notes WHERE ${sql}
         ORDER BY pinned DESC, updated_at DESC
         LIMIT ? OFFSET ?`,
        [...args, limit, offset]
      );

      return {
        items: rows.map(toSummary),
        total,
        limit,
        offset,
        has_more: offset + rows.length < total,
      };
    });
  },

  async list(opts: ListOpts = {}): Promise<NoteSummary[]> {
    return (await NotesApi.page(opts)).items;
  },

  async get(id: string): Promise<Note> {
    return guard('open that note', async () => {
      const db = await getDb();
      const row = await db.getFirstAsync<NoteRow>('SELECT * FROM notes WHERE id = ?', [id]);
      if (!row) throw new ApiError(404, 'Note not found');
      return toNote(row);
    });
  },

  async getDrawing(id: string): Promise<{ drawing_data: string | null; version: number }> {
    return guard('load that drawing', async () => {
      const db = await getDb();
      const row = await db.getFirstAsync<{ drawing_data: string | null; version: number }>(
        'SELECT drawing_data, version FROM notes WHERE id = ?',
        [id]
      );
      if (!row) throw new ApiError(404, 'Note not found');
      return { drawing_data: row.drawing_data, version: row.version };
    });
  },

  async create(data: Partial<Note> = {}): Promise<Note> {
    return guard('create that note', async () => {
      const db = await getDb();
      const id = data.id ?? uuid();
      const stamp = nowIso();
      const images = data.images ?? [];

      await db.runAsync(
        `INSERT INTO notes (
           id, title, content, checklist, images, drawings, drawing_data, preview,
           note_type, folder_id, label_ids, color, pinned, locked, image_count,
           created_at, updated_at, deleted_at, version
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,1)`,
        [
          id,
          data.title ?? '',
          data.content ?? '',
          JSON.stringify(data.checklist ?? []),
          JSON.stringify(images),
          JSON.stringify(data.drawings ?? []),
          data.drawing_data ?? null,
          data.preview ?? null,
          data.note_type === 'handwriting' ? 'handwriting' : 'text',
          data.folder_id ?? null,
          JSON.stringify(data.label_ids ?? []),
          data.color ?? null,
          data.pinned ? 1 : 0,
          data.locked ? 1 : 0,
          images.length,
          stamp,
          stamp,
        ]
      );
      return NotesApi.get(id);
    });
  },

  /**
   * Patch a note. Only the keys present are written, and an explicit `null`
   * clears the column — which is how "move this note out of its folder" is
   * expressed. `baseVersion` is accepted for compatibility and ignored: with a
   * single local database there is nothing to conflict with.
   */
  async update(id: string, data: Partial<Note>, _baseVersion?: number): Promise<Note> {
    return guard('save that note', async () => {
      const db = await getDb();
      const sets: string[] = [];
      const args: (string | number | null)[] = [];

      for (const [key, value] of Object.entries(data)) {
        const encode = WRITABLE[key];
        if (!encode) continue;
        sets.push(`${key} = ?`);
        args.push(encode(value));
      }

      if ('images' in data) {
        sets.push('image_count = ?');
        args.push((data.images ?? []).length);
      }

      if (sets.length === 0) return NotesApi.get(id);

      sets.push('updated_at = ?');
      args.push(nowIso());
      args.push(id);

      const result = await db.runAsync(
        `UPDATE notes SET ${sets.join(', ')}, version = version + 1 WHERE id = ?`,
        args
      );
      if (result.changes === 0) throw new ApiError(404, 'Note not found');
      return NotesApi.get(id);
    });
  },

  /**
   * Idempotent. Soft-delete twice and the note stays in the trash; only an
   * explicit `permanent` destroys it, so a repeated tap can never escalate from
   * "trashed" to "gone".
   */
  async remove(
    id: string,
    permanent = false
  ): Promise<{ ok: boolean; permanent: boolean; already_trashed?: boolean }> {
    return guard('delete that note', async () => {
      const db = await getDb();
      const row = await db.getFirstAsync<{ deleted_at: string | null }>(
        'SELECT deleted_at FROM notes WHERE id = ?',
        [id]
      );
      if (!row) throw new ApiError(404, 'Note not found');

      if (permanent) {
        await db.runAsync('DELETE FROM notes WHERE id = ?', [id]);
        return { ok: true, permanent: true };
      }
      if (row.deleted_at) return { ok: true, permanent: false, already_trashed: true };

      const stamp = nowIso();
      await db.runAsync(
        'UPDATE notes SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?',
        [stamp, stamp, id]
      );
      return { ok: true, permanent: false };
    });
  },

  async restore(id: string): Promise<Note> {
    return guard('restore that note', async () => {
      const db = await getDb();
      const row = await db.getFirstAsync<{ deleted_at: string | null }>(
        'SELECT deleted_at FROM notes WHERE id = ?',
        [id]
      );
      if (!row) throw new ApiError(404, 'Note not found');
      if (!row.deleted_at) throw new ApiError(409, 'That note is not in the trash');

      await db.runAsync(
        'UPDATE notes SET deleted_at = NULL, updated_at = ?, version = version + 1 WHERE id = ?',
        [nowIso(), id]
      );
      return NotesApi.get(id);
    });
  },

  async emptyTrash(): Promise<{ ok: boolean; deleted: number }> {
    return guard('empty the trash', async () => {
      const db = await getDb();
      const result = await db.runAsync('DELETE FROM notes WHERE deleted_at IS NOT NULL');
      return { ok: true, deleted: result.changes };
    });
  },

  /**
   * Purge notes trashed longer ago than `days`. The server did this on a timer;
   * with no server it runs at startup instead.
   */
  async purgeExpiredTrash(days = 30): Promise<number> {
    return guard('tidy the trash', async () => {
      const db = await getDb();
      const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
      const result = await db.runAsync(
        'DELETE FROM notes WHERE deleted_at IS NOT NULL AND deleted_at < ?',
        [cutoff]
      );
      return result.changes;
    });
  },
};

export const FoldersApi = {
  async list(): Promise<Folder[]> {
    return guard('load folders', async () => {
      const db = await getDb();
      return db.getAllAsync<Folder>('SELECT * FROM folders ORDER BY created_at ASC');
    });
  },

  async create(data: { name: string; color?: string; parent_id?: string | null }): Promise<Folder> {
    return guard('create that folder', async () => {
      const name = (data.name ?? '').trim();
      if (!name) throw new ApiError(400, 'Give the folder a name');
      const db = await getDb();
      const id = uuid();
      await db.runAsync(
        'INSERT INTO folders (id, name, color, parent_id, created_at) VALUES (?,?,?,?,?)',
        [id, name.slice(0, 120), data.color ?? '#7B8C73', data.parent_id ?? null, nowIso()]
      );
      const row = await db.getFirstAsync<Folder>('SELECT * FROM folders WHERE id = ?', [id]);
      return row!;
    });
  },

  async update(id: string, data: Partial<Folder>): Promise<Folder> {
    return guard('rename that folder', async () => {
      const db = await getDb();
      const sets: string[] = [];
      const args: (string | null)[] = [];

      if ('name' in data) {
        const name = (data.name ?? '').trim();
        if (!name) throw new ApiError(400, 'Give the folder a name');
        sets.push('name = ?');
        args.push(name.slice(0, 120));
      }
      if ('color' in data) {
        sets.push('color = ?');
        args.push(data.color ?? '#7B8C73');
      }
      if ('parent_id' in data) {
        if (data.parent_id === id) throw new ApiError(400, 'A folder cannot be inside itself');
        sets.push('parent_id = ?');
        args.push(data.parent_id ?? null);
      }

      if (sets.length) {
        args.push(id);
        const result = await db.runAsync(
          `UPDATE folders SET ${sets.join(', ')} WHERE id = ?`,
          args
        );
        if (result.changes === 0) throw new ApiError(404, 'Folder not found');
      }
      const row = await db.getFirstAsync<Folder>('SELECT * FROM folders WHERE id = ?', [id]);
      if (!row) throw new ApiError(404, 'Folder not found');
      return row;
    });
  },

  async remove(id: string): Promise<{ ok: boolean }> {
    return guard('delete that folder', async () => {
      const db = await getDb();
      const result = await db.runAsync('DELETE FROM folders WHERE id = ?', [id]);
      if (result.changes === 0) throw new ApiError(404, 'Folder not found');
      // Notes outlive their folder: move them to the root rather than deleting.
      await db.runAsync('UPDATE notes SET folder_id = NULL WHERE folder_id = ?', [id]);
      await db.runAsync('UPDATE folders SET parent_id = NULL WHERE parent_id = ?', [id]);
      return { ok: true };
    });
  },
};

export const LabelsApi = {
  async list(): Promise<Label[]> {
    return guard('load labels', async () => {
      const db = await getDb();
      return db.getAllAsync<Label>('SELECT * FROM labels ORDER BY created_at ASC');
    });
  },

  /** Creating a label that already exists returns the existing one. */
  async create(data: { name: string; color?: string }): Promise<Label> {
    return guard('create that label', async () => {
      const name = (data.name ?? '').trim();
      if (!name) throw new ApiError(400, 'Give the label a name');
      const db = await getDb();

      const existing = await db.getFirstAsync<Label>(
        'SELECT * FROM labels WHERE name = ? COLLATE NOCASE',
        [name]
      );
      if (existing) return existing;

      const id = uuid();
      await db.runAsync('INSERT INTO labels (id, name, color, created_at) VALUES (?,?,?,?)', [
        id,
        name.slice(0, 60),
        data.color ?? '#7B8C73',
        nowIso(),
      ]);
      const row = await db.getFirstAsync<Label>('SELECT * FROM labels WHERE id = ?', [id]);
      return row!;
    });
  },

  async update(id: string, data: Partial<Label>): Promise<Label> {
    return guard('rename that label', async () => {
      const db = await getDb();
      const sets: string[] = [];
      const args: (string | null)[] = [];

      if ('name' in data) {
        const name = (data.name ?? '').trim();
        if (!name) throw new ApiError(400, 'Give the label a name');
        sets.push('name = ?');
        args.push(name.slice(0, 60));
      }
      if ('color' in data) {
        sets.push('color = ?');
        args.push(data.color ?? '#7B8C73');
      }

      if (sets.length) {
        args.push(id);
        const result = await db.runAsync(`UPDATE labels SET ${sets.join(', ')} WHERE id = ?`, args);
        if (result.changes === 0) throw new ApiError(404, 'Label not found');
      }
      const row = await db.getFirstAsync<Label>('SELECT * FROM labels WHERE id = ?', [id]);
      if (!row) throw new ApiError(404, 'Label not found');
      return row;
    });
  },

  async remove(id: string): Promise<{ ok: boolean }> {
    return guard('delete that label', async () => {
      const db = await getDb();
      const result = await db.runAsync('DELETE FROM labels WHERE id = ?', [id]);
      if (result.changes === 0) throw new ApiError(404, 'Label not found');

      // Strip the id out of every note that carried it.
      const rows = await db.getAllAsync<{ id: string; label_ids: string }>(
        'SELECT id, label_ids FROM notes WHERE label_ids LIKE ?',
        [`%"${id}"%`]
      );
      for (const row of rows) {
        const next = parseJson<string[]>(row.label_ids, []).filter((x) => x !== id);
        await db.runAsync('UPDATE notes SET label_ids = ? WHERE id = ?', [
          JSON.stringify(next),
          row.id,
        ]);
      }
      return { ok: true };
    });
  },
};
