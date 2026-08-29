const BASE = (process.env.EXPO_PUBLIC_BACKEND_URL || '').replace(/\/$/, '');

/** Requests that outlive this are aborted rather than hanging the UI forever. */
const DEFAULT_TIMEOUT_MS = 15_000;
/** Uploading a full handwriting document needs a longer leash. */
const WRITE_TIMEOUT_MS = 30_000;

export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
}

/** The shape the notes list returns: no blobs, so cards stay cheap to fetch. */
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

/** The full document, fetched one note at a time. */
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
 * A failed request, with enough structure for callers to decide what to do.
 * The old client threw bare `Error("500: ...")` strings, so every call site
 * collapsed into `console.warn` and the UI could not distinguish "you are
 * offline" from "someone else edited this note".
 */
export class ApiError extends Error {
  readonly status: number;
  readonly detail: string;

  constructor(status: number, detail: string) {
    super(detail || `Request failed (${status})`);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
  }

  /** No response at all: airplane mode, dead wifi, server down. */
  get isNetwork(): boolean {
    return this.status === 0;
  }

  /** Someone else changed this note since we last read it. */
  get isConflict(): boolean {
    return this.status === 409;
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }

  /** Worth trying again; a 4xx generally is not. */
  get isRetryable(): boolean {
    return this.isNetwork || this.status === 429 || this.status >= 500;
  }

  /** Something safe to put in front of a person. */
  get userMessage(): string {
    if (this.isNetwork) return "Can't reach the server. Your changes are saved on this device.";
    if (this.isConflict) return 'This note was changed somewhere else.';
    if (this.isNotFound) return 'That note no longer exists.';
    if (this.status >= 500) return 'The server had a problem. Trying again shortly.';
    return this.detail || 'Something went wrong.';
  }
}

async function http<T>(path: string, init: RequestInit = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${BASE}/api${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
      signal: controller.signal,
    });
  } catch (err) {
    // fetch only rejects on transport failure or abort, so both mean "no
    // usable response" as far as the caller is concerned.
    const aborted = (err as Error)?.name === 'AbortError';
    throw new ApiError(0, aborted ? 'The request timed out.' : 'Network request failed.');
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      detail = typeof body?.detail === 'string' ? body.detail : JSON.stringify(body?.detail ?? '');
    } catch {
      detail = await res.text().catch(() => '');
    }
    throw new ApiError(res.status, detail);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

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

function listQuery(opts: ListOpts): string {
  const params = new URLSearchParams();
  if (opts.q) params.set('q', opts.q);
  if (opts.folderId) params.set('folder_id', opts.folderId);
  if (opts.labelId) params.set('label_id', opts.labelId);
  if (opts.status) params.set('status', opts.status);
  if (typeof opts.pinned === 'boolean') params.set('pinned', String(opts.pinned));
  if (typeof opts.limit === 'number') params.set('limit', String(opts.limit));
  if (typeof opts.offset === 'number') params.set('offset', String(opts.offset));
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export const NotesApi = {
  /** One page of note summaries, with the total so the UI can page properly. */
  page: (opts: ListOpts = {}) => http<Page<NoteSummary>>(`/notes${listQuery(opts)}`),

  /** Convenience wrapper for screens that just want the first page. */
  list: async (opts: ListOpts = {}): Promise<NoteSummary[]> =>
    (await NotesApi.page(opts)).items,

  get: (id: string) => http<Note>(`/notes/${id}`),

  /** Handwriting payloads are fetched separately; the list never carries them. */
  getDrawing: (id: string) =>
    http<{ drawing_data: string | null; version: number }>(`/notes/${id}/drawing`),

  create: (data: Partial<Note>) =>
    http<Note>('/notes', { method: 'POST', body: JSON.stringify(data) }, WRITE_TIMEOUT_MS),

  /**
   * Send only the keys you mean to change. `null` clears a field, which is how
   * "move this note out of its folder" is expressed. Pass `baseVersion` to make
   * the write conditional and get a 409 instead of silently clobbering.
   */
  update: (id: string, data: Partial<Note>, baseVersion?: number) =>
    http<Note>(
      `/notes/${id}`,
      {
        method: 'PUT',
        body: JSON.stringify(baseVersion === undefined ? data : { ...data, base_version: baseVersion }),
      },
      WRITE_TIMEOUT_MS
    ),

  remove: (id: string, permanent = false) =>
    http<{ ok: boolean; permanent: boolean; already_trashed?: boolean }>(
      `/notes/${id}${permanent ? '?permanent=true' : ''}`,
      { method: 'DELETE' }
    ),

  restore: (id: string) => http<Note>(`/notes/${id}/restore`, { method: 'POST' }),

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

export const HealthApi = {
  check: () => http<{ ok: boolean; db: string }>('/health', {}, 5_000),
};
