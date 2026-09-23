/**
 * Browser playback check for the spike player (S4; reused by S2/S3). Playwright's own
 * browsers, fresh headless contexts: never a real browser profile.
 *
 * Usage: npx tsx play.ts <base-url> <root> [chromium,firefox,webkit]
 * Per browser: play → currentTime > 2.5 s, seek to 7 s → plays on, switch to the lowest
 * rendition → LEVEL_SWITCHED and playback continues.
 */
import { chromium, firefox, webkit, type BrowserType, type Page } from 'playwright';

const [base, root, which] = process.argv.slice(2);
if (!base || !root) {
  console.error('usage: play.ts <base-url> <root> [browsers]');
  process.exit(2);
}
const engines: Record<string, BrowserType> = { chromium, firefox, webkit };
const names = (which ?? 'chromium,firefox,webkit').split(',');

interface NfxState {
  engine: string | null;
  ready: boolean;
  levels: { height: number; bitrate: number; codecs?: string }[];
  switched: number[];
  errors: string[];
  mse: Record<string, boolean | null>;
}
const state = (page: Page): Promise<NfxState> => page.evaluate(() => (window as unknown as { __nfx: NfxState }).__nfx);
const time = (page: Page): Promise<number> => page.evaluate(() => (document.getElementById('v') as HTMLVideoElement).currentTime);
async function until(page: Page, what: string, cond: () => Promise<boolean>, ms = 25_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await page.waitForTimeout(250);
  }
  const s = await state(page);
  throw new Error(`timeout waiting for ${what} (t=${await time(page)}, errors=${JSON.stringify(s.errors)})`);
}

let failed = 0;
for (const name of names) {
  const engine = engines[name];
  if (!engine) throw new Error(`unknown browser ${name}`);
  const steps: string[] = [];
  let browser;
  try {
    browser = await engine.launch({ headless: true });
    const context = await browser.newContext(); // fresh, in-memory profile
    const page = await context.newPage();
    await page.goto(`${base}/player/?root=${root}`);
    await until(page, 'manifest', async () => {
      const s = await state(page);
      return s.ready || s.errors.length > 0;
    });
    const s0 = await state(page);
    steps.push(`engine ${s0.engine}; MSE H.264 High ${JSON.stringify(s0.mse)}`);
    if (!s0.ready) throw new Error(`not ready: ${s0.errors.join('; ')}`);
    steps.push(`levels ${s0.levels.map((l) => `${l.height}p`).join(' ')}`);

    await until(page, 'playback past 2.5 s', async () => (await time(page)) > 2.5);
    steps.push(`played to ${(await time(page)).toFixed(2)} s`);

    await page.evaluate(() => { (document.getElementById('v') as HTMLVideoElement).currentTime = 7; });
    await until(page, 'playback after seek', async () => (await time(page)) > 7.6);
    steps.push(`seek to 7 s -> ${(await time(page)).toFixed(2)} s`);

    const lowest = s0.levels.reduce((best, l, i, all) => (l.height < (all[best]?.height ?? Infinity) ? i : best), 0);
    await page.evaluate((i) => { (window as unknown as { __hls: { currentLevel: number } }).__hls.currentLevel = i; }, lowest);
    const before = await time(page);
    await until(page, 'switch to the lowest rendition', async () => (await state(page)).switched.includes(lowest));
    await until(page, 'playback after the switch', async () => (await time(page)) > Math.min(before + 1, 11.5) || (await page.evaluate(() => (document.getElementById('v') as HTMLVideoElement).ended)));
    steps.push(`switched to ${s0.levels[lowest]?.height}p, playing at ${(await time(page)).toFixed(2)} s`);
    const fatal = (await state(page)).errors.filter((e) => e.endsWith(':true'));
    if (fatal.length) throw new Error(`fatal errors: ${fatal.join('; ')}`);
    console.log(`PASS ${name}\n     ${steps.join('\n     ')}`);
  } catch (e) {
    failed += 1;
    console.log(`FAIL ${name}\n     ${[...steps, String(e).split('\n')[0]].join('\n     ')}`);
  } finally {
    await browser?.close();
  }
}
process.exitCode = failed ? 1 : 0;
