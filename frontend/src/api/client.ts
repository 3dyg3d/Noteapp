const BASE = (process.env.EXPO_PUBLIC_BACKEND_URL || '').replace(/\/$/, '');

export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
}

export interface Note {
  id: string;
  title: string;
  content: string;
  checklist: ChecklistItem[];
  images: string[];
  drawings: string[];
  drawing_data?: string | null;
  note_type?: 'text' | 'handwriting';
  folder_id: string | null;
  label_ids?: string[];
  color: string | null;
  pinned: boolean;
  locked: boolean;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
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

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export type NoteStatus = 'active' | 'trash';

export const NotesApi = {
  list: (opts: { q?: string; folderId?: string | null; labelId?: string | null; status?: NoteStatus; pinned?: boolean } = {}) => {
    const params = new URLSearchParams();
    if (opts.q) params.set('q', opts.q);
    if (opts.folderId) params.set('folder_id', opts.folderId);
    if (opts.labelId) params.set('label_id', opts.labelId);
    if (opts.status) params.set('status', opts.status);
    if (typeof opts.pinned === 'boolean') params.set('pinned', String(opts.pinned));
    const qs = params.toString();
    return http<Note[]>(`/notes${qs ? `?${qs}` : ''}`);
  },
  get: (id: string) => http<Note>(`/notes/${id}`),
  create: (data: Partial<Note>) =>
    http<Note>('/notes', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: string, data: Partial<Note>) =>
    http<Note>(`/notes/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  remove: (id: string, permanent = false) =>
    http<{ ok: boolean }>(`/notes/${id}${permanent ? '?permanent=true' : ''}`, { method: 'DELETE' }),
  restore: (id: string) =>
    http<Note>(`/notes/${id}/restore`, { method: 'POST' }),
  emptyTrash: () =>
    http<{ ok: boolean; deleted: number }>('/notes/trash/empty', { method: 'POST' }),
};

export const FoldersApi = {
  list: () => http<Folder[]>('/folders'),
  create: (data: { name: string; color: string; parent_id?: string | null }) =>
    http<Folder>('/folders', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: string, data: Partial<Folder>) =>
    http<Folder>(`/folders/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  remove: (id: string) => http<{ ok: boolean }>(`/folders/${id}`, { method: 'DELETE' }),
};

export const LabelsApi = {
  list: () => http<Label[]>('/labels'),
  create: (data: { name: string; color?: string }) =>
    http<Label>('/labels', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: string, data: Partial<Label>) =>
    http<Label>(`/labels/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  remove: (id: string) => http<{ ok: boolean }>(`/labels/${id}`, { method: 'DELETE' }),
};

export const AiApi = {
  summarize: (text: string) =>
    http<{ summary: string }>('/ai/summarize', {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),
};
