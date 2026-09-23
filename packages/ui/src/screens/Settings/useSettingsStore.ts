/**
 * The Settings screen's save model: optimistic, serialised, rolled back per operation.
 *
 * Every control describes its change as a `SaveSpec` whose `patch` is a function of the
 * settings it applies to. The screen shows `view` = the last adapter-confirmed settings with
 * every queued patch applied on top, so a click is reflected at once. The queue sends one
 * `updateSettings` at a time, recomputing each patch against the *confirmed* settings at send
 * time — so when one write fails only that operation disappears from `view` (e.g. relay A
 * failing does not drag relay B's later write down with it, and B's write cannot resurrect A).
 *
 * Writes already queued keep going after unmount (they are the user's intent); only React
 * state updates stop. A failure after unmount still reaches the shell via `onToast` if given.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NetworkAdapter, Settings } from '@sovit/core';
import { describeSaveError } from './model.js';

export type SettingsField = keyof Settings;

export interface SaveSpec {
  /** The field this write touches — drives the per-control "saving" state. */
  readonly field: SettingsField;
  /** Human name for the failure toast: "Could not save <label>". */
  readonly label: string;
  /** The change, as a function of the settings it is applied to (confirmed or optimistic). */
  readonly patch: (base: Settings) => Partial<Settings>;
  /**
   * A write other than `updateSettings(patch)` (seeding on/off goes through
   * `seeder.setEnabled`). Resolves to the confirmed settings.
   */
  readonly write?: (patch: Partial<Settings>, base: Settings) => Promise<Settings>;
}

interface Op extends SaveSpec {
  readonly id: number;
  readonly done: (ok: boolean) => void;
}

export interface FailureNotice {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly retry: () => void;
}

export type LoadStatus = 'loading' | 'ready' | 'error';

export interface SettingsStore {
  readonly status: LoadStatus;
  readonly error: unknown;
  /** Confirmed settings + queued patches. `undefined` until the first load. */
  readonly view: Settings | undefined;
  /** Last adapter-confirmed settings. */
  readonly saved: Settings | undefined;
  /** Fields with a write queued or in flight. */
  readonly pending: ReadonlySet<SettingsField>;
  /** How the most recent write ended (drives the header status line). */
  readonly lastOutcome: 'none' | 'saved' | 'failed';
  /** Queue a change. Resolves `true` once confirmed, `false` if it failed (and was rolled back). */
  readonly save: (spec: SaveSpec) => Promise<boolean>;
  readonly reload: () => void;
}

/**
 * Runs a shell callback without letting it break the write queue: a throwing `onSaved` /
 * `onToast` is the shell's bug, and the remaining queued writes must still go out.
 */
function notify(fn: () => void): void {
  try {
    fn();
  } catch {
    // Deliberately ignored — see above. The save itself already settled.
  }
}

export function useSettingsStore(
  adapter: NetworkAdapter,
  hooks: {
    /** Called with the confirmed settings after every successful write. */
    readonly onSaved?: ((s: Settings) => void) | undefined;
    /** Called when a write fails (after it was rolled back). */
    readonly onFailure: (notice: FailureNotice) => void;
  },
): SettingsStore {
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const hooksRef = useRef(hooks);
  hooksRef.current = hooks;

  const [status, setStatus] = useState<LoadStatus>('loading');
  const [error, setError] = useState<unknown>(undefined);
  const [gen, setGen] = useState(0);

  const [saved, setSavedState] = useState<Settings | undefined>(undefined);
  const [queue, setQueueState] = useState<readonly Op[]>([]);
  const [lastOutcome, setLastOutcome] = useState<SettingsStore['lastOutcome']>('none');
  const savedRef = useRef<Settings | undefined>(undefined);
  const queueRef = useRef<readonly Op[]>([]);
  const running = useRef(false);
  const seq = useRef(0);

  const setSaved = useCallback((s: Settings): void => {
    savedRef.current = s;
    if (alive.current) setSavedState(s);
  }, []);
  const setQueue = useCallback((q: readonly Op[]): void => {
    queueRef.current = q;
    if (alive.current) setQueueState(q);
  }, []);

  // ---- load --------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setError(undefined);
    adapter.settings().then(
      (s) => {
        if (cancelled) return;
        setSaved(s);
        setStatus('ready');
      },
      (err: unknown) => {
        if (cancelled) return;
        setError(err);
        setStatus('error');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [adapter, gen, setSaved]);

  const reload = useCallback((): void => {
    setGen((g) => g + 1);
  }, []);

  // ---- write queue ---------------------------------------------------------------------
  const pump = useCallback(async (): Promise<void> => {
    if (running.current) return;
    running.current = true;
    try {
      for (;;) {
        const op = queueRef.current[0];
        const base = savedRef.current;
        if (op === undefined || base === undefined) break;
        let next: Settings | undefined;
        let failure: unknown;
        try {
          const patch = op.patch(base);
          next = op.write ? await op.write(patch, base) : await adapter.updateSettings(patch);
        } catch (err: unknown) {
          failure = err;
        }
        const confirmed = next;
        if (confirmed !== undefined) setSaved(confirmed);
        setQueue(queueRef.current.filter((o) => o !== op));
        if (confirmed !== undefined) {
          if (alive.current) setLastOutcome('saved');
          // The shell outlives the screen: it hears about a confirmed save even after unmount
          // (this is where it applies the theme — the screen never touches the document).
          notify(() => hooksRef.current.onSaved?.(confirmed));
        } else {
          if (alive.current) setLastOutcome('failed');
          const retrySpec: SaveSpec = {
            field: op.field,
            label: op.label,
            patch: op.patch,
            ...(op.write ? { write: op.write } : {}),
          };
          const notice: FailureNotice = {
            id: `settings-save-${String(op.id)}`,
            title: `Could not save ${op.label}`,
            description: describeSaveError(failure),
            retry: () => {
              void enqueueRef.current(retrySpec);
            },
          };
          notify(() => {
            hooksRef.current.onFailure(notice);
          });
        }
        op.done(confirmed !== undefined);
      }
    } finally {
      running.current = false;
    }
  }, [adapter, setQueue, setSaved]);

  const enqueue = useCallback(
    (spec: SaveSpec): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        seq.current += 1;
        const op: Op = { ...spec, id: seq.current, done: resolve };
        setQueue([...queueRef.current, op]);
        void pump();
      }),
    [pump, setQueue],
  );
  const enqueueRef = useRef(enqueue);
  enqueueRef.current = enqueue;

  // ---- derived -------------------------------------------------------------------------
  const view = useMemo((): Settings | undefined => {
    if (saved === undefined) return undefined;
    let s = saved;
    for (const op of queue) s = { ...s, ...op.patch(s) };
    return s;
  }, [saved, queue]);

  const pending = useMemo(() => new Set(queue.map((o) => o.field)), [queue]);

  return { status, error, view, saved, pending, lastOutcome, save: enqueue, reload };
}
