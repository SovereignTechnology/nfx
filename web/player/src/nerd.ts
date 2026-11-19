/**
 * The test player's "stats for nerds" panel (nfx #99): where the bytes come from, over the
 * video. Opened from the video's context menu, the "Stats for nerds" button, or the `n` key;
 * closed by its ×, Escape or `n` again. While open it reads the session every second.
 *
 * Sources are shown by a short id. Peers' IP addresses appear only behind "Show addresses",
 * which is off each time the panel opens, is never remembered, and asks the session
 * (`Session.addresses()`) only while it is on. Nothing here logs or sends an address.
 *
 * Everything the network chose (peer ids, relay and tracker URLs, addresses) is written as
 * text (`textContent`), never as markup. Styles are in player.css (CSP `style-src 'self'`).
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { PeerAddress, Stats } from './api';

/** One row of the sources table. */
export interface NerdSource {
  kind: 'origin' | 'webrtc';
  /** A short id: an origin's host, or a peer's id cut short. */
  id: string;
  /** The full id (for matching addresses), never shown whole. */
  key: string;
  label: string;
  via: string;
  down: number;
  up: number;
  segments: number;
  connected: boolean;
}

/** What the panel shows, from a session's stats and the video element. */
export interface NerdView {
  rows: [string, string][];
  sources: NerdSource[];
}

const HEX64 = /^[0-9a-f]{64}$/;

/** A peer id as the panel shows it: a session key cut to 8 hex, anything else to 20 characters. */
export function shortId(id: string): string {
  return HEX64.test(id) ? id.slice(0, 8) : id.slice(0, 20);
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '–';
  if (n < 1024) return `${n} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v < 10 ? 2 : 1)} ${units[i]}`;
}

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 64);
  }
}

/** What the element says: resolution, buffer ahead, frames. */
export interface ElementSample {
  width: number;
  height: number;
  bufferAhead: number;
  dropped: number | null;
  frames: number | null;
}

export function sampleElement(el: HTMLVideoElement): ElementSample {
  let bufferAhead = 0;
  for (let i = 0; i < el.buffered.length; i += 1) {
    if (el.buffered.start(i) <= el.currentTime + 0.1 && el.currentTime <= el.buffered.end(i)) {
      bufferAhead = el.buffered.end(i) - el.currentTime;
    }
  }
  const q = typeof el.getVideoPlaybackQuality === 'function' ? el.getVideoPlaybackQuality() : null;
  return {
    width: el.videoWidth,
    height: el.videoHeight,
    bufferAhead,
    dropped: q ? q.droppedVideoFrames : null,
    frames: q ? q.totalVideoFrames : null,
  };
}

/** The panel's rows and sources for one session snapshot. Pure: tested in unit.ts. */
export function nerdView(s: Stats, e: ElementSample, title: string | null): NerdView {
  const level = s.levels.find((l) => l.index === s.level);
  const mesh = s.mesh;
  const rows: [string, string][] = [];
  if (title !== null) rows.push(['Video', title]);
  rows.push(['Root', `${s.root.slice(0, 16)}…`]);
  rows.push(['Engine', s.engine]);
  rows.push(['Resolution', e.width > 0 ? `${e.width}x${e.height}` : '–']);
  rows.push(['Rendition', level ? `${level.id} (${Math.round(level.bitrate / 1000)} kb/s)` : s.level === -1 ? 'auto (hls.js picks)' : '–']);
  rows.push(['Bandwidth estimate', s.bandwidthEstimate > 0 ? `${(s.bandwidthEstimate / 1e6).toFixed(2)} Mb/s` : '–']);
  rows.push(['Buffer health', `${e.bufferAhead.toFixed(1)} s`]);
  rows.push(['Dropped frames', e.dropped === null ? '–' : `${e.dropped} of ${e.frames ?? 0}`]);
  rows.push(['Verified files', `${s.verified}${s.rejected.length > 0 ? `, ${s.rejected.length} refused` : ''}`]);
  if (mesh === null) {
    rows.push(['Mesh', 'off: every byte from the origin']);
  } else {
    const total = mesh.bytes.http + mesh.bytes.p2p;
    const share = total > 0 ? Math.round((mesh.bytes.p2p / total) * 100) : 0;
    rows.push(['From peers', `${share}% (${formatBytes(mesh.bytes.p2p)} of ${formatBytes(total)} of segments)`]);
    rows.push(['Uploaded', formatBytes(mesh.uploaded)]);
    rows.push(['Peers', `${mesh.connected} connected, ${mesh.peers} since start`]);
    rows.push(['Segments', `${mesh.segments.http} over HTTP, ${mesh.segments.p2p} from peers`]);
    if (mesh.signaling === 'nostr') {
      const sig = mesh.signal;
      rows.push(['Signaling', `Nostr, ${sig ? `${sig.open} of ` : ''}${mesh.relays.length} relays open`]);
      if (sig) rows.push(['Signal events', `${sig.sent} sent, ${sig.received} received, ${sig.offers} offers, ${sig.answers} answers`]);
      rows.push(['Relays', mesh.relays.map(host).join(', ')]);
    } else {
      rows.push(['Signaling', `trackers: ${mesh.trackers.map(host).join(', ')}`]);
    }
    if (mesh.rejected.length > 0) rows.push(['Refused segments', String(mesh.rejected.length)]);
  }
  const sources: NerdSource[] = [
    {
      kind: 'origin',
      id: host(s.origin),
      key: s.origin,
      label: 'HTTPS origin',
      via: '',
      down: s.originBytes + (mesh?.bytes.http ?? 0),
      up: 0,
      segments: mesh === null ? 0 : mesh.segments.http,
      connected: true,
    },
  ];
  for (const p of mesh?.peerList ?? []) {
    sources.push({
      kind: 'webrtc',
      id: shortId(p.id),
      key: p.id,
      label: p.id.startsWith('-NX0100-') ? 'nfxd bridge?' : 'peer',
      via: p.via.startsWith('nostr:') ? 'nostr' : host(p.via),
      down: p.down,
      up: p.up,
      segments: p.segments,
      connected: p.connected,
    });
  }
  return { rows, sources };
}

/** An address cell: hidden ones say so, never guess. */
export function addressText(a: PeerAddress | undefined): string {
  if (a === undefined) return '–';
  if (a.address === '') return 'hidden by browser';
  if (a.address.endsWith('.local')) return 'hidden by browser (mDNS)';
  const ip = a.address.includes(':') ? `[${a.address}]` : a.address;
  return a.port === null ? ip : `${ip}:${a.port}`;
}

export function pathText(a: PeerAddress | undefined): string {
  if (a === undefined || a.path === 'unknown') return '–';
  const rtt = a.rttMs === null ? '' : `, ${a.rttMs} ms`;
  return `${a.path} (${a.remoteType || '?'}/${a.protocol || '?'}${rtt})`;
}

/** The panel, wired to a page. */
export interface NerdPanel {
  readonly isOpen: boolean;
  readonly showingAddresses: boolean;
  open(): void;
  close(): void;
  toggle(): void;
  /** What Copy would put on the clipboard now. */
  snapshot(): string;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/**
 * Builds the panel inside `stage` (the video's positioned parent), its context menu on
 * `video`, the `n` key on the document, and a toggle `button`.
 */
export function nerdPanel(opts: {
  stage: HTMLElement;
  video: HTMLVideoElement;
  button: HTMLButtonElement;
  stats: () => Stats | null;
  addresses: () => Promise<PeerAddress[]>;
  title: () => string | null;
}): NerdPanel {
  const panel = el('div', 'nerd');
  panel.id = 'nerd';
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Stats for nerds');
  const head = el('div', 'nerd__head');
  head.append(el('strong', '', 'Stats for nerds'));
  const showLabel = el('label', 'nerd__show');
  const show = el('input');
  show.type = 'checkbox';
  show.id = 'nerd-addresses';
  showLabel.append(show, ' Show addresses');
  const copy = el('button', 'nerd__copy', 'Copy');
  copy.type = 'button';
  const close = el('button', 'nerd__close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close stats');
  head.append(showLabel, copy, close);
  const banner = el('p', 'nerd__banner', "Addresses visible: these are other viewers' IP addresses. Don't share screenshots.");
  banner.hidden = true;
  const rows = el('table', 'nerd__rows');
  const sources = el('table', 'nerd__sources');
  const status = el('p', 'nerd__status');
  panel.append(head, banner, rows, sources, status);
  opts.stage.append(panel);

  const menu = el('div', 'nerd-menu');
  menu.id = 'nerd-menu';
  menu.hidden = true;
  menu.setAttribute('role', 'menu');
  const item = el('button', '', 'Stats for nerds');
  item.type = 'button';
  item.setAttribute('role', 'menuitem');
  menu.append(item);
  opts.stage.append(menu);

  let timer: ReturnType<typeof setInterval> | null = null;
  let addresses: PeerAddress[] = [];
  let asking = false;
  let last: NerdView | null = null;

  const render = (): void => {
    const s = opts.stats();
    if (s === null) {
      rows.replaceChildren();
      sources.replaceChildren();
      status.textContent = 'Nothing playing yet.';
      last = null;
      return;
    }
    const v = nerdView(s, sampleElement(opts.video), opts.title());
    last = v;
    status.textContent = '';
    rows.replaceChildren(
      ...v.rows.map(([k, val]) => {
        const tr = el('tr');
        tr.append(el('th', '', k), el('td', '', val));
        return tr;
      }),
    );
    const withAddr = show.checked;
    const titles = el('tr');
    for (const h of ['Source', 'ID', 'Via', 'Down', 'Up', 'Segments', ...(withAddr ? ['Address', 'Path'] : [])]) titles.append(el('th', '', h));
    const byId = new Map(addresses.map((a) => [a.id, a]));
    sources.replaceChildren(
      titles,
      ...v.sources.map((src) => {
        const tr = el('tr', src.connected ? 'nerd__open' : 'nerd__closed');
        tr.dataset.kind = src.kind;
        const kind = src.kind === 'origin' ? 'origin' : `webrtc ${src.label === 'peer' ? '' : src.label}`.trim();
        tr.append(
          el('td', '', `${kind}${src.connected ? '' : ' (closed)'}`),
          el('td', 'nerd__id', src.id),
          el('td', '', src.via || '–'),
          el('td', '', formatBytes(src.down)),
          el('td', '', formatBytes(src.up)),
          el('td', '', String(src.segments)),
        );
        if (withAddr) {
          const a = src.kind === 'origin' ? undefined : byId.get(src.key);
          tr.append(el('td', 'nerd__addr', src.kind === 'origin' ? src.id : addressText(a)), el('td', '', src.kind === 'origin' ? 'HTTPS' : pathText(a)));
        }
        return tr;
      }),
    );
  };

  const ask = (): void => {
    if (!show.checked || asking) return;
    asking = true;
    opts
      .addresses()
      .then((a) => {
        if (show.checked) addresses = a;
      })
      .catch(() => {
        addresses = [];
      })
      .finally(() => {
        asking = false;
        if (!panel.hidden) render();
      });
  };

  const tick = (): void => {
    render();
    ask();
  };

  const api: NerdPanel = {
    get isOpen() {
      return !panel.hidden;
    },
    get showingAddresses() {
      return show.checked;
    },
    open() {
      menu.hidden = true;
      // Addresses are off each time the panel opens.
      show.checked = false;
      addresses = [];
      banner.hidden = true;
      panel.hidden = false;
      opts.button.setAttribute('aria-pressed', 'true');
      tick();
      if (timer === null) timer = setInterval(tick, 1000);
    },
    close() {
      panel.hidden = true;
      show.checked = false;
      addresses = [];
      banner.hidden = true;
      opts.button.setAttribute('aria-pressed', 'false');
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
    toggle() {
      if (panel.hidden) api.open();
      else api.close();
    },
    snapshot() {
      if (last === null) return '{}';
      const byId = new Map(addresses.map((a) => [a.id, a]));
      return JSON.stringify(
        {
          stats: Object.fromEntries(last.rows),
          // The full peer id stays out; addresses go in only while they are shown.
          sources: last.sources.map(({ key, ...src }) =>
            show.checked && src.kind === 'webrtc' ? { ...src, address: addressText(byId.get(key)), path: pathText(byId.get(key)) } : src,
          ),
        },
        null,
        2,
      );
    },
  };

  show.addEventListener('change', () => {
    addresses = [];
    banner.hidden = !show.checked;
    render();
    ask();
  });
  copy.addEventListener('click', () => {
    navigator.clipboard.writeText(api.snapshot()).then(
      () => {
        status.textContent = show.checked ? 'Copied, with addresses.' : 'Copied (no addresses).';
      },
      () => {
        status.textContent = 'Copy failed: the browser refused the clipboard.';
      },
    );
  });
  close.addEventListener('click', () => api.close());
  opts.button.addEventListener('click', () => api.toggle());
  item.addEventListener('click', () => api.open());
  opts.video.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const box = opts.stage.getBoundingClientRect();
    menu.style.left = `${Math.max(0, e.clientX - box.left)}px`;
    menu.style.top = `${Math.max(0, e.clientY - box.top)}px`;
    menu.hidden = false;
    item.focus();
  });
  document.addEventListener('click', (e) => {
    if (!menu.hidden && !menu.contains(e.target as Node)) menu.hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement | null;
    const typing = t !== null && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    if (e.key === 'Escape') {
      if (!menu.hidden) menu.hidden = true;
      else if (!panel.hidden) api.close();
      return;
    }
    if (typing || e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.key === 'n' || e.key === 'N') {
      e.preventDefault();
      api.toggle();
    }
  });
  return api;
}
