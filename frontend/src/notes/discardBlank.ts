/**
 * Blank notes are not kept (as in Samsung Notes).
 *
 * Every "new note" button creates the row straight away so the editor has
 * something to save into. If the person leaves without putting anything in it,
 * that row is deleted for good when the editor closes, instead of piling up as
 * "Handwritten note 10/14" cards with nothing on them.
 */
import { DeviceEventEmitter } from 'react-native';
import { Note, NotesApi } from '../api/client';
import { closeTabEverywhere } from '../state/useOpenTabs';

/** Emitted with the note id after a blank note is discarded. */
export const NOTE_DISCARDED_EVENT = 'geodesic:note-discarded';

/**
 * True when the note holds nothing the person made or chose to keep.
 * Anything marked deliberately (favourite, label, lock) is never blank, and a
 * drawing document that can't be read is treated as content, never as blank.
 */
export function isBlankNote(n: Pick<Note, 'note_type' | 'title' | 'content' | 'checklist' | 'images' | 'drawings' | 'drawing_data' | 'favorite' | 'locked' | 'label_ids'> & { deleted_at?: string | null }): boolean {
  if (n.deleted_at) return false;
  if (n.favorite || n.locked) return false;
  if ((n.label_ids?.length ?? 0) > 0) return false;
  if ((n.title ?? '').trim()) return false;
  if ((n.content ?? '').replace(/<[^>]*>/g, '').trim()) return false;
  if ((n.checklist?.length ?? 0) > 0) return false;
  if ((n.images?.length ?? 0) > 0 || (n.drawings?.length ?? 0) > 0) return false;
  if (n.note_type !== 'handwriting') return true;
  if (!n.drawing_data) return true;
  try {
    const doc = JSON.parse(n.drawing_data);
    const items: unknown[] = Array.isArray(doc?.items) ? doc.items : [];
    // Imported PDF pages are page numbers, and page 0 is a real page.
    const backgrounds: unknown[] = Array.isArray(doc?.pageBackgrounds)
      ? doc.pageBackgrounds.filter((b: unknown) => b !== null && b !== undefined)
      : [];
    return items.length === 0 && backgrounds.length === 0;
  } catch {
    return false;
  }
}

/**
 * Re-read the note from the database (after the editor's last save) and delete
 * it permanently if it is blank. Returns true if it was discarded.
 */
export async function discardIfBlank(id: string): Promise<boolean> {
  try {
    const note = await NotesApi.get(id);
    if (!isBlankNote(note)) return false;
    await NotesApi.remove(id, true);
    await closeTabEverywhere(id);
    DeviceEventEmitter.emit(NOTE_DISCARDED_EVENT, id);
    return true;
  } catch {
    // Already gone, or the database is busy: keeping a blank note is harmless.
    return false;
  }
}
