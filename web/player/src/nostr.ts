/**
 * A minimal NIP-01 reader over WebSocket: REQ, EVENT, EOSE, CLOSED. Relays are untrusted.
 * Every event is handed on as a JSON string for the caller to verify (nfx-proto via WASM),
 * and oversized messages or floods are dropped rather than parsed.
 */

export type Filter = Record<string, unknown>;

/** Largest relay message parsed; NFX events are ≤ 64 KiB (NFX-04 §2). */
const MAX_MESSAGE = 70 * 1024;
/**
 * Most events one subscription hands on per minute, of each kind (so one filter's flood cannot
 * starve another's, and a subscription that lives for hours keeps working).
 */
const MAX_EVENTS = 1000;
const EVENTS_WINDOW_MS = 60_000;
/** Most distinct kinds one subscription counts. */
const MAX_KINDS = 8;

export interface Subscription {
  close(): void;
}

let seq = 0;

/**
 * Subscribe to `filter` (or several, in one REQ) on `url`. `onEvent` gets each event as JSON;
 * `onEnd` fires once.
 */
export function subscribe(
  url: string,
  filter: Filter | Filter[],
  onEvent: (eventJson: string) => void,
  onEose: () => void,
  onEnd: (why: string) => void,
): Subscription {
  const id = `nfx${++seq}`;
  let ended = false;
  /** Events handed on, by kind, in the current window. */
  const counts = new Map<unknown, number>();
  let windowStart = Date.now();
  const end = (why: string): void => {
    if (!ended) {
      ended = true;
      onEnd(why);
    }
  };
  let ws: WebSocket;
  try {
    ws = new WebSocket(url);
  } catch (e) {
    queueMicrotask(() => end(`bad relay URL: ${String(e)}`));
    return { close() {} };
  }
  const filters: Filter[] = Array.isArray(filter) ? filter : [filter];
  ws.onopen = () => ws.send(JSON.stringify(['REQ', id, ...filters]));
  ws.onmessage = (m: MessageEvent) => {
    const text = typeof m.data === 'string' ? m.data : '';
    if (text.length === 0 || text.length > MAX_MESSAGE) return;
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (!Array.isArray(msg) || msg[1] !== id) return;
    if (msg[0] === 'EVENT' && msg[2] !== null && typeof msg[2] === 'object') {
      if (Date.now() - windowStart >= EVENTS_WINDOW_MS) {
        counts.clear();
        windowStart = Date.now();
      }
      const kind = (msg[2] as { kind?: unknown }).kind;
      const n = (counts.get(kind) ?? 0) + 1;
      if (!counts.has(kind) && counts.size >= MAX_KINDS) return;
      counts.set(kind, n);
      if (n <= MAX_EVENTS) onEvent(JSON.stringify(msg[2]));
    } else if (msg[0] === 'EOSE') {
      onEose();
    } else if (msg[0] === 'CLOSED') {
      end(`relay closed the subscription: ${String(msg[2] ?? '')}`);
      ws.close();
    }
  };
  ws.onerror = () => end('websocket error');
  ws.onclose = () => end('websocket closed');
  return {
    close() {
      ended = true;
      try {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(['CLOSE', id]));
      } catch {
        // closing anyway
      }
      ws.close();
    },
  };
}

/** Stored events matching `filter`: collected until EOSE, the end of the socket, or `timeoutMs`. */
export function query(url: string, filter: Filter, timeoutMs: number): Promise<string[]> {
  return new Promise((resolve) => {
    const events: string[] = [];
    const done = (): void => {
      clearTimeout(timer);
      sub.close();
      resolve(events);
    };
    const timer = setTimeout(done, timeoutMs);
    const sub = subscribe(url, filter, (e) => events.push(e), done, done);
  });
}

/**
 * Publish a signed event (as JSON) to `url` and wait for the relay's `OK`: whether it took the
 * event, and its message (`blocked: …`, `rate-limited: …`, NIP-01). A relay that does not
 * answer within `timeoutMs` counts as not taking it.
 */
export function publish(
  url: string,
  eventJson: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ ok: boolean; message: string }> {
  return new Promise((resolve) => {
    let done = false;
    let ws: WebSocket | undefined;
    const finish = (ok: boolean, message: string): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      try {
        ws?.close();
      } catch {
        // closing anyway
      }
      resolve({ ok, message });
    };
    const timer = setTimeout(() => finish(false, 'timeout'), timeoutMs);
    // A cancelled publication closes its socket, connecting or not, and never sends.
    const cancel = (): void => finish(false, 'cancelled');
    if (signal?.aborted) {
      queueMicrotask(cancel);
      return;
    }
    signal?.addEventListener('abort', cancel, { once: true });
    let id: unknown;
    try {
      id = (JSON.parse(eventJson) as { id?: unknown }).id;
      ws = new WebSocket(url);
    } catch (e) {
      queueMicrotask(() => finish(false, `bad relay URL or event: ${String(e)}`));
      return;
    }
    const socket = ws;
    socket.onopen = () => {
      if (!done) socket.send(`["EVENT",${eventJson}]`);
    };
    socket.onmessage = (m: MessageEvent) => {
      const text = typeof m.data === 'string' ? m.data : '';
      if (text.length === 0 || text.length > MAX_MESSAGE) return;
      let msg: unknown;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      if (Array.isArray(msg) && msg[0] === 'OK' && msg[1] === id) finish(msg[2] === true, typeof msg[3] === 'string' ? msg[3].slice(0, 200) : '');
    };
    socket.onerror = () => finish(false, 'websocket error');
    socket.onclose = () => finish(false, 'websocket closed');
  });
}
