/**
 * How a note is named and dated in lists, tabs and info sheets.
 *
 * Most notes are never given a title, and a grid where half the tiles say
 * "Untitled note" gives no way to tell them apart. A note without a title is
 * named by its first line of text; a handwritten page with no text is named by
 * the day it was started. The stored title is never changed by this.
 */

interface Nameable {
  title?: string | null;
  content?: string | null;
  checklist?: { text: string }[] | null;
  note_type?: string | null;
  created_at?: string | null;
}

const LIST_MARKER = /^\s*(?:•|-|\*|\d+\.)\s+/;

export function displayTitle(n: Nameable): string {
  const t = (n.title || '').trim();
  if (t) return t;
  const line = (n.content || '')
    .split('\n')
    .map((l) => l.replace(LIST_MARKER, '').trim())
    .find((l) => l.length > 0);
  if (line) return line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line;
  const item = (n.checklist || []).map((c) => c.text.trim()).find(Boolean);
  if (item) return item;
  if (n.note_type === 'handwriting') {
    const d = n.created_at ? new Date(n.created_at) : null;
    if (d && !isNaN(d.getTime())) {
      return `Page · ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
    }
    return 'Handwritten page';
  }
  return 'Untitled note';
}

/** "Just now", "5 min ago", "2:14 PM", "Yesterday", "Tuesday", "Mar 3", "Mar 3, 2025". */
export function relativeDate(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const diffMs = now.getTime() - d.getTime();
  if (diffMs >= 0 && diffMs < 60_000) return 'Just now';
  if (diffMs >= 0 && diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)} min ago`;
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (days === 0) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (days === 1) return 'Yesterday';
  if (days > 1 && days < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
