// NFX desktop page. Bytes come from nfx:// (the node's verified origin); this page only
// plays them. Every DOM update goes through textContent.
const { invoke } = window.__TAURI__.core;
const base = navigator.userAgent.includes('Windows') ? 'http://nfx.localhost' : 'nfx://localhost';
const $ = (id) => document.getElementById(id);
const lines = (s) => s.split('\n').map((x) => x.trim()).filter(Boolean);
let hls = null;
let test = null;
/** The video playing: { a, root, title } once watch() resolved it. */
let playing = null;

function say(text) {
  $('msg').textContent = text;
}

function report(step, extra = {}) {
  if (test) invoke('report', { line: JSON.stringify({ step, ...extra }) });
}

async function loadSettings() {
  const s = await invoke('settings');
  $('relays').value = s.relays.join('\n');
  $('iroh').value = s.iroh_relays.join('\n');
  $('share').checked = s.share;
  $('rating-root').value = s.rating_root;
  $('general').value = s.general_relays.join('\n');
  $('trusted').value = s.rating_trusted.join('\n');
  $('pubkey').textContent = s.pubkey;
}

async function refreshStatus() {
  const rows = await invoke('status');
  const ul = $('status');
  ul.replaceChildren(
    ...rows.map(([a, state]) => {
      const li = document.createElement('li');
      const left = document.createElement('span');
      left.textContent = a;
      const right = document.createElement('span');
      right.textContent = state;
      li.append(left, right);
      return li;
    }),
  );
  return rows;
}

async function watch(a) {
  say('Resolving the manifest and waiting for a seeder…');
  report('watching', { a });
  const w = await invoke('watch', { a });
  $('title').textContent = w.title;
  say(`Playing ${w.video}. Every file is checked against its sha256 before it plays.`);
  report('resolved', { root: w.root, title: w.title });
  playing = { a: w.a, root: w.root, title: w.title };
  if (hls) hls.destroy();
  const video = $('v');
  if (!window.Hls || !Hls.isSupported()) throw new Error('MediaSource unavailable');
  hls = new Hls();
  hls.on(Hls.Events.MANIFEST_PARSED, (_, d) => {
    report('levels', { levels: d.levels.map((l) => l.height) });
    video.play().catch((e) => report('play-error', { error: String(e) }));
  });
  hls.on(Hls.Events.ERROR, (_, d) => {
    if (d.fatal) {
      say(`Playback error: ${d.details}`);
      report('fatal', { details: d.details });
      if (test) invoke('done', { ok: false });
    }
  });
  hls.loadSource(`${base}/${w.root}/master.m3u8`);
  hls.attachMedia(video);
}

// ---- Stats for nerds (nfx #99): where the bytes come from -----------------------------
// Seeders by a short id; their addresses only behind "Show addresses", which is off each
// time the panel opens, is never remembered, and asks the node (nerd_addresses) only while
// it is on. Everything is written with textContent.
const nerd = { timer: null, addresses: [], asking: false, last: null };

function fmtBytes(n) {
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

function cell(tag, text, cls) {
  const e = document.createElement(tag);
  e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

function elementSample(v) {
  let ahead = 0;
  for (let i = 0; i < v.buffered.length; i += 1) {
    if (v.buffered.start(i) <= v.currentTime + 0.1 && v.currentTime <= v.buffered.end(i)) ahead = v.buffered.end(i) - v.currentTime;
  }
  const q = typeof v.getVideoPlaybackQuality === 'function' ? v.getVideoPlaybackQuality() : null;
  return { width: v.videoWidth, height: v.videoHeight, ahead, dropped: q ? q.droppedVideoFrames : null, frames: q ? q.totalVideoFrames : null };
}

function addressText(r) {
  if (!r || !r.address) return '–';
  if (r.path === 'relay') return `relay ${r.address}`;
  return r.address;
}

async function nerdRender() {
  const status = $('nerd-status');
  if (!playing) {
    $('nerd-rows').replaceChildren();
    $('nerd-sources').replaceChildren();
    status.textContent = 'Nothing playing yet.';
    nerd.last = null;
    return;
  }
  const s = await invoke('nerd_stats', { a: playing.a, root: playing.root });
  const e = elementSample($('v'));
  const level = hls && hls.levels && hls.currentLevel >= 0 ? hls.levels[hls.currentLevel] : null;
  const total = s.peers.reduce((n, p) => n + p.bytes, 0);
  const rows = [
    ['Video', playing.title],
    ['Root', `${playing.root.slice(0, 16)}…`],
    ['On this node', s.state],
    ['Engine', `hls.js ${window.Hls ? Hls.version : '?'} over nfx:// (this node's verified origin)`],
    ['Resolution', e.width > 0 ? `${e.width}x${e.height}` : '–'],
    ['Rendition', level ? `${level.height}p (${Math.round(level.bitrate / 1000)} kb/s)` : hls && hls.autoLevelEnabled ? 'auto' : '–'],
    ['Bandwidth estimate', hls && hls.bandwidthEstimate > 0 ? `${(hls.bandwidthEstimate / 1e6).toFixed(2)} Mb/s (nfx:// reads)` : '–'],
    ['Buffer health', `${e.ahead.toFixed(1)} s`],
    ['Dropped frames', e.dropped === null ? '–' : `${e.dropped} of ${e.frames ?? 0}`],
    ['Fetched over iroh', `${fmtBytes(total)} from ${s.peers.length} seeder(s); ${s.known} known`],
  ];
  if (s.mesh) rows.push(['Serving browsers', `${s.mesh.open} open, ${s.mesh.opened} since start, ${s.mesh.served} segment requests`]);
  const withAddr = $('nerd-addresses').checked;
  const byPeer = new Map(nerd.addresses.map((r) => [r.peer, r]));
  const head = document.createElement('tr');
  for (const h of ['Source', 'ID', 'Down', 'Blobs', ...(withAddr ? ['Address', 'Path'] : [])]) head.append(cell('th', h));
  const srcRows = s.peers.map((p) => {
    const tr = document.createElement('tr');
    tr.dataset.kind = 'iroh';
    if (!p.open) tr.className = 'closed';
    tr.append(cell('td', 'iroh seeder'), cell('td', p.peer.slice(0, 8)), cell('td', fmtBytes(p.bytes)), cell('td', String(p.blobs)));
    if (withAddr) {
      const r = byPeer.get(p.peer);
      tr.append(cell('td', addressText(r), 'addr'), cell('td', r && r.path !== 'unknown' ? `${r.path}${r.rtt_ms != null ? `, ${r.rtt_ms} ms` : ''}${r.open ? '' : ' (last seen)'}` : '–'));
    }
    return tr;
  });
  $('nerd-rows').replaceChildren(...rows.map(([k, v]) => {
    const tr = document.createElement('tr');
    tr.append(cell('th', k), cell('td', v));
    return tr;
  }));
  $('nerd-sources').replaceChildren(head, ...srcRows);
  status.textContent = s.peers.length === 0 ? 'No seeder has sent this node bytes yet (or every file was already here).' : '';
  nerd.last = {
    stats: Object.fromEntries(rows),
    sources: s.peers.map((p) => {
      const src = { kind: 'iroh', id: p.peer.slice(0, 8), down: p.bytes, blobs: p.blobs, open: p.open };
      const r = withAddr ? byPeer.get(p.peer) : undefined;
      return r ? { ...src, address: addressText(r), path: r.path } : src;
    }),
  };
  report('nerd', { rows: rows.length, peers: s.peers.length, bytes: total, addresses: withAddr ? nerd.addresses.length : 0 });
}

function nerdAsk() {
  if (!$('nerd-addresses').checked || nerd.asking || !playing) return;
  nerd.asking = true;
  invoke('nerd_addresses', { root: playing.root })
    .then((a) => {
      if ($('nerd-addresses').checked) nerd.addresses = a;
    })
    .catch(() => {
      nerd.addresses = [];
    })
    .finally(() => {
      nerd.asking = false;
    });
}

function nerdTick() {
  nerdRender().catch((e) => {
    $('nerd-status').textContent = String(e);
  });
  nerdAsk();
}

function nerdOpen() {
  $('nerd-menu').hidden = true;
  $('nerd-addresses').checked = false;
  nerd.addresses = [];
  $('nerd-banner').hidden = true;
  $('nerd').hidden = false;
  $('nerd-toggle').setAttribute('aria-pressed', 'true');
  nerdTick();
  if (nerd.timer === null) nerd.timer = setInterval(nerdTick, 1000);
}

function nerdClose() {
  $('nerd').hidden = true;
  $('nerd-addresses').checked = false;
  nerd.addresses = [];
  $('nerd-banner').hidden = true;
  $('nerd-toggle').setAttribute('aria-pressed', 'false');
  if (nerd.timer !== null) clearInterval(nerd.timer);
  nerd.timer = null;
}

function nerdToggle() {
  if ($('nerd').hidden) nerdOpen();
  else nerdClose();
}

$('nerd-toggle').addEventListener('click', nerdToggle);
$('nerd-close').addEventListener('click', nerdClose);
$('nerd-item').addEventListener('click', nerdOpen);
$('nerd-addresses').addEventListener('change', () => {
  nerd.addresses = [];
  $('nerd-banner').hidden = !$('nerd-addresses').checked;
  nerdTick();
});
$('nerd-copy').addEventListener('click', () => {
  const text = JSON.stringify(nerd.last ?? {}, null, 2);
  navigator.clipboard.writeText(text).then(
    () => {
      $('nerd-status').textContent = $('nerd-addresses').checked ? 'Copied, with addresses.' : 'Copied (no addresses).';
    },
    () => {
      $('nerd-status').textContent = 'Copy failed: the clipboard was refused.';
    },
  );
});
$('v').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const box = $('stage').getBoundingClientRect();
  const menu = $('nerd-menu');
  menu.style.left = `${Math.max(0, e.clientX - box.left)}px`;
  menu.style.top = `${Math.max(0, e.clientY - box.top)}px`;
  menu.hidden = false;
  $('nerd-item').focus();
});
document.addEventListener('click', (e) => {
  const menu = $('nerd-menu');
  if (!menu.hidden && !menu.contains(e.target)) menu.hidden = true;
});
document.addEventListener('keydown', (e) => {
  const t = e.target;
  const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  if (e.key === 'Escape') {
    if (!$('nerd-menu').hidden) $('nerd-menu').hidden = true;
    else if (!$('nerd').hidden) nerdClose();
    return;
  }
  if (typing || e.ctrlKey || e.altKey || e.metaKey) return;
  if (e.key === 'n' || e.key === 'N') {
    e.preventDefault();
    nerdToggle();
  }
});

$('play').addEventListener('click', () => watch($('a').value.trim()).catch((e) => say(String(e))));
$('save').addEventListener('click', async () => {
  try {
    await invoke('save_settings', {
      relays: lines($('relays').value),
      irohRelays: lines($('iroh').value),
      share: $('share').checked,
      ratingRoot: $('rating-root').value.trim(),
      ratingTrusted: lines($('trusted').value),
      generalRelays: lines($('general').value),
    });
    say('Node restarted with the new settings.');
  } catch (e) {
    say(String(e));
  }
});

(async () => {
  await loadSettings();
  setInterval(() => refreshStatus().catch(() => {}), 2000);
  test = await invoke('test_config');
  if (!test) return;
  // Test mode: play the address, then wait until playback passes 3 s and the node has
  // fetched the video whole and seeds it (sharing on), or only serves it (sharing off).
  const video = $('v');
  $('a').value = test.a;
  try {
    await watch(test.a);
  } catch (e) {
    report('error', { error: String(e) });
    invoke('done', { ok: false });
    return;
  }
  const deadline = Date.now() + 150_000;
  const tick = setInterval(async () => {
    const rows = await refreshStatus().catch(() => []);
    const state = rows.find(([a]) => a === test.a)?.[1] ?? '';
    const settled = test.share ? state.startsWith('seeding') : state === 'serving';
    if (video.currentTime > 3 && settled) {
      clearInterval(tick);
      report(test.share ? 'played-and-seeding' : 'played-not-shared', { t: Math.round(video.currentTime * 10) / 10, state });
      // Stats for nerds: the seeder the bytes came from, then its address behind the switch.
      let ok = false;
      try {
        nerdOpen();
        await nerdRender();
        const peers = nerd.last ? nerd.last.sources : [];
        $('nerd-addresses').checked = true;
        $('nerd-addresses').dispatchEvent(new Event('change'));
        const routes = await invoke('nerd_addresses', { root: playing.root });
        const row = peers.find((p) => p.down > 0);
        const route = row && routes.find((r) => r.peer.startsWith(row.id));
        ok = Boolean(row && route && route.address && route.path !== 'unknown');
        report('nerd-check', { peers: peers.length, bytes: row ? row.down : 0, path: route ? route.path : null, addressShown: Boolean(route && route.address) });
        nerdClose();
      } catch (e) {
        report('nerd-error', { error: String(e) });
      }
      invoke('done', { ok });
    } else if (Date.now() > deadline) {
      clearInterval(tick);
      report('timeout', { t: video.currentTime, rows });
      invoke('done', { ok: false });
    }
  }, 1000);
})();
