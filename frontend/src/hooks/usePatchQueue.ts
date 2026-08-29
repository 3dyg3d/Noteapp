/**
 * A debounced save queue that does not lose writes.
 *
 * The previous implementation cleared its timer and scheduled the newest patch
 * object on every call, so any edit made inside the debounce window replaced
 * the pending one instead of joining it. Typing a title and then tapping a
 * folder within 600 ms silently discarded the title.
 *
 * This queue:
 *   - merges pending patches instead of replacing them,
 *   - flushes on unmount and when the app backgrounds,
 *   - serialises writes so two in-flight requests can't land out of order,
 *   - reports real status, so a failed write never renders as "saved".
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, AppStateStatus } from 'react-native';

export type SaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

export interface PatchQueueOptions<T> {
  /** Performs the write. Rejecting marks the queue errored and keeps the patch. */
  save: (patch: Partial<T>) => Promise<unknown>;
  /** Quiet period before a write goes out. */
  delay?: number;
  /** Retry attempts for a failed flush, with exponential backoff. */
  retries?: number;
  onError?: (error: unknown, patch: Partial<T>) => void;
  onSaved?: (patch: Partial<T>) => void;
}

export interface PatchQueue<T> {
  /** Merge a patch into the pending write and restart the quiet period. */
  push: (patch: Partial<T>) => void;
  /** Write immediately, bypassing the quiet period. Resolves when settled. */
  flush: () => Promise<void>;
  status: SaveStatus;
  /** True while anything is queued or in flight. Use it to warn before leaving. */
  hasUnsaved: boolean;
  lastError: unknown;
  /** Re-attempt after a failure without changing the pending patch. */
  retry: () => Promise<void>;
}

export function usePatchQueue<T extends object>(options: PatchQueueOptions<T>): PatchQueue<T> {
  const { delay = 600, retries = 2 } = options;

  // Options live in a ref so a re-render with new closures never strands an
  // in-flight or pending write against a stale save function.
  const optsRef = useRef(options);
  optsRef.current = options;

  const pendingRef = useRef<Partial<T> | null>(null);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const [status, setStatus] = useState<SaveStatus>('idle');
  const [lastError, setLastError] = useState<unknown>(null);
  const [hasUnsaved, setHasUnsaved] = useState(false);

  const set = useCallback((next: SaveStatus) => {
    if (mountedRef.current) setStatus(next);
  }, []);

  const writeNow = useCallback(async (): Promise<void> => {
    // Serialise: if a write is already going out, wait for it. The next patch
    // must be applied on top of the previous one, never alongside it.
    if (inFlightRef.current) {
      await inFlightRef.current.catch(() => {});
    }
    const patch = pendingRef.current;
    if (!patch || Object.keys(patch).length === 0) {
      if (mountedRef.current) setHasUnsaved(false);
      return;
    }

    // Claim the patch before awaiting, so edits made during the request queue
    // up for the next round instead of being overwritten by this one.
    pendingRef.current = null;
    set('saving');

    const attempt = async (): Promise<void> => {
      let lastErr: unknown;
      for (let i = 0; i <= retries; i++) {
        try {
          await optsRef.current.save(patch);
          if (mountedRef.current) {
            setLastError(null);
            setHasUnsaved(pendingRef.current !== null);
          }
          set(pendingRef.current ? 'pending' : 'saved');
          optsRef.current.onSaved?.(patch);
          return;
        } catch (err) {
          lastErr = err;
          if (i < retries) {
            await new Promise((r) => setTimeout(r, 400 * Math.pow(2, i)));
          }
        }
      }
      // Put the patch back at the front of the queue. Later edits win on
      // conflicting keys, but nothing is thrown away.
      pendingRef.current = { ...patch, ...(pendingRef.current ?? {}) };
      if (mountedRef.current) {
        setLastError(lastErr);
        setHasUnsaved(true);
      }
      set('error');
      optsRef.current.onError?.(lastErr, patch);
      throw lastErr;
    };

    const run = attempt();
    inFlightRef.current = run.then(
      () => undefined,
      () => undefined
    );
    try {
      await run;
    } finally {
      inFlightRef.current = null;
    }
  }, [retries, set]);

  const push = useCallback(
    (patch: Partial<T>) => {
      // The fix: merge, don't replace.
      pendingRef.current = { ...(pendingRef.current ?? {}), ...patch };
      setHasUnsaved(true);
      set('pending');
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        void writeNow().catch(() => {});
      }, delay);
    },
    [delay, set, writeNow]
  );

  const flush = useCallback(async () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    await writeNow().catch(() => {});
  }, [writeNow]);

  const retry = useCallback(async () => {
    await flush();
  }, [flush]);

  // Backgrounding the app is the most common way an edit gets stranded, so
  // treat it as a hard flush point.
  useEffect(() => {
    const onChange = (next: AppStateStatus) => {
      if (next === 'background' || next === 'inactive') void flush();
    };
    const sub = AppState.addEventListener('change', onChange);
    return () => sub.remove();
  }, [flush]);

  // Flush on unmount. The old code had no cleanup at all: navigating back
  // inside the debounce window dropped the edit and left a setState pending
  // against a dead component.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      // Deliberately fire-and-forget: the component is gone, but the write
      // still needs to reach the server.
      void writeNow().catch(() => {});
    };
  }, [writeNow]);

  return { push, flush, status, hasUnsaved, lastError, retry };
}
