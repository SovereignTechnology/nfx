/**
 * Studio screen under jsdom against `MockNetworkAdapter` (allowed in tests, never in the
 * screen). Covers identity gating, tabs, the upload form + every progress stage, the ffmpeg
 * and web states, Videos, Analytics, Seeder (live status, unban, melt-out), price-before-play
 * ordering, navigation routes and cancellation on unmount.
 */
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { media, mocks } from '@sovit/core';
import type {
  NetworkAdapter,
  Page,
  SeederStatus,
  UploadInput,
  UploadProgress,
  VideoManifest,
} from '@sovit/core';
import { click, fire, keydown, render, type Rendered } from '../../../components/testing/render.js';
import type { Route } from '../../shared/route.js';
import { STUDIO_TABS, Studio, type StudioProps } from '../Studio.js';

const { MockNetworkAdapter, VIDEOS, MINTS, FIXTURE_NOW, ME } = mocks;

type Opts = ConstructorParameters<typeof MockNetworkAdapter>[0];

async function flush(rounds = 8): Promise<void> {
  await act(async () => {
    for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

function adapterWith(opts: Opts = {}): mocks.MockNetworkAdapter {
  return new MockNetworkAdapter({ now: () => FIXTURE_NOW, ...opts });
}

const rendered: Rendered[] = [];
let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.useRealTimers();
  consoleError = vi.spyOn(console, 'error');
});
afterEach(() => {
  for (const r of rendered.splice(0)) r.unmount();
  expect(consoleError).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

function mount(
  adapter: NetworkAdapter,
  props: Partial<Omit<StudioProps, 'adapter' | 'navigate'>> = {},
): { readonly r: Rendered; readonly navigate: ReturnType<typeof vi.fn<(to: Route) => void>> } {
  const navigate = vi.fn<(to: Route) => void>();
  const r = render(createElement(Studio, { adapter, navigate, now: FIXTURE_NOW, ...props }));
  rendered.push(r);
  return { r, navigate };
}

/** React-compatible typing: native value setter + `input` event. */
function typeInto(el: HTMLElement, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function pickFile(input: HTMLElement, file: File): void {
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  fire(input, new Event('change', { bubbles: true }));
}

function button(r: Rendered, text: string): HTMLButtonElement {
  const b = r.all('button').find((x) => x.textContent.trim() === text) as
    HTMLButtonElement | undefined;
  if (!b) throw new Error(`no button "${text}"`);
  return b;
}

function hasButton(r: Rendered, text: string): boolean {
  return r.all('button').some((x) => x.textContent.trim() === text);
}

function precedes(a: Element, b: Element): boolean {
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

const FILE = {
  source: '/home/creator/Videos/hohmann-final.mp4',
  name: 'hohmann-final.mp4',
  size: 12_000_000,
  type: 'video/mp4',
};

/** Studio on the Upload tab with a file handed over and settings loaded. */
async function withForm(
  adapter: NetworkAdapter,
  props: Partial<Omit<StudioProps, 'adapter' | 'navigate'>> = {},
): Promise<ReturnType<typeof mount>> {
  const m = mount(adapter, { tab: 'upload', pendingFile: FILE, ...props });
  await flush();
  return m;
}

function scripted(
  a: mocks.MockNetworkAdapter,
  script: (input: UploadInput, onProgress: (p: UploadProgress) => void) => Promise<VideoManifest>,
): ReturnType<typeof vi.fn> {
  const fn = vi.fn(script);
  a.studio = { ...a.studio, upload: fn };
  return fn;
}

const never = (): Promise<VideoManifest> => new Promise<VideoManifest>(() => undefined);

// ---------------------------------------------------------------------------------------

describe('Studio — identity and structure', () => {
  it('renders a landmark, the h1, four tabs and a busy skeleton while identity loads', () => {
    const { r } = mount(adapterWith({ latencyMs: 5000 }));
    expect(r.get('section[aria-labelledby]')).toBeTruthy();
    expect(r.get('h1').textContent).toBe('Studio');
    const tabs = r.all('[role="tab"]');
    expect(tabs.map((t) => t.textContent)).toEqual(STUDIO_TABS.map((t) => t.label));
    expect(r.get('[role="tab"][aria-selected="true"]').textContent).toBe('Upload');
    expect(r.get('[role="tabpanel"]').getAttribute('aria-busy')).toBe('true');
    expect(r.all('.nf-skeleton').length).toBeGreaterThan(0);
  });

  it('signed out: only the signer state, Connect signer → settings', async () => {
    const a = adapterWith({ signedIn: false });
    const upload = vi.spyOn(a.studio, 'upload');
    const { r, navigate } = mount(a, { tab: 'seeder' });
    await flush();
    expect(r.all('[role="tablist"]')).toHaveLength(0);
    const state = r.get('[role="status"]');
    expect(state.getAttribute('data-preset')).toBe('signer-not-detected');
    expect(state.textContent).toContain('Sign in to use Studio');
    click(button(r, 'Connect signer'));
    expect(navigate).toHaveBeenCalledWith({ name: 'settings' });
    expect(upload).not.toHaveBeenCalled();
  });

  it('no-signer behaves as signed out', async () => {
    const { r } = mount(adapterWith({ failWith: 'no-signer' }));
    await flush();
    expect(r.get('[role="status"]').textContent).toContain('Sign in to use Studio');
  });

  it('relay-down on me(): alert with copy + detail, Retry asks again, nothing thrown', async () => {
    const a = adapterWith({ failWith: 'relay-down' });
    const me = vi.spyOn(a, 'me');
    const { r } = mount(a);
    await flush();
    const alert = r.get('[role="alert"]');
    expect(alert.textContent).toContain('Relay down');
    expect(alert.textContent).toContain('relay-down: no relays reachable');
    click(button(r, 'Retry'));
    await flush();
    expect(me).toHaveBeenCalledTimes(2);
  });
});

describe('Studio — tabs', () => {
  it('navigates on click, roves with the keyboard and follows the tab prop', async () => {
    const a = adapterWith();
    const { r, navigate } = mount(a);
    await flush();
    click(button(r, 'Videos'));
    expect(navigate).toHaveBeenLastCalledWith({ name: 'studio', tab: 'videos' });
    expect(r.get('[role="tab"][aria-selected="true"]').textContent).toBe('Videos');
    const selected = r.get('[role="tab"][aria-selected="true"]');
    selected.focus();
    keydown(selected, 'ArrowRight');
    expect(navigate).toHaveBeenLastCalledWith({ name: 'studio', tab: 'analytics' });
    keydown(r.get('[role="tab"][aria-selected="true"]'), 'End');
    expect(navigate).toHaveBeenLastCalledWith({ name: 'studio', tab: 'seeder' });
    keydown(r.get('[role="tab"][aria-selected="true"]'), 'ArrowRight');
    expect(navigate).toHaveBeenLastCalledWith({ name: 'studio', tab: 'upload' });
    expect(r.all('[role="tab"][tabindex="0"]')).toHaveLength(1);
    const panel = r.get('[role="tabpanel"]');
    expect(panel.getAttribute('aria-labelledby')).toBe(
      r.get('[role="tab"][aria-selected="true"]').id,
    );
    r.rerender(createElement(Studio, { adapter: a, navigate, now: FIXTURE_NOW, tab: 'seeder' }));
    await flush();
    expect(r.get('[role="tab"][aria-selected="true"]').textContent).toBe('Seeder');
  });
});

describe('Studio — choosing a file', () => {
  it('desktop: resolveFile maps the DOM File to a path and the title defaults to the name', async () => {
    const a = adapterWith();
    const upload = vi.spyOn(a.studio, 'upload');
    const resolveFile = vi.fn((f: File) => Promise.resolve(`/abs/${f.name}`));
    const { r } = mount(a, { tab: 'upload', resolveFile });
    await flush();
    expect(r.get('.nf-studio__drop h2').textContent).toContain('Drag and drop');
    const file = new File(['x'], 'Orbit Day 3.mp4', { type: 'video/mp4' });
    pickFile(r.get('input[type="file"]'), file);
    await flush();
    expect(resolveFile).toHaveBeenCalledWith(file);
    expect((r.get('input[name="title"]') as HTMLInputElement).value).toBe('Orbit Day 3');
    click(r.get('button[type="submit"]'));
    await flush();
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0]?.[0].file).toBe('/abs/Orbit Day 3.mp4');
  });

  it('web: without resolveFile the File itself (a FileLike) is uploaded', async () => {
    const a = adapterWith();
    const upload = vi.spyOn(a.studio, 'upload');
    const { r } = mount(a, { tab: 'upload' });
    await flush();
    const file = new File(['x'], 'clip.webm', { type: 'video/webm' });
    pickFile(r.get('input[type="file"]'), file);
    await flush();
    click(r.get('button[type="submit"]'));
    await flush();
    expect(upload.mock.calls[0]?.[0].file).toBe(file);
  });

  it('accepts a dropped file and rejects a non-video one with copy', async () => {
    const { r } = mount(adapterWith(), { tab: 'upload' });
    await flush();
    const drop = (f: File): void => {
      const ev = new Event('drop', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'dataTransfer', { value: { files: [f] } });
      fire(r.get('.nf-studio__drop'), ev);
    };
    drop(new File(['x'], 'notes.pdf', { type: 'application/pdf' }));
    await flush();
    expect(r.get('.nf-studio__drop [role="alert"]').textContent).toContain(
      'does not look like a video',
    );
    drop(new File(['x'], 'raw.mkv', { type: '' }));
    await flush();
    expect((r.get('input[name="title"]') as HTMLInputElement).value).toBe('raw');
  });

  it('a resolver that fails leaves the drop zone with an error, nothing thrown', async () => {
    const { r } = mount(adapterWith(), {
      tab: 'upload',
      resolveFile: () => Promise.reject(new Error('no path')),
    });
    await flush();
    pickFile(r.get('input[type="file"]'), new File(['x'], 'a.mp4', { type: 'video/mp4' }));
    await flush();
    expect(r.get('[role="alert"]').textContent).toContain('could not open that file');
    expect(r.all('form')).toHaveLength(0);
  });
});

describe('Studio — details form', () => {
  it('pre-selects Settings.defaultMints and offers wallet mints', async () => {
    const { r } = await withForm(adapterWith());
    const chips = r.all('.nf-studio__mints button.nf-mint');
    const pressed = chips.filter((c) => c.getAttribute('aria-pressed') === 'true');
    expect(pressed.map((c) => c.getAttribute('title'))).toEqual([MINTS.a]);
    expect(chips.map((c) => c.getAttribute('title'))).toContain(MINTS.b);
  });

  it('renders the description through Markdown in the preview (hostile HTML stays text)', async () => {
    const { r } = await withForm(adapterWith());
    typeInto(r.get('textarea[name="description"]'), '**bold** <img src=x onerror=alert(1)>');
    const preview = r.get('.nf-studio__preview');
    expect(preview.querySelector('strong')?.textContent).toBe('bold');
    expect(preview.querySelector('img')).toBeNull();
    expect(preview.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('links the split fields to 100 and shows the seeder-rounds-up rule', async () => {
    const { r } = await withForm(adapterWith());
    typeInto(r.get('input[name="seeder"]'), '70');
    expect((r.get('input[name="creator"]') as HTMLInputElement).value).toBe('30');
    typeInto(r.get('input[name="creator"]'), '50');
    expect((r.get('input[name="seeder"]') as HTMLInputElement).value).toBe('50');
    const rows = r.all('.nf-studio__split-table tbody tr');
    // 1 block at 1 sat, 50/50: ceil(0.5) = 1 to seeders, 0 to you.
    expect(rows[0]?.querySelectorAll('td')[0]?.textContent).toBe('1 sat');
    expect(rows[0]?.querySelectorAll('td')[1]?.textContent).toBe('0 sats');
    expect(rows[1]?.querySelectorAll('td')[0]?.textContent).toBe('5 sats');
    expect(r.get('.nf-studio__form').textContent).toContain('share is rounded up');
    typeInto(r.get('input[name="seeder"]'), '0');
    expect(r.get('.nf-studio__warn').textContent).toContain('nobody is paid');
  });

  it('shows the per-minute estimate at the standard encode rates, per price', async () => {
    const { r } = await withForm(adapterWith());
    const text = (): string => r.get('.nf-studio__estimate').textContent;
    expect(text()).toContain('1080p');
    expect(text()).toContain('about 587 sats per minute');
    expect(text()).toContain('about 301 sats per minute');
    expect(text()).toContain('about 103 sats per minute');
    typeInto(r.get('input[name="price"]'), '2');
    expect(text()).toContain('about 1,174 sats per minute');
    expect(text()).toContain('measured after transcoding');
  });

  it('validates on submit: marks fields, focuses the first, never calls upload', async () => {
    const a = adapterWith();
    const upload = vi.spyOn(a.studio, 'upload');
    const { r } = await withForm(a);
    typeInto(r.get('input[name="title"]'), '   ');
    typeInto(r.get('input[name="price"]'), '0');
    typeInto(r.get('input[name="seeder"]'), '120');
    click(r.get('.nf-studio__mints button[aria-pressed="true"]'));
    click(r.get('button[type="submit"]'));
    await flush();
    expect(upload).not.toHaveBeenCalled();
    expect(r.get('input[name="title"]').getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(r.get('input[name="title"]'));
    const text = r.get('form').textContent;
    expect(text).toContain('Add a title.');
    expect(text).toContain('whole number of sats from 1');
    expect(text).toContain('add up to 100');
    expect(text).toContain('Pick at least one mint');
    expect(r.get('.nf-studio__form-actions [role="alert"]').textContent).toContain('Fix 4 things');
  });

  it('adds a mint by URL (https only, normalised) and selects it', async () => {
    const { r } = await withForm(adapterWith());
    const input = r.get('input[placeholder="https://mint.example"]');
    typeInto(input, 'http://plain.example');
    click(button(r, 'Add mint'));
    expect(r.get('.nf-studio__form').textContent).toContain('starts with https://');
    typeInto(input, 'https://new-mint.example/');
    click(button(r, 'Add mint'));
    const chip = r.get('.nf-studio__mints button[title="https://new-mint.example"]');
    expect(chip.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('Studio — publishing', () => {
  it('sends exactly the form to studio.upload and lands on Published', async () => {
    const a = adapterWith();
    const upload = vi.spyOn(a.studio, 'upload');
    const { r, navigate } = await withForm(a, {
      mirrorServers: ['https://blossom.fixture.example'],
    });
    typeInto(r.get('input[name="title"]'), 'Hohmann, explained');
    typeInto(r.get('textarea[name="description"]'), 'With a *hose*.');
    typeInto(r.get('input[name="tags"]'), 'Space, #physics, orbital mechanics, space');
    click(r.get('input[name="kind"][value="22"]'));
    typeInto(r.get('input[name="price"]'), '3');
    typeInto(r.get('input[name="seeder"]'), '40');
    click(r.get('button[type="submit"]'));
    await flush();
    expect(upload).toHaveBeenCalledTimes(1);
    const input = upload.mock.calls[0]?.[0];
    expect(input).toEqual({
      file: FILE.source,
      title: 'Hohmann, explained',
      description: 'With a *hose*.',
      tags: ['space', 'physics', 'orbital-mechanics'],
      kind: 22,
      mints: [MINTS.a],
      satsPerBlock: 3,
      split: { seeder: 40, creator: 60 },
      mirrorTo: ['https://blossom.fixture.example'],
    });
    const done = r.get('.nf-studio__published');
    expect(done.textContent).toContain('Published');
    expect(done.textContent).toContain('seeders 40%, you 60%');
    // Every rendition's price is shown before the control that opens the video.
    const view = button(r, 'View in Shorts');
    const prices = Array.from(done.querySelectorAll('.nf-sats--price'));
    expect(prices.length).toBeGreaterThan(0);
    for (const p of prices) expect(precedes(p, view)).toBe(true);
    click(view);
    expect(navigate).toHaveBeenLastCalledWith({
      name: 'shorts',
      videoId: mocks.asEventId('upload:Hohmann, explained'),
    });
    expect(r.all('.nf-studio__mirrors li[data-ok="true"]')).toHaveLength(1);
    click(button(r, 'Upload another'));
    expect(r.get('.nf-studio__drop')).toBeTruthy();
  });

  it('passes a custom thumbnail as thumbnailChoice', async () => {
    const a = adapterWith();
    const upload = vi.spyOn(a.studio, 'upload');
    const { r } = await withForm(a);
    click(r.all('input[name="thumbnail"]')[1]!);
    const image = new File(['png'], 'cover.png', { type: 'image/png' });
    pickFile(r.get('.nf-studio__fieldset input[type="file"]'), image);
    expect(r.get('form').textContent).toContain('cover.png');
    click(r.get('button[type="submit"]'));
    await flush();
    expect(upload.mock.calls[0]?.[0].thumbnailChoice).toBe(image);
  });

  it('mid-transcode: per-stage steps, per-rendition bars, live text; survives tab switches', async () => {
    const a = adapterWith();
    const upload = scripted(a, (_i, onProgress) => {
      onProgress({ stage: 'probing' });
      onProgress({ stage: 'transcoding', rendition: '1080p', percent: 100 });
      onProgress({ stage: 'transcoding', rendition: '720p', percent: 62 });
      return never();
    });
    const { r } = await withForm(a);
    click(r.get('button[type="submit"]'));
    await flush();
    const STEP_IDS = ['probe', 'transcode', 'thumbnails', 'write', 'publish'];
    const status = (id: string): string | null => {
      const steps = r.all('.nf-studio__step');
      return steps[STEP_IDS.indexOf(id)]?.getAttribute('data-status') ?? null;
    };
    expect(status('probe')).toBe('done');
    expect(status('transcode')).toBe('active');
    expect(status('thumbnails')).toBe('pending');
    const bars = r.all('progress');
    expect(bars.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Transcoding 1080p',
      'Transcoding 720p',
    ]);
    expect((bars[1] as HTMLProgressElement).value).toBe(62);
    expect(r.get('[aria-live="polite"]').textContent).toBe('Transcoding 720p');
    expect(r.get('.nf-studio__run').textContent).toContain('cannot be stopped');
    click(button(r, 'Seeder'));
    await flush();
    expect(r.get('.nf-studio__run-chip').textContent).toBe('Transcoding 720p · 62%');
    click(r.get('.nf-studio__run-chip'));
    expect(r.all('.nf-studio__step')).toHaveLength(5);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it('thumbnail candidates go through adapter.image; the first is marked', async () => {
    const a = adapterWith();
    const image = vi.spyOn(a, 'image');
    scripted(a, (_i, onProgress) => {
      onProgress({ stage: 'thumbnails', candidates: ['/tmp/w/t0.jpg', '/tmp/w/t1.jpg'] });
      return never();
    });
    const { r } = await withForm(a);
    click(r.get('button[type="submit"]'));
    await flush();
    expect(image).toHaveBeenCalledWith('/tmp/w/t0.jpg', undefined);
    expect(image).toHaveBeenCalledWith('/tmp/w/t1.jpg', undefined);
    const items = r.all('.nf-studio__candidate');
    expect(items[0]?.classList.contains('is-used')).toBe(true);
    expect(items[0]?.textContent).toContain('Thumbnail');
    expect(items[1]?.classList.contains('is-used')).toBe(false);
    expect(r.get('.nf-studio__candidates img').getAttribute('src')).toBe('/tmp/w/t0.jpg');
  });

  it('a failed transcode shows the error; Try again re-runs, Edit details keeps the form', async () => {
    const a = adapterWith();
    const upload = scripted(a, (_i, onProgress) => {
      onProgress({ stage: 'probing' });
      onProgress({ stage: 'transcoding', rendition: '1080p', percent: 40 });
      const err = new media.MediaError('process-failed', 'transcode 1080p: exit 1');
      onProgress({ stage: 'error', message: err.message });
      return Promise.reject(err);
    });
    const { r } = await withForm(a);
    typeInto(r.get('input[name="title"]'), 'Keep me');
    click(r.get('button[type="submit"]'));
    await flush();
    const alert = r.get('[role="alert"]');
    expect(alert.textContent).toContain('Transcoding failed');
    expect(alert.textContent).toContain('transcode 1080p: exit 1');
    expect(r.all('.nf-studio__step')[1]?.getAttribute('data-status')).toBe('error');
    click(button(r, 'Try again'));
    await flush();
    expect(upload).toHaveBeenCalledTimes(2);
    click(button(r, 'Edit details'));
    expect((r.get('input[name="title"]') as HTMLInputElement).value).toBe('Keep me');
  });

  it('a relay failure at publish time is worded as "could not publish"', async () => {
    const a = adapterWith();
    scripted(a, (_i, onProgress) => {
      onProgress({ stage: 'publishing' });
      return Promise.reject(new Error('relay-down: no relays reachable'));
    });
    const { r } = await withForm(a);
    click(r.get('button[type="submit"]'));
    await flush();
    expect(r.get('[role="alert"]').textContent).toContain('Could not publish');
    expect(r.all('.nf-studio__step')[4]?.getAttribute('data-status')).toBe('error');
  });

  it('unmount mid-upload: late progress and settle update nothing', async () => {
    const a = adapterWith();
    let push: ((p: UploadProgress) => void) | undefined;
    let settle: ((v: VideoManifest) => void) | undefined;
    scripted(a, (_i, onProgress) => {
      push = onProgress;
      return new Promise<VideoManifest>((res) => {
        settle = res;
      });
    });
    const { r } = await withForm(a);
    click(r.get('button[type="submit"]'));
    await flush();
    r.unmount();
    rendered.splice(rendered.indexOf(r), 1);
    act(() => {
      push?.({ stage: 'transcoding', rendition: '720p', percent: 90 });
      settle?.(VIDEOS[0]!);
    });
    await flush();
    expect(r.container.innerHTML).toBe('');
  });
});

describe('Studio — ffmpeg not found', () => {
  it('a pre-probe shows the state before the form, with install steps and Settings', async () => {
    const recheck = vi.fn();
    const { r, navigate } = mount(adapterWith(), {
      tab: 'upload',
      ffmpeg: { found: false, path: '/usr/local/bin/ffmpeg', os: 'linux' },
      onRecheckFfmpeg: recheck,
    });
    await flush();
    expect(r.all('form')).toHaveLength(0);
    expect(r.all('.nf-studio__drop')).toHaveLength(0);
    const state = r.get('.nf-studio__ffmpeg');
    expect(state.querySelector('h3')?.textContent).toBe('ffmpeg not found');
    expect(state.textContent).toContain('/usr/local/bin/ffmpeg');
    expect(r.all('.nf-studio__os')[0]?.getAttribute('data-os')).toBe('linux');
    expect(state.textContent).toContain('sudo apt install ffmpeg');
    expect(state.querySelector('details .nf-studio__os[data-os="macos"]')).toBeTruthy();
    click(button(r, 'Set ffmpeg path in Settings'));
    expect(navigate).toHaveBeenCalledWith({ name: 'settings' });
    click(button(r, 'Check again'));
    expect(recheck).toHaveBeenCalledTimes(1);
  });

  it('an upload rejected with ffmpeg-not-found shows the same guidance as an alert', async () => {
    const a = adapterWith();
    const upload = scripted(a, (_i, onProgress) => {
      onProgress({ stage: 'probing' });
      const err = new media.MediaError(
        'ffmpeg-not-found',
        'ffprobe: could not spawn ffprobe (ENOENT)',
      );
      onProgress({ stage: 'error', message: err.message });
      return Promise.reject(err);
    });
    const { r } = await withForm(a);
    click(r.get('button[type="submit"]'));
    await flush();
    const alert = r.get('.nf-studio__ffmpeg[role="alert"]');
    expect(alert.textContent).toContain('ffmpeg not found');
    expect(alert.textContent).toContain('could not spawn ffprobe (ENOENT)');
    expect(alert.textContent).toContain('brew install ffmpeg');
    expect(alert.textContent).toContain('winget install Gyan.FFmpeg');
    click(button(r, 'Try again'));
    await flush();
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it('recognises it from the message alone when an IPC hop stripped the code', async () => {
    const a = adapterWith();
    scripted(a, () =>
      Promise.reject(
        new Error('Error invoking remote method: ffmpeg: could not spawn ffmpeg (ENOENT)'),
      ),
    );
    const { r } = await withForm(a);
    click(r.get('button[type="submit"]'));
    await flush();
    expect(r.get('.nf-studio__ffmpeg[role="alert"]')).toBeTruthy();
  });
});

describe('Studio — web platform', () => {
  it('shows the gateway notice on web only (copy, not logic)', async () => {
    const web = new Proxy(adapterWith(), {
      get(target, prop, receiver): unknown {
        if (prop === 'platform') return 'web';
        const v: unknown = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(target) : v;
      },
    });
    const w = mount(web, { tab: 'upload' });
    await flush();
    expect(w.r.get('[role="note"]').textContent).toContain('Your gateway stores web uploads as-is');
    const d = mount(adapterWith(), { tab: 'upload' });
    await flush();
    expect(d.r.all('[role="note"]')).toHaveLength(0);
  });
});

describe('Studio — videos', () => {
  it('lists myVideos with verified thumbnails, stats, and price before View', async () => {
    const a = adapterWith();
    const image = vi.spyOn(a, 'image');
    const stats = vi.spyOn(a, 'stats');
    const { r, navigate } = mount(a, { tab: 'videos' });
    await flush();
    const page = await a.studio.myVideos();
    const rows = r.all('tbody tr');
    expect(rows).toHaveLength(page.items.length);
    for (const v of page.items) {
      const img = v.renditions[0]?.image;
      expect(image).toHaveBeenCalledWith(img?.url, img?.sha256);
      expect(stats).toHaveBeenCalledWith(v.id);
    }
    rows.forEach((row) => {
      const price = row.querySelector('.nf-sats--price');
      const view = Array.from(row.querySelectorAll('button')).find((b) => b.textContent === 'View');
      expect(price && view && precedes(price, view)).toBe(true);
    });
    const first = page.items[0]!;
    expect(rows[0]?.textContent).toContain(`${(await a.stats(first.id)).paidViews}`);
    click(r.get(`button[aria-label="View ${first.title}"]`));
    expect(navigate).toHaveBeenLastCalledWith(
      first.kind === 22
        ? { name: 'shorts', videoId: first.id }
        : { name: 'watch', videoId: first.id },
    );
    const second = page.items[1]!;
    const analytics = vi.spyOn(a.studio, 'analytics');
    click(r.get(`button[aria-label="Analytics for ${second.title}"]`));
    await flush();
    expect(navigate).toHaveBeenLastCalledWith({ name: 'studio', tab: 'analytics' });
    expect(analytics).toHaveBeenLastCalledWith(second.id);
  });

  it('empty: "Upload your first video" switches to Upload', async () => {
    const a = adapterWith();
    a.studio = { ...a.studio, myVideos: () => Promise.resolve({ items: [] }) };
    const { r, navigate } = mount(a, { tab: 'videos' });
    await flush();
    expect(r.get('[role="status"]').textContent).toContain('Upload your first video');
    click(button(r, 'Upload a video'));
    expect(navigate).toHaveBeenLastCalledWith({ name: 'studio', tab: 'upload' });
  });

  it('pages with Show more (cursor) and reports a failed page inline', async () => {
    const a = adapterWith();
    const all = VIDEOS.slice(0, 5);
    let fail = true;
    const myVideos = vi.fn((cursor?: string): Promise<Page<VideoManifest>> => {
      if (cursor === '2' && fail) {
        fail = false;
        return Promise.reject(new Error('relay-down: timeout'));
      }
      const start = cursor ? Number(cursor) : 0;
      const items = all.slice(start, start + 2);
      return Promise.resolve(
        start + 2 < all.length ? { items, next: String(start + 2) } : { items },
      );
    });
    a.studio = { ...a.studio, myVideos };
    const { r } = mount(a, { tab: 'videos' });
    await flush();
    expect(r.all('tbody tr')).toHaveLength(2);
    click(button(r, 'Show more'));
    await flush();
    expect(r.get('[role="alert"]').textContent).toContain('Could not load more');
    click(button(r, 'Retry'));
    await flush();
    expect(myVideos).toHaveBeenLastCalledWith('2');
    expect(r.all('tbody tr')).toHaveLength(4);
    click(button(r, 'Show more'));
    await flush();
    expect(r.all('tbody tr')).toHaveLength(5);
    expect(hasButton(r, 'Show more')).toBe(false);
  });

  it('a failed first load is an error with Retry', async () => {
    const a = adapterWith();
    let calls = 0;
    a.studio = {
      ...a.studio,
      myVideos: () => {
        calls++;
        return calls === 1
          ? Promise.reject(new Error('relay-down: no relays reachable'))
          : Promise.resolve({ items: [] });
      },
    };
    const { r } = mount(a, { tab: 'videos' });
    await flush();
    expect(r.get('[role="alert"]').textContent).toContain('Relay down');
    click(button(r, 'Retry'));
    await flush();
    expect(r.get('[role="status"]').textContent).toContain('Upload your first video');
  });
});

describe('Studio — analytics', () => {
  it('shows totals and sats by rendition in rendition order with shares', async () => {
    const a = adapterWith();
    const analytics = vi.spyOn(a.studio, 'analytics');
    const { r, navigate } = mount(a, { tab: 'analytics' });
    await flush();
    const page = await a.studio.myVideos();
    const first = page.items[0]!;
    expect(analytics).toHaveBeenCalledWith(first.id);
    const data = await a.studio.analytics(first.id);
    const tiles = r.get('.nf-studio__tiles').textContent;
    expect(tiles).toContain(`Paid views${data.paidViews}`);
    expect(tiles).toContain(`Seeders online${data.seedersOnline}`);
    const rows = r.all('.nf-studio__bars-row');
    expect(rows.map((x) => x.querySelector('.nf-studio__bar-label')?.textContent)).toEqual([
      '1080p',
      '720p',
      '360p',
    ]);
    expect(rows[0]?.querySelector('.nf-studio__bar-pct')?.textContent).toBe('60%');
    const fill = rows[0]?.querySelector<HTMLElement>('.nf-studio__bar-fill');
    expect(parseFloat(fill?.style.width ?? '')).toBe(100);
    // price before the View button
    const head = r.get('.nf-studio__video-head');
    const price = head.querySelector('.nf-sats--price');
    expect(price && precedes(price, button(r, 'View video'))).toBe(true);
    click(button(r, 'View video'));
    expect(navigate).toHaveBeenLastCalledWith({ name: 'watch', videoId: first.id });
    const select = r.get('select') as HTMLSelectElement;
    const second = page.items[1]!;
    act(() => {
      select.value = second.id;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    expect(analytics).toHaveBeenLastCalledWith(second.id);
    expect(r.get('.nf-studio__video-head h2').textContent).toBe(second.title);
  });

  it('no seeders online: a warning state that opens the Seeder tab', async () => {
    const { r, navigate } = mount(adapterWith({ failWith: 'no-seeders' }), { tab: 'analytics' });
    await flush();
    expect(r.get('[data-preset="no-seeders-online"]').textContent).toContain('No seeders online');
    click(button(r, 'Open Seeder'));
    await flush();
    expect(navigate).toHaveBeenLastCalledWith({ name: 'studio', tab: 'seeder' });
  });

  it('unmount while analytics loads sets nothing', async () => {
    const a = adapterWith();
    let resolve: (() => void) | undefined;
    const orig = a.studio.analytics;
    a.studio = {
      ...a.studio,
      analytics: (id) =>
        new Promise((res) => {
          resolve = () => {
            void orig(id).then(res);
          };
        }),
    };
    const { r } = mount(a, { tab: 'analytics' });
    await flush();
    r.unmount();
    rendered.splice(rendered.indexOf(r), 1);
    resolve?.();
    await flush();
    expect(r.container.innerHTML).toBe('');
  });
});

describe('Studio — seeder', () => {
  it('subscribes to onStatus, follows it live, and unsubscribes on unmount', async () => {
    const a = adapterWith();
    const off = vi.fn();
    const orig = a.seeder.onStatus;
    const onStatus = vi.fn((cb: (s: SeederStatus) => void) => {
      const un = orig(cb);
      return () => {
        off();
        un();
      };
    });
    const setEnabled = vi.spyOn(a.seeder, 'setEnabled');
    a.seeder = { ...a.seeder, onStatus };
    const { r } = mount(a, { tab: 'seeder' });
    await flush();
    expect(onStatus).toHaveBeenCalledTimes(1);
    expect(r.get('.nf-studio__seed-state').textContent).toContain('On — streaming');
    click(button(r, 'Turn off seeding'));
    await flush();
    expect(setEnabled).toHaveBeenCalledWith(false);
    expect(r.get('.nf-studio__seed-state').textContent).toContain('Off');
    expect(hasButton(r, 'Turn on seeding')).toBe(true);
    r.unmount();
    rendered.splice(rendered.indexOf(r), 1);
    expect(off).toHaveBeenCalledTimes(1);
  });

  it('shows earnings total, unswapped, by mint, and connected peers', async () => {
    const { r } = mount(adapterWith(), { tab: 'seeder' });
    await flush();
    const text = r.get('.nf-studio__seeder').textContent;
    expect(text).toContain('48,210 sats');
    expect(text).toContain('320 sats');
    expect(r.all('.nf-studio__by-mint li')).toHaveLength(2);
    expect(r.all('.nf-studio__seeder tbody tr')).toHaveLength(2);
    expect(text).toContain('2 of 4');
  });

  it('lists banned peers with reason copy and unbans', async () => {
    const a = adapterWith();
    const unban = vi.spyOn(a.seeder, 'unban');
    const { r } = mount(a, { tab: 'seeder' });
    await flush();
    const rows = r.all('.nf-studio__banned-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain('Took more blocks than the unpaid window allows');
    click(button(r, 'Unban'));
    await flush();
    expect(unban).toHaveBeenCalledWith(mocks.asPubkey('freeloader'));
    expect(r.all('.nf-studio__banned-row')).toHaveLength(0);
    expect(r.get('.nf-studio__seeder').textContent).toContain('No banned peers.');
  });

  it('melt-out: validates, quotes, confirms in a Sheet and shows paid', async () => {
    const a = adapterWith();
    const quote = vi.spyOn(a.wallet, 'meltQuote');
    const melt = vi.spyOn(a.seeder, 'melt');
    const { r } = mount(a, { tab: 'seeder' });
    await flush();
    const invoice = r.get('textarea.nf-studio__mono');
    typeInto(invoice, 'not an invoice');
    click(button(r, 'Review melt-out'));
    expect(r.get('.nf-studio__seeder').textContent).toContain('Paste a Lightning invoice');
    expect(quote).not.toHaveBeenCalled();
    const bolt11 = `lightning:LNBC1500N1P${'Q'.repeat(40)}`;
    typeInto(invoice, bolt11);
    click(button(r, 'Review melt-out'));
    await flush();
    const normalized = `lnbc1500n1p${'q'.repeat(40)}`;
    expect(quote).toHaveBeenCalledWith(MINTS.a, normalized);
    const dialog = r.get('[role="dialog"]');
    expect(dialog.textContent).toContain('1,500 sats');
    expect(dialog.textContent).toContain('15 sats');
    expect(dialog.textContent).toContain('1,515 sats');
    expect(melt).not.toHaveBeenCalled();
    click(button(r, 'Melt out 1,500 sats'));
    await flush();
    expect(melt).toHaveBeenCalledWith(MINTS.a, normalized);
    expect(r.get('[role="dialog"] [role="status"]').textContent).toContain('Paid');
    click(button(r, 'Done'));
    expect(r.all('[role="dialog"]')).toHaveLength(0);
  });

  it('melt-out with no balance: "Not paid", nothing thrown', async () => {
    const { r } = mount(adapterWith({ failWith: 'no-balance' }), { tab: 'seeder' });
    await flush();
    typeInto(r.get('textarea.nf-studio__mono'), `lnbc1500n1p${'q'.repeat(40)}`);
    click(button(r, 'Review melt-out'));
    await flush();
    click(button(r, 'Melt out 1,500 sats'));
    await flush();
    expect(r.get('[role="dialog"] [role="alert"]').textContent).toContain('Not paid');
  });

  it('picks another mint for the melt and a failed quote offers Try again', async () => {
    const a = adapterWith();
    const quote = vi.spyOn(a.wallet, 'meltQuote').mockRejectedValueOnce(new Error('expired'));
    const { r } = mount(a, { tab: 'seeder' });
    await flush();
    click(r.get(`.nf-studio__mints button[title="${MINTS.b}"]`));
    typeInto(r.get('textarea.nf-studio__mono'), `lnbc100n1p${'q'.repeat(40)}`);
    click(button(r, 'Review melt-out'));
    await flush();
    expect(quote).toHaveBeenLastCalledWith(MINTS.b, `lnbc100n1p${'q'.repeat(40)}`);
    expect(r.get('[role="dialog"]').textContent).toContain('could not quote');
    click(button(r, 'Try again'));
    await flush();
    expect(r.get('[role="dialog"]').textContent).toContain('Invoice amount');
  });

  it('a failed status() is an error with Retry', async () => {
    const a = adapterWith();
    let calls = 0;
    const orig = a.seeder.status;
    a.seeder = {
      ...a.seeder,
      status: () => (++calls === 1 ? Promise.reject(new Error('seeder offline')) : orig()),
    };
    const { r } = mount(a, { tab: 'seeder' });
    await flush();
    expect(r.get('[role="alert"]').textContent).toContain('Could not load your seeder');
    click(button(r, 'Retry'));
    await flush();
    expect(r.get('.nf-studio__seed-state')).toBeTruthy();
  });
});

describe('Studio — shell slot', () => {
  it('renders the mini-player node', async () => {
    const { r } = mount(adapterWith(), {
      miniPlayer: createElement('div', { id: 'mini' }, 'mini'),
    });
    await flush();
    expect(r.get('.nf-studio__mini #mini')).toBeTruthy();
    expect(ME).toBeTruthy();
    expect(FIXTURE_NOW).toBeGreaterThan(0);
  });
});
