// NFX desktop page. Bytes come from nfx:// (the node's verified origin); this page only
// plays them. Every DOM update goes through textContent.
const { invoke } = window.__TAURI__.core;
const base = navigator.userAgent.includes('Windows') ? 'http://nfx.localhost' : 'nfx://localhost';
const $ = (id) => document.getElementById(id);
const lines = (s) => s.split('\n').map((x) => x.trim()).filter(Boolean);
let hls = null;
let test = null;

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

$('play').addEventListener('click', () => watch($('a').value.trim()).catch((e) => say(String(e))));
$('save').addEventListener('click', async () => {
  try {
    await invoke('save_settings', {
      relays: lines($('relays').value),
      irohRelays: lines($('iroh').value),
      share: $('share').checked,
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
      invoke('done', { ok: true });
    } else if (Date.now() > deadline) {
      clearInterval(tick);
      report('timeout', { t: video.currentTime, rows });
      invoke('done', { ok: false });
    }
  }, 1000);
})();
