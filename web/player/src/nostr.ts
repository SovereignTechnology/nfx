/**
 * A minimal NIP-01 reader over WebSocket: REQ, EVENT, EOSE, CLOSED. Relays are untrusted.
 * Every event is handed on as a JSON string for the caller to verify (nfx-proto via WASM),
 * and oversized messages or floods are dropped rather than parsed.
 */

export type Filter = Record<string, unknown>;

/** Largest relay message parsed; NFX events are ≤ 64 KiB (NFX-04 §2). */
const MAX_MESSAGE = 70 * 1024;
/** Most events one subscription hands on. */
const MAX_EVENTS = 1000;

export interface Subscription {
  close(): void;
}

let seq = 0;

/** Subscribe to `filter` on `url`. `onEvent` gets each event as JSON; `onEnd` fires once. */
export function subscribe(
  url: string,
  filter: Filter,
  onEvent: (eventJson: string) => void,
  onEose: () => void,
  onEnd: (why: string) => void,
): Subscription {
  const id = `nfx${++seq}`;
  let ended = false;
  let count = 0;
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
  ws.onopen = () => ws.send(JSON.stringify(['REQ', id, filter]));
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
      if (++count <= MAX_EVENTS) onEvent(JSON.stringify(msg[2]));
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
