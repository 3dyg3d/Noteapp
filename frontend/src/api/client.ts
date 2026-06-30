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
  folder_id: string | null;
  color: string | null;
  pinned: boolean;
  locked: boolean;
  created_at: string;
  updated_at: string;
}

export interface Folder {
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

export const NotesApi = {
  list: (q?: string, folderId?: string | null) => {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (folderId) params.set('folder_id', folderId);
    const qs = params.toString();
    return http<Note[]>(`/notes${qs ? `?${qs}` : ''}`);
  },
  get: (id: string) => http<Note>(`/notes/${id}`),
  create: (data: Partial<Note>) =>
    http<Note>('/notes', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: string, data: Partial<Note>) =>
    http<Note>(`/notes/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  remove: (id: string) => http<{ ok: boolean }>(`/notes/${id}`, { method: 'DELETE' }),
};

export const FoldersApi = {
  list: () => http<Folder[]>('/folders'),
  create: (data: { name: string; color: string }) =>
    http<Folder>('/folders', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: string, data: Partial<Folder>) =>
    http<Folder>(`/folders/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  remove: (id: string) => http<{ ok: boolean }>(`/folders/${id}`, { method: 'DELETE' }),
};

export const AiApi = {
  summarize: (text: string) =>
    http<{ summary: string }>('/ai/summarize', {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),
};
