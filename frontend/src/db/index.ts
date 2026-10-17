/**
 * On-device database.
 *
 * Notes used to live in MongoDB behind an HTTP API, which meant the app showed
 * nothing without a server on the same network. Everything is local now: no
 * server, no LAN address, no network permission needed for storage.
 *
 * Schema notes:
 *  - `id` is a text UUID, matching what the old API issued, so any exported
 *    data still round-trips.
 *  - List-heavy columns (`deleted_at`, `pinned`, `updated_at`, `folder_id`) are
 *    indexed together in the order the notes list actually queries them.
 *  - Blob-ish columns (`drawing_data`, `images`, `drawings`) are never selected
 *    by the list query. A page of handwriting is megabytes; loading twenty of
 *    them to draw twenty cards is what made the old list slow.
 *  - `version` is kept but not enforced. With one device there is nothing to
 *    conflict with, and keeping the column means adding sync later is not a
 *    migration.
 */

import * as SQLite from 'expo-sqlite';

const DB_NAME = 'geodesic.db';

/** Bump when the schema changes and add a matching block in `migrate`. */
const SCHEMA_VERSION = 3;

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

async function migrate(db: SQLite.SQLiteDatabase): Promise<void> {
  // WAL keeps reads from blocking on a write, which matters because the drawing
  // screen saves while the notes list may still be rendering behind it.
  await db.execAsync('PRAGMA journal_mode = WAL;');
  await db.execAsync('PRAGMA foreign_keys = ON;');

  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version;');
  const current = row?.user_version ?? 0;
  if (current >= SCHEMA_VERSION) return;

  if (current < 1) {
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS notes (
        id           TEXT PRIMARY KEY NOT NULL,
        title        TEXT    NOT NULL DEFAULT '',
        content      TEXT    NOT NULL DEFAULT '',
        checklist    TEXT    NOT NULL DEFAULT '[]',
        images       TEXT    NOT NULL DEFAULT '[]',
        drawings     TEXT    NOT NULL DEFAULT '[]',
        drawing_data TEXT,
        preview      TEXT,
        note_type    TEXT    NOT NULL DEFAULT 'text',
        folder_id    TEXT,
        label_ids    TEXT    NOT NULL DEFAULT '[]',
        color        TEXT,
        pinned       INTEGER NOT NULL DEFAULT 0,
        locked       INTEGER NOT NULL DEFAULT 0,
        image_count  INTEGER NOT NULL DEFAULT 0,
        created_at   TEXT    NOT NULL,
        updated_at   TEXT    NOT NULL,
        deleted_at   TEXT,
        version      INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS folders (
        id         TEXT PRIMARY KEY NOT NULL,
        name       TEXT NOT NULL,
        color      TEXT NOT NULL DEFAULT '#7B8C73',
        parent_id  TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS labels (
        id         TEXT PRIMARY KEY NOT NULL,
        name       TEXT NOT NULL,
        color      TEXT NOT NULL DEFAULT '#7B8C73',
        created_at TEXT NOT NULL
      );

      -- Matches the default list query: not deleted, pinned first, newest first.
      CREATE INDEX IF NOT EXISTS idx_notes_list
        ON notes (deleted_at, pinned DESC, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_notes_folder
        ON notes (deleted_at, folder_id, updated_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_labels_name
        ON labels (name COLLATE NOCASE);
    `);
  }

  if (current < 2) {
    // Favourites. Separate from `pinned`: pinning controls ordering within the
    // current list, favouriting is a cross-cutting collection.
    //
    // Deliberately NOT also declared in the v1 CREATE TABLE above. A fresh
    // database starts at user_version 0 and runs every block in order, so a
    // column declared in both places makes this ALTER fail with "duplicate
    // column name" — which aborts migrate(), leaves the database unopened, and
    // makes every single query fail. Each column belongs to exactly one step.
    await db.execAsync(`
      ALTER TABLE notes ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX IF NOT EXISTS idx_notes_favorite
        ON notes (deleted_at, favorite, updated_at DESC);
    `);
  }

  if (current < 3) {
    // Pinned and Favorites were two stars for the same idea, with two drawer
    // rows, two bulk actions and two sections. They are one now: Favorites.
    // Anything pinned becomes a favourite, so nothing the user marked is lost.
    // The column stays (old backups and future sync still carry it); the app
    // just no longer sets it.
    await db.execAsync(`
      UPDATE notes SET favorite = 1 WHERE pinned = 1;
      UPDATE notes SET pinned = 0 WHERE pinned = 1;
    `);
  }

  await db.execAsync(`PRAGMA user_version = ${SCHEMA_VERSION};`);
}

/** Opens (and migrates) the database once; later calls reuse the connection. */
export function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = await SQLite.openDatabaseAsync(DB_NAME);
      await migrate(db);
      return db;
    })().catch((err) => {
      // Don't cache a failed open, or every later call inherits the failure.
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}

/**
 * Escape the wildcards in a LIKE pattern.
 *
 * The old server built a Mongo `$regex` from raw user input, so searching for
 * `(` was a 500 and `a{99999}` was a denial of service. The SQLite equivalent
 * is `%` and `_`: without escaping, searching for `100%` matches everything.
 */
export function likePattern(term: string): string {
  return `%${term.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export const nowIso = (): string => new Date().toISOString();

/** Delete everything. Used by the "reset" action in settings. */
export async function wipeDatabase(): Promise<void> {
  const db = await getDb();
  await db.execAsync('DELETE FROM notes; DELETE FROM folders; DELETE FROM labels;');
}
