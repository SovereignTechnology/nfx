/**
 * The test page's "stats for nerds" panel (src/nerd.ts, nfx #99), checked on a page that is
 * playing with at least one open mesh peer: shared by e2e-mesh.ts (trackers) and
 * e2e-nostr.ts (Nostr), so both ways the engine hands over a peer connection are covered.
 * Returns the problems found (empty: all good).
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { Page } from 'playwright';

export async function nerdProblems(p: Page, label?: string): Promise<string[]> {
  const problems: string[] = [];
  const mesh = await p.evaluate(() => (window as any).__nfx.mesh);
  if (!(mesh?.connected > 0)) problems.push(`stats: connected ${mesh?.connected}`);
  if (!(mesh?.segments?.p2p > 0)) problems.push(`stats: segments ${JSON.stringify(mesh?.segments)}`);
  if (!(mesh?.peerList ?? []).some((x: { connected: boolean; down: number }) => x.connected && x.down > 0)) {
    problems.push(`stats: no open peer that sent bytes ${JSON.stringify(mesh?.peerList)}`);
  }

  // Opened from the video's context menu.
  await p.click('#v', { button: 'right' });
  await p.waitForSelector('#nerd-menu:not([hidden]) button', { timeout: 5_000 });
  await p.click('#nerd-menu button');
  await p.waitForSelector('#nerd:not([hidden])', { timeout: 5_000 });
  if (await p.isChecked('#nerd-addresses')) problems.push('panel: addresses on when it opened');
  // The page never asked for addresses: no address column, no address cell.
  if ((await p.locator('#nerd .nerd__addr').count()) !== 0) problems.push('panel: an address shown before the switch');
  const row = p.locator('#nerd tr[data-kind="webrtc"].nerd__open');
  await row.first().waitFor({ timeout: 5_000 });
  const cells = await row.first().locator('td').allTextContents();
  if (cells[3] === '0 B') problems.push(`panel: an open peer row with no bytes ${JSON.stringify(cells)}`);
  if (label !== undefined && !(cells[0] ?? '').includes(label)) problems.push(`panel: the peer is not labelled ${label} ${JSON.stringify(cells)}`);
  const origin = await p.locator('#nerd tr[data-kind="origin"] td').allTextContents();
  if (!origin[0]?.startsWith('origin')) problems.push(`panel: no origin row ${JSON.stringify(origin)}`);

  // Addresses only behind the switch, for the open peer, and a banner while shown.
  await p.check('#nerd-addresses');
  await p.waitForFunction(
    () => {
      const td = document.querySelector('#nerd tr[data-kind="webrtc"].nerd__open td.nerd__addr');
      return td !== null && td.textContent !== '–';
    },
    null,
    { timeout: 10_000 },
  );
  const withAddr = await row.first().locator('td').allTextContents();
  if (!(withAddr[7] ?? '').startsWith('direct')) problems.push(`panel: path ${JSON.stringify(withAddr)}`);
  if (await p.locator('#nerd .nerd__banner').isHidden()) problems.push('panel: no banner while addresses are shown');

  // `n` closes it; reopened, the switch is off again.
  await p.locator('body').press('n');
  await p.waitForSelector('#nerd', { state: 'hidden', timeout: 5_000 });
  await p.click('#nerd-toggle');
  await p.waitForSelector('#nerd:not([hidden])', { timeout: 5_000 });
  if (await p.isChecked('#nerd-addresses')) problems.push('panel: addresses still on after reopening');
  if ((await p.locator('#nerd .nerd__addr').count()) !== 0) problems.push('panel: addresses shown after reopening');
  await p.keyboard.press('Escape');
  await p.waitForSelector('#nerd', { state: 'hidden', timeout: 5_000 });
  return problems;
}
