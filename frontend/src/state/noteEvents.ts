/**
 * In-process notifications between screens about a note changing elsewhere.
 *
 * Renaming a note from its tab updates the database, but the editor that has
 * that note open holds its own copy in state and would keep showing the old
 * title. Screens subscribe here to pick up the change.
 */

type RenameListener = (noteId: string, title: string) => void;

const renameListeners = new Set<RenameListener>();

export function onNoteRenamed(listener: RenameListener): () => void {
  renameListeners.add(listener);
  return () => renameListeners.delete(listener);
}

export function emitNoteRenamed(noteId: string, title: string): void {
  renameListeners.forEach((l) => l(noteId, title));
}
