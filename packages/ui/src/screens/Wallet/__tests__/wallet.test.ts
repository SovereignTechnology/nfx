/**
 * Wallet screen under jsdom against `MockNetworkAdapter` + `MockWallet` (allowed in tests,
 * never in the screen). Covers every state, the fund (NUT-04) and withdraw (NUT-05) flows,
 * price-shown-before-confirm ordering, polling back-off and cancellation, the optimistic
 * auto-top-up save with rollback, the header chip, and the pure helpers.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encode } from 'uqr';
import { mocks } from '@sovit/core';
import type {
  MeltQuote,
  MintQuote,
  MintUrl,
  NetworkAdapter,
  Sats,
  Settings,
  UnixSeconds,
  Wallet as WalletApi,
  WalletHistoryEntry,
} from '@sovit/core';
import { click, fire, render, type Rendered } from '../../../components/testing/render.js';
import type { Route } from '../../shared/route.js';
import { invoiceProblem } from '../WithdrawSheet.js';
import { Wallet, historyLabel, type WalletProps } from '../Wallet.js';
import { WalletChip, walletChipLabel } from '../WalletChip.js';
import {
  QR_QUIET_ZONE,
  describeWalletError,
  formatCountdown,
  invoiceHref,
  invoiceQrPayload,
  isAutoTopUpOn,
  isLikelyBolt11,
  looksLikeMintInvoice,
  nextPollDelay,
  normalizeInvoice,
  parseSats,
  qrRuns,
} from '../invoice.js';

const { MockNetworkAdapter, MockWallet, MINTS, FIXTURE_NOW, asMint } = mocks;

type AdapterOptions = ConstructorParameters<typeof MockNetworkAdapter>[0];
type WalletOptions = ConstructorParameters<typeof MockWallet>[0];

const MINT_C: MintUrl = asMint('https://mint.fixture-c.example');
const clock = (): number => FIXTURE_NOW;

/** A realistic-length invoice (the mock's meltQuote reads the leading digits as the amount). */
const INVOICE = (amount: number): string =>
  `lnbc${String(amount)}n1pj9x7qzpp5qy8r3f0k2m6c4v7w9x2z5a8d3g6j9l2n5q8s1u4w7y0b3e6h9k2m5pqsp5zyg3zyg3zyg3zyg3zyg3zyg3`;

/** a = 2,100, b = 1,100 after three history entries; quotes expire FIXTURE_NOW + 600. */
function seeded(opts: WalletOptions = {}): mocks.MockWallet {
  let t: number = FIXTURE_NOW - 3 * 86400;
  const w = new MockWallet({
    balances: { [MINTS.a]: 0, [MINTS.b]: 0 },
    ...opts,
    now: () => t as UnixSeconds,
  });
  w.credit(MINTS.a, 3000, 'in', 'top-up');
  t = FIXTURE_NOW - 7200;
  w.credit(MINTS.a, -900, 'out', 'streamed 12 blocks of Test video');
  t = FIXTURE_NOW - 3600;
  w.credit(MINTS.b, 1100, 'in', 'top-up');
  t = FIXTURE_NOW;
  return w;
}

function adapterFor(wallet?: WalletApi, opts: AdapterOptions = {}): mocks.MockNetworkAdapter {
  const a = new MockNetworkAdapter(wallet ? { ...opts, wallet } : opts);
  a.updateSettings({ defaultMints: [MINTS.a, MINT_C] }).catch(() => undefined);
  return a;
}

/** The adapter with some `wallet` methods replaced; everything else bound to the mock. */
function withWallet(base: NetworkAdapter, patch: Partial<WalletApi>): NetworkAdapter {
  const wallet = new Proxy(base.wallet, {
    get(target, prop, receiver): unknown {
      const own = (patch as Record<string | symbol, unknown>)[prop];
      if (own !== undefined) return own;
      const v: unknown = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  return withAdapter(base, { wallet });
}

function withAdapter(base: NetworkAdapter, patch: Record<string, unknown>): NetworkAdapter {
  return new Proxy(base, {
    get(target, prop, receiver): unknown {
      if (typeof prop === 'string' && prop in patch) return patch[prop];
      const v: unknown = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (v: T) => void;
  readonly reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/**
 * Lets pending mock promises, timers and the React work they schedule settle. One `act` per
 * round, so React commits (and runs effects) between rounds — the fund flow is a chain of
 * identity → balances → quote → poll → poll, each step waiting on the previous render.
 */
async function flush(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

const rendered: Rendered[] = [];
afterEach(() => {
  for (const r of rendered.splice(0)) r.unmount();
  vi.restoreAllMocks();
});
beforeEach(() => {
  vi.useRealTimers();
});

function mount(
  adapter: NetworkAdapter,
  props: Partial<Omit<WalletProps, 'adapter' | 'navigate'>> = {},
): { readonly r: Rendered; readonly navigate: ReturnType<typeof vi.fn<(to: Route) => void>> } {
  const navigate = vi.fn<(to: Route) => void>();
  const r = render(
    createElement(Wallet, {
      adapter,
      navigate,
      clock,
      pollIntervalMs: 60_000,
      ...props,
    }),
  );
  rendered.push(r);
  return { r, navigate };
}

function buttons(root: ParentNode, text: string | RegExp): HTMLButtonElement[] {
  return Array.from(root.querySelectorAll('button')).filter((b) => {
    const t = b.textContent.trim();
    return typeof text === 'string' ? t === text : text.test(t);
  });
}

function button(root: ParentNode, text: string | RegExp): HTMLButtonElement {
  const b = buttons(root, text)[0];
  if (!b) throw new Error(`no button ${String(text)}`);
  return b;
}

function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
  fire(el, new Event('input', { bubbles: true }));
}

function dialog(r: Rendered): HTMLElement {
  return r.get('[role="dialog"]');
}

function mintRow(r: Rendered, mint: MintUrl): HTMLElement {
  return r.get(`.nf-wallet__mint[data-mint="${mint}"]`);
}

// ---------------------------------------------------------------------------------------------

describe('Wallet — structure, identity and loading', () => {
  it('renders a landmark, a heading and skeletons while identity loads; no wallet calls yet', () => {
    const a = adapterFor(undefined, { latencyMs: 5000 });
    const balances = vi.spyOn(a.wallet, 'balances');
    const { r } = mount(a);
    const section = r.get('section.nf-wallet');
    expect(section.getAttribute('aria-labelledby')).toBeTruthy();
    expect(section.getAttribute('aria-busy')).toBe('true');
    expect(r.get('h1').textContent).toBe('Wallet');
    expect(r.all('.nf-skeleton').length).toBeGreaterThan(0);
    expect(balances).not.toHaveBeenCalled();
    expect(buttons(r.container, 'Add funds')).toHaveLength(0);
  });

  it('signed out: designed sign-in state, Connect signer → settings, the wallet is never read', async () => {
    const a = adapterFor(undefined, { signedIn: false });
    const balances = vi.spyOn(a.wallet, 'balances');
    const history = vi.spyOn(a.wallet, 'history');
    const { r, navigate } = mount(a);
    await flush();
    const state = r.get('[role="status"]');
    expect(state.textContent).toContain('Sign in to use your wallet');
    expect(state.getAttribute('data-preset')).toBe('signer-not-detected');
    click(button(state, 'Connect signer'));
    expect(navigate).toHaveBeenCalledWith({ name: 'settings' });
    expect(balances).not.toHaveBeenCalled();
    expect(history).not.toHaveBeenCalled();
  });

  it('failWith no-signer renders the same signed-out state', async () => {
    const { r } = mount(adapterFor(undefined, { failWith: 'no-signer' }));
    await flush();
    expect(r.get('[role="status"]').textContent).toContain('Sign in to use your wallet');
  });

  it('relay down: ErrorState with copy + detail; Retry asks again; nothing thrown or logged', async () => {
    const errors = vi.spyOn(console, 'error');
    const a = adapterFor(undefined, { failWith: 'relay-down' });
    const me = vi.spyOn(a, 'me');
    const { r } = mount(a);
    await flush();
    const alert = r.get('[role="alert"]');
    expect(alert.textContent).toContain('Relay down');
    expect(alert.querySelector('.nf-state__detail')?.textContent).toBe(
      'relay-down: no relays reachable',
    );
    click(button(alert, 'Retry'));
    await flush();
    expect(me).toHaveBeenCalledTimes(2);
    expect(errors).not.toHaveBeenCalled();
  });

  it('failWith no-seeders leaves the wallet unaffected', async () => {
    const { r } = mount(adapterFor(seeded(), { failWith: 'no-seeders' }));
    await flush();
    expect(r.get('.nf-wallet__total-badge').getAttribute('aria-label')).toBe(
      'Total balance: 3,200 sats',
    );
  });

  it('unmounting mid-load cancels: no wallet calls after identity, no state updates, no errors', async () => {
    const errors = vi.spyOn(console, 'error');
    const a = adapterFor(seeded(), { latencyMs: 30 });
    const balances = vi.spyOn(a.wallet, 'balances');
    const history = vi.spyOn(a.wallet, 'history');
    const { r } = mount(a);
    r.unmount();
    rendered.splice(rendered.indexOf(r), 1);
    await new Promise((res) => setTimeout(res, 60));
    await flush();
    expect(balances).not.toHaveBeenCalled();
    expect(history).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
  });
});

describe('Wallet — balances per mint', () => {
  it('shows the total, one MintChip per mint and the designed "no balance at this mint" row', async () => {
    const { r } = mount(adapterFor(seeded()));
    await flush();
    expect(r.get('.nf-wallet__total-badge').getAttribute('aria-label')).toBe(
      'Total balance: 3,200 sats',
    );
    expect(r.get('.nf-wallet__total-sub').textContent).toBe('across 2 of 3 mints');
    const rows = r.all('.nf-wallet__mint');
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.querySelector('.nf-mint__host')?.textContent)).toEqual([
      'mint.fixture-a.example',
      'mint.fixture-b.example',
      'mint.fixture-c.example',
    ]);
    expect(mintRow(r, MINTS.a).querySelector('.nf-mint__balance')?.textContent).toBe('2,100 sats');
    const empty = mintRow(r, MINT_C);
    expect(empty.textContent).toContain('No balance at this mint');
    click(button(empty, 'Top up'));
    await flush();
    const d = dialog(r);
    expect(d.textContent).toContain('Add funds');
    const pressed = d.querySelector('.nf-mint[aria-pressed="true"] .nf-mint__host');
    expect(pressed?.textContent).toBe('mint.fixture-c.example');
  });

  it('no balance anywhere (failWith no-balance): empty wallet state, Withdraw disabled', async () => {
    const { r } = mount(adapterFor(undefined, { failWith: 'no-balance' }));
    await flush();
    expect(r.get('.nf-wallet__balance').textContent).toContain('Your wallet is empty');
    for (const row of r.all('.nf-wallet__mint'))
      expect(row.textContent).toContain('No balance at this mint');
    const head = r.get('.nf-wallet__actions');
    expect(button(head, 'Withdraw').disabled).toBe(true);
    click(button(r.get('.nf-wallet__balance'), 'Add funds'));
    await flush();
    expect(dialog(r).textContent).toContain('Add funds');
  });

  it('no mints at all: "No mints yet" → Settings', async () => {
    const a = new MockNetworkAdapter({ wallet: new MockWallet({ balances: {} }) });
    await a.updateSettings({ defaultMints: [] });
    const { r, navigate } = mount(a);
    await flush();
    const card = r.get('.nf-wallet__balance');
    expect(card.textContent).toContain('No mints yet');
    click(button(card, 'Open Settings'));
    expect(navigate).toHaveBeenCalledWith({ name: 'settings' });
  });

  it('follows live wallet events and unsubscribes on unmount', async () => {
    const w = seeded();
    const a = adapterFor(w);
    const unsubscribe = vi.fn();
    const onChange = w.onChange.bind(w);
    vi.spyOn(w, 'onChange').mockImplementation((cb) => {
      const off = onChange(cb);
      return () => {
        unsubscribe();
        off();
      };
    });
    const { r } = mount(a);
    await flush();
    act(() => {
      w.credit(MINTS.a, 100, 'in', 'receive');
    });
    expect(r.get('.nf-wallet__total-badge').getAttribute('aria-label')).toBe(
      'Total balance: 3,300 sats',
    );
    expect(r.all('.nf-wallet__tx')[0]?.textContent).toContain('Received ecash');
    r.unmount();
    rendered.splice(rendered.indexOf(r), 1);
    expect(unsubscribe).toHaveBeenCalled();
  });

  it('a failed balance read is a compact error with Retry', async () => {
    let fail = true;
    const base = adapterFor(seeded());
    const real = base.wallet.balances.bind(base.wallet);
    const a = withWallet(base, {
      balances: () => (fail ? Promise.reject(new Error('relay-down: nope')) : real()),
    });
    const { r } = mount(a);
    await flush();
    const card = r.get('.nf-wallet__balance');
    expect(card.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not load your balance',
    );
    fail = false;
    click(button(card, 'Retry'));
    await flush();
    expect(r.get('.nf-wallet__total-badge').getAttribute('aria-label')).toBe(
      'Total balance: 3,200 sats',
    );
  });
});

describe('Wallet — history (kind 7376)', () => {
  it('lists entries newest first with friendly labels, direction, mint and relative time', async () => {
    const { r } = mount(adapterFor(seeded()));
    await flush();
    const rows = r.all('.nf-wallet__tx');
    expect(rows).toHaveLength(3);
    expect(rows[0]?.textContent).toContain('Top-up via Lightning');
    expect(rows[0]?.textContent).toContain('mint.fixture-b.example');
    expect(rows[0]?.textContent).toContain('1 hour ago');
    expect(rows[0]?.getAttribute('data-direction')).toBe('in');
    expect(rows[0]?.querySelector('.nf-sats')?.getAttribute('aria-label')).toBe(
      'Received 1,100 sats',
    );
    expect(rows[1]?.textContent).toContain('Streamed 12 blocks of Test video');
    expect(rows[1]?.querySelector('.nf-sats')?.getAttribute('aria-label')).toBe('Spent 900 sats');
  });

  it('renders memos through Markdown: hostile text stays text', async () => {
    const w = seeded();
    w.credit(MINTS.b, 21, 'in', 'nutzap from <img src=x onerror=alert(1)> **Kilnfire**');
    const { r } = mount(adapterFor(w));
    await flush();
    const row = r.all('.nf-wallet__tx')[0];
    expect(row?.querySelector('img')).toBeNull();
    expect(row?.querySelector('strong')?.textContent).toBe('Kilnfire');
    expect(row?.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('empty history is a designed state', async () => {
    const { r } = mount(adapterFor());
    await flush();
    expect(r.get('.nf-wallet__history-card').textContent).toContain('No transactions yet');
  });

  it('filters by mint through history({ limit, mint })', async () => {
    const a = adapterFor(seeded());
    const history = vi.spyOn(a.wallet, 'history');
    const { r } = mount(a, { historyLimit: 20 });
    await flush();
    expect(history).toHaveBeenLastCalledWith({ limit: 20 });
    const filters = r.get('.nf-wallet__filters');
    const chipB = Array.from(filters.querySelectorAll<HTMLButtonElement>('.nf-mint')).find((b) =>
      b.textContent.includes('mint.fixture-b.example'),
    );
    expect(chipB).toBeTruthy();
    if (!chipB) return;
    click(chipB);
    await flush();
    expect(history).toHaveBeenLastCalledWith({ limit: 20, mint: MINTS.b });
    expect(chipB.getAttribute('aria-pressed')).toBe('true');
    expect(r.all('.nf-wallet__tx')).toHaveLength(1);
    click(button(filters, 'All mints'));
    await flush();
    expect(r.all('.nf-wallet__tx')).toHaveLength(3);
  });

  it('a failed history read is a compact error with Retry', async () => {
    const a = withWallet(adapterFor(seeded()), {
      history: () => Promise.reject(new Error('relay-down: history')),
    });
    const { r } = mount(a);
    await flush();
    expect(r.get('.nf-wallet__history-card [role="alert"]').textContent).toContain(
      'Could not load your history',
    );
  });
});

describe('Wallet — fund via Lightning invoice (NUT-04)', () => {
  async function openFund(r: Rendered): Promise<HTMLElement> {
    click(button(r.get('.nf-wallet__actions'), 'Add funds'));
    await flush();
    return dialog(r);
  }

  it('pick mint + amount → mintQuote → QR, copyable text, lightning: link and countdown', async () => {
    const w = seeded({ quotePollsUntilPaid: 1e9 });
    const a = adapterFor(w);
    const mintQuote = vi.spyOn(w, 'mintQuote');
    const { r } = mount(a);
    await flush();
    let d = await openFund(r);
    const chipB = Array.from(d.querySelectorAll<HTMLButtonElement>('.nf-mint')).find((b) =>
      b.textContent.includes('mint.fixture-b.example'),
    );
    if (!chipB) throw new Error('no chip');
    click(chipB);
    click(button(d, '5,000'));
    expect(d.querySelector<HTMLInputElement>('input')?.value).toBe('5000');
    click(button(d, 'Create invoice'));
    await flush();
    expect(mintQuote).toHaveBeenCalledWith(MINTS.b, 5000);
    d = dialog(r);
    const quote = (await mintQuote.mock.results[0]?.value) as MintQuote;
    const svg = d.querySelector('svg[role="img"]');
    expect(svg?.getAttribute('aria-label')).toBe('QR code: Lightning invoice for 5,000 sats');
    const modules = Number(svg?.getAttribute('data-modules'));
    const n = modules + QR_QUIET_ZONE * 2;
    expect(svg?.getAttribute('viewBox')).toBe(`0 0 ${String(n)} ${String(n)}`);
    expect(svg?.querySelectorAll('g rect').length).toBeGreaterThan(20);
    expect(d.querySelector('textarea')?.value).toBe(quote.bolt11);
    expect(d.querySelector('a')?.getAttribute('href')).toBe(invoiceHref(quote.bolt11));
    expect(d.querySelector('.nf-wallet__countdown')?.textContent).toContain('Expires in 10:00');
    expect(d.textContent).toContain('Waiting for payment');
    expect(d.textContent).toContain('it should say 5,000 sats');
    // the amount is shown (as a SatsBadge) before the QR in DOM order
    const price = d.querySelector('.nf-sats--price');
    expect(
      price && svg && price.compareDocumentPosition(svg) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('refuses an invalid amount without asking the mint', async () => {
    const w = seeded();
    const mintQuote = vi.spyOn(w, 'mintQuote');
    const { r } = mount(adapterFor(w));
    await flush();
    const d = await openFund(r);
    const input = d.querySelector<HTMLInputElement>('input');
    if (!input) throw new Error('no input');
    typeInto(input, '12.5');
    click(button(d, 'Create invoice'));
    await flush();
    expect(mintQuote).not.toHaveBeenCalled();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(dialog(r).querySelector('[role="alert"]')?.textContent).toContain(
      'Enter a whole number of sats',
    );
  });

  it('polls until the mint issues the ecash → success, toast, balances refreshed', async () => {
    const w = seeded({ quotePollsUntilPaid: 2 });
    const a = adapterFor(w);
    const balances = vi.spyOn(w, 'balances');
    const pollQuote = vi.spyOn(w, 'pollQuote');
    const { r } = mount(a, {
      intent: { action: 'fund', mint: MINTS.b, amount: 5000 },
      pollIntervalMs: 0,
      maxPollIntervalMs: 0,
    });
    await flush(20);
    expect(pollQuote).toHaveBeenCalledTimes(2);
    const d = dialog(r);
    expect(d.textContent).toContain('Payment received');
    expect(d.querySelector('.nf-sats')?.getAttribute('aria-label')).toBe('+ 5,000 sats');
    expect(balances.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(r.get('.nf-wallet__total-badge').getAttribute('aria-label')).toBe(
      'Total balance: 8,200 sats',
    );
    expect(r.get('.nf-toasts').textContent).toContain('Added 5,000 sats');
  });

  it('PAID but not yet issued shows the minting copy, then succeeds', async () => {
    const w = seeded();
    let n = 0;
    const a = withWallet(adapterFor(w), {
      pollQuote: () => {
        n += 1;
        return Promise.resolve(
          n === 1 ? { state: 'PAID' as const } : { state: 'ISSUED' as const, minted: 777 as Sats },
        );
      },
    });
    const { r } = mount(a, {
      intent: { action: 'fund', mint: MINTS.a, amount: 777 },
      pollIntervalMs: 0,
      maxPollIntervalMs: 60_000,
    });
    await flush(6);
    expect(dialog(r).textContent).toContain('Payment received — minting your ecash');
  });

  it('closing the sheet stops polling', async () => {
    const w = seeded({ quotePollsUntilPaid: 1e9 });
    const pollQuote = vi.spyOn(w, 'pollQuote');
    const { r } = mount(adapterFor(w), {
      intent: { action: 'fund', mint: MINTS.b, amount: 5000 },
      pollIntervalMs: 0,
      maxPollIntervalMs: 0,
    });
    await flush(6);
    expect(pollQuote.mock.calls.length).toBeGreaterThan(0);
    click(button(dialog(r), 'Cancel'));
    await flush(2);
    const after = pollQuote.mock.calls.length;
    await flush(10);
    expect(pollQuote.mock.calls.length).toBe(after);
    expect(r.all('[role="dialog"]')).toHaveLength(0);
  });

  it('unmounting while an invoice is open stops polling without state updates', async () => {
    const errors = vi.spyOn(console, 'error');
    const w = seeded({ quotePollsUntilPaid: 1e9 });
    const pollQuote = vi.spyOn(w, 'pollQuote');
    const { r } = mount(adapterFor(w), {
      intent: { action: 'fund', mint: MINTS.b, amount: 5000 },
      pollIntervalMs: 0,
      maxPollIntervalMs: 0,
    });
    await flush(6);
    r.unmount();
    rendered.splice(rendered.indexOf(r), 1);
    const after = pollQuote.mock.calls.length;
    await flush(10);
    expect(pollQuote.mock.calls.length).toBeLessThanOrEqual(after + 1);
    expect(errors).not.toHaveBeenCalled();
  });

  it('an expired invoice gets a final check, then "Invoice expired"; New invoice asks again', async () => {
    const w = seeded({ quotePollsUntilPaid: 1e9 });
    const mintQuote = vi.fn((mint: MintUrl, amount: Sats) =>
      w.mintQuote(mint, amount).then((q) => ({ ...q, expiry: FIXTURE_NOW - 1 })),
    );
    const pollQuote = vi.spyOn(w, 'pollQuote');
    const { r } = mount(withWallet(adapterFor(w), { mintQuote }), {
      intent: { action: 'fund', mint: MINTS.b, amount: 5000 },
      pollIntervalMs: 0,
    });
    await flush(10);
    expect(pollQuote).toHaveBeenCalledTimes(1);
    const d = dialog(r);
    expect(d.textContent).toContain('Invoice expired');
    click(button(d, 'New invoice'));
    await flush();
    expect(mintQuote).toHaveBeenCalledTimes(2);
  });

  it('a failed quote is an error with Retry and a way back to the form', async () => {
    const mintQuote = vi.fn(() => Promise.reject(new Error('fetch failed: unreachable')));
    const { r } = mount(withWallet(adapterFor(seeded()), { mintQuote }), {
      intent: { action: 'fund', mint: MINT_C, amount: 5000 },
    });
    await flush();
    const d = dialog(r);
    expect(d.querySelector('[role="alert"]')?.textContent).toContain('Could not create an invoice');
    click(button(d, 'Retry'));
    await flush();
    expect(mintQuote).toHaveBeenCalledTimes(2);
    click(button(dialog(r), 'Change mint or amount'));
    await flush();
    expect(dialog(r).querySelector('input')).not.toBeNull();
    // the mint that failed to answer is now marked unreachable on its chip
    expect(
      dialog(r).querySelector('.nf-mint[aria-pressed="true"] .nf-mint__status--unreachable'),
    ).not.toBeNull();
  });

  it('three failed polls stop with "The mint is not answering"; Check again resumes', async () => {
    let ok = false;
    const w = seeded({ quotePollsUntilPaid: 1 });
    const real = w.pollQuote.bind(w);
    const pollQuote = vi.fn((q: MintQuote) =>
      ok ? real(q) : Promise.reject(new Error('fetch failed: network')),
    );
    const { r } = mount(withWallet(adapterFor(w), { pollQuote }), {
      intent: { action: 'fund', mint: MINTS.b, amount: 5000 },
      pollIntervalMs: 0,
      maxPollIntervalMs: 0,
    });
    await flush(12);
    expect(pollQuote).toHaveBeenCalledTimes(3);
    const d = dialog(r);
    expect(d.textContent).toContain('The mint is not answering');
    expect(d.textContent).toContain('do not pay again');
    ok = true;
    click(button(d, 'Check again'));
    await flush(10);
    expect(dialog(r).textContent).toContain('Payment received');
  });

  it('a deep link with mint + amount requests the invoice straight away', async () => {
    const w = seeded({ quotePollsUntilPaid: 1e9 });
    const mintQuote = vi.spyOn(w, 'mintQuote');
    const { r } = mount(adapterFor(w), { intent: { action: 'fund', mint: MINTS.a, amount: 1234 } });
    await flush();
    expect(mintQuote).toHaveBeenCalledWith(MINTS.a, 1234);
    expect(dialog(r).querySelector('svg[role="img"]')).not.toBeNull();
  });
});

describe('Wallet — withdraw to a Lightning invoice (NUT-05)', () => {
  async function openWithdraw(r: Rendered): Promise<HTMLElement> {
    click(button(r.get('.nf-wallet__actions'), 'Withdraw'));
    await flush();
    return dialog(r);
  }

  async function review(r: Rendered, invoice: string): Promise<HTMLElement> {
    const d = await openWithdraw(r);
    const box = d.querySelector('textarea');
    if (!box) throw new Error('no textarea');
    typeInto(box, invoice);
    click(button(d, 'Review'));
    await flush();
    return dialog(r);
  }

  it('refuses things that are not invoices without asking the mint', async () => {
    const w = seeded();
    const meltQuote = vi.spyOn(w, 'meltQuote');
    const { r } = mount(adapterFor(w));
    await flush();
    for (const [input, copy] of [
      ['', 'Paste a Lightning invoice'],
      ['me@wallet.example', 'Lightning addresses and LNURL are not supported'],
      ['lnurl1dp68gurn8ghj7um9', 'Lightning addresses and LNURL are not supported'],
      ['bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'does not look like a Lightning invoice'],
      ['lnbc1', 'does not look like a Lightning invoice'],
    ] as const) {
      const d = await review(r, input);
      expect(d.querySelector('[role="alert"]')?.textContent).toContain(copy);
      expect(d.querySelector('textarea')?.getAttribute('aria-invalid')).toBe('true');
      click(button(d, 'Cancel'));
      await flush();
    }
    expect(meltQuote).not.toHaveBeenCalled();
  });

  it('normalizes the invoice and shows amount, fee reserve and total BEFORE the confirm', async () => {
    const w = seeded();
    const meltQuote = vi.spyOn(w, 'meltQuote');
    const melt = vi.spyOn(w, 'melt');
    const { r } = mount(adapterFor(w));
    await flush();
    const d = await review(r, `  LIGHTNING:${INVOICE(1500).toUpperCase()} `);
    expect(meltQuote).toHaveBeenCalledWith(MINTS.a, INVOICE(1500));
    const summary = d.querySelector('.nf-wallet__summary');
    expect(summary?.textContent).toContain('Invoice amount');
    const badges = Array.from(summary?.querySelectorAll('.nf-sats') ?? []).map((b) =>
      b.getAttribute('aria-label'),
    );
    expect(badges).toEqual(['1,500 sats', '15 sats', 'Total, at most 1,515 sats']);
    const confirm = button(d, 'Withdraw up to 1,515 sats');
    expect(confirm.disabled).toBe(false);
    const total = d.querySelector('.nf-wallet__summary-total');
    expect(total && total.compareDocumentPosition(confirm) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(melt).not.toHaveBeenCalled();
  });

  it('confirm melts exactly the displayed quote → "Payment sent", balances refreshed', async () => {
    const w = seeded();
    const meltQuote = vi.spyOn(w, 'meltQuote');
    const melt = vi.spyOn(w, 'melt');
    const balances = vi.spyOn(w, 'balances');
    const { r } = mount(adapterFor(w));
    await flush();
    const d = await review(r, INVOICE(1500));
    const shown = (await meltQuote.mock.results[0]?.value) as MeltQuote;
    const before = balances.mock.calls.length;
    click(button(d, 'Withdraw up to 1,515 sats'));
    await flush();
    expect(melt).toHaveBeenCalledTimes(1);
    expect(melt.mock.calls[0]?.[0]).toBe(shown);
    const done = dialog(r);
    expect(done.textContent).toContain('Payment sent');
    expect(done.textContent).toContain('Change returned');
    expect(done.textContent).not.toContain('0000000000'); // the preimage is never shown
    expect(balances.mock.calls.length).toBeGreaterThan(before);
    expect(r.get('.nf-toasts').textContent).toContain('Sent 1,500 sats');
  });

  it('more than the mint holds: confirm disabled with an explanation', async () => {
    const w = seeded();
    const melt = vi.spyOn(w, 'melt');
    const { r } = mount(adapterFor(w));
    await flush();
    const d = await review(r, INVOICE(5000));
    const confirm = button(d, 'Withdraw up to 5,050 sats');
    expect(confirm.disabled).toBe(true);
    expect(d.querySelector('[role="alert"]')?.textContent).toContain('Not enough at this mint');
    click(confirm);
    await flush();
    expect(melt).not.toHaveBeenCalled();
  });

  it('a melt that does not pay → "Payment did not go through"; Try again returns to confirm', async () => {
    const melt = vi.fn(() => Promise.resolve({ paid: false, change: 0 as Sats }));
    const { r } = mount(withWallet(adapterFor(seeded()), { melt }));
    await flush();
    const d = await review(r, INVOICE(1500));
    click(button(d, 'Withdraw up to 1,515 sats'));
    await flush();
    expect(dialog(r).querySelector('[role="alert"]')?.textContent).toContain(
      'Payment did not go through',
    );
    click(button(dialog(r), 'Try again'));
    await flush();
    expect(buttons(dialog(r), 'Withdraw up to 1,515 sats')).toHaveLength(1);
    expect(melt).toHaveBeenCalledTimes(1);
  });

  it('a melt that throws → "Withdrawal failed" with advice not to pay twice', async () => {
    const melt = vi.fn(() => Promise.reject(new Error('fetch failed: timeout')));
    const { r } = mount(withWallet(adapterFor(seeded()), { melt }));
    await flush();
    const d = await review(r, INVOICE(1500));
    click(button(d, 'Withdraw up to 1,515 sats'));
    await flush();
    const alert = dialog(r).querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Withdrawal failed');
    expect(alert?.textContent).toContain('check History before you try again');
  });

  it('Back and Cancel never melt', async () => {
    const w = seeded();
    const melt = vi.spyOn(w, 'melt');
    const { r } = mount(adapterFor(w));
    await flush();
    let d = await review(r, INVOICE(1500));
    click(button(d, 'Back'));
    await flush();
    d = dialog(r);
    expect(d.querySelector('textarea')?.value).toBe(INVOICE(1500));
    click(button(d, 'Cancel'));
    await flush();
    expect(r.all('[role="dialog"]')).toHaveLength(0);
    expect(melt).not.toHaveBeenCalled();
  });

  it('a deep link carrying an invoice fetches the quote and stops at the confirm', async () => {
    const w = seeded();
    const meltQuote = vi.spyOn(w, 'meltQuote');
    const melt = vi.spyOn(w, 'melt');
    const { r } = mount(adapterFor(w), {
      intent: { action: 'withdraw', mint: MINTS.b, invoice: INVOICE(500) },
    });
    await flush();
    expect(meltQuote).toHaveBeenCalledWith(MINTS.b, INVOICE(500));
    expect(buttons(dialog(r), 'Withdraw up to 505 sats')).toHaveLength(1);
    expect(melt).not.toHaveBeenCalled();
  });

  it('an expired quote cannot be confirmed; "Get a new quote" asks again', async () => {
    const w = seeded();
    const meltQuote = vi.fn((mint: MintUrl, bolt11: string) =>
      w.meltQuote(mint, bolt11).then((q) => ({ ...q, expiry: FIXTURE_NOW - 5 })),
    );
    const { r } = mount(withWallet(adapterFor(w), { meltQuote }), {
      intent: { action: 'withdraw', mint: MINTS.a, invoice: INVOICE(100) },
    });
    await flush();
    const d = dialog(r);
    expect(d.querySelector('[role="alert"]')?.textContent).toContain('This quote expired');
    expect(buttons(d, /^Withdraw up to/)).toHaveLength(0);
    click(button(d, 'Get a new quote'));
    await flush();
    expect(meltQuote).toHaveBeenCalledTimes(2);
  });

  it('the sheet will not close while the melt is in flight', async () => {
    const pending = deferred<{ paid: boolean; change: Sats }>();
    const { r } = mount(withWallet(adapterFor(seeded()), { melt: () => pending.promise }));
    await flush();
    const d = await review(r, INVOICE(1500));
    click(button(d, 'Withdraw up to 1,515 sats'));
    await flush();
    click(r.get('[aria-label="Close"]'));
    await flush();
    expect(dialog(r).textContent).toContain('keep this open');
    pending.resolve({ paid: true, change: 15 as Sats });
    await flush();
    expect(dialog(r).textContent).toContain('Payment sent');
  });

  it('with nothing to withdraw the header button is disabled', async () => {
    const { r } = mount(adapterFor(undefined, { failWith: 'no-balance' }));
    await flush();
    expect(button(r.get('.nf-wallet__actions'), 'Withdraw').disabled).toBe(true);
  });
});

describe('Wallet — auto top-up (Settings.autoTopUp)', () => {
  function card(r: Rendered): HTMLElement {
    const c = r
      .all('.nf-wallet__side .nf-wallet__card')
      .find((el) => el.textContent.includes('Auto top-up'));
    if (!c) throw new Error('no auto top-up card');
    return c;
  }

  it('turning it on saves optimistically, then confirms with a toast', async () => {
    const base = adapterFor(seeded());
    const pending = deferred<Settings>();
    const updateSettings = vi.fn(() => pending.promise);
    const { r } = mount(withAdapter(base, { updateSettings }));
    await flush();
    let c = card(r);
    expect(c.querySelector('[data-state]')?.textContent).toBe('Off');
    click(c.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    c = card(r);
    const below = c.querySelector<HTMLInputElement>('input[inputmode="numeric"]');
    if (!below) throw new Error('no threshold');
    expect(below.value).toBe('500');
    typeInto(below, '800');
    const chipB = Array.from(c.querySelectorAll<HTMLButtonElement>('.nf-mint')).find((b) =>
      b.textContent.includes('mint.fixture-b.example'),
    );
    if (!chipB) throw new Error('no chip');
    click(chipB);
    click(button(card(r), 'Save'));
    expect(updateSettings).toHaveBeenCalledWith({
      autoTopUp: { belowSats: 800, fromMint: MINTS.b },
    });
    // optimistic: On before the adapter answers
    expect(card(r).querySelector('[data-state]')?.textContent).toBe('On');
    const saved = await base.updateSettings({
      autoTopUp: { belowSats: 800 as Sats, fromMint: MINTS.b },
    });
    pending.resolve(saved);
    await flush();
    expect(card(r).querySelector('[data-state]')?.textContent).toBe('On');
    expect(card(r).textContent).toContain('from mint.fixture-b.example');
    expect(r.get('.nf-toasts').textContent).toContain('Auto top-up on');
  });

  it('a failed save rolls back and says so (role=alert toast)', async () => {
    const base = adapterFor(seeded());
    const updateSettings = vi.fn(() => Promise.reject(new Error('relay-down: not published')));
    const { r } = mount(withAdapter(base, { updateSettings }));
    await flush();
    click(card(r).querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    click(button(card(r), 'Save'));
    expect(card(r).querySelector('[data-state]')?.textContent).toBe('On');
    await flush();
    expect(card(r).querySelector('[data-state]')?.textContent).toBe('Off');
    expect(card(r).querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(false);
    const toast = r.get('.nf-toasts [role="alert"]');
    expect(toast.textContent).toContain('Could not save auto top-up');
    expect(toast.textContent).toContain('Your previous setting is back');
  });

  it('turning it off writes belowSats: 0 (a patch cannot clear the optional key)', async () => {
    const base = adapterFor(seeded());
    await base.updateSettings({ autoTopUp: { belowSats: 500 as Sats, fromMint: MINTS.b } });
    const updateSettings = vi.spyOn(base, 'updateSettings');
    const { r } = mount(base);
    await flush();
    expect(card(r).querySelector('[data-state]')?.textContent).toBe('On');
    click(card(r).querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    click(button(card(r), 'Save'));
    expect(updateSettings).toHaveBeenLastCalledWith({
      autoTopUp: { belowSats: 0, fromMint: MINTS.b },
    });
    await flush();
    expect(card(r).querySelector('[data-state]')?.textContent).toBe('Off');
  });

  it('an invalid threshold is refused without saving', async () => {
    const base = adapterFor(seeded());
    const updateSettings = vi.spyOn(base, 'updateSettings');
    const { r } = mount(base);
    await flush();
    updateSettings.mockClear();
    click(card(r).querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    const below = card(r).querySelector<HTMLInputElement>('input[inputmode="numeric"]');
    if (!below) throw new Error('no threshold');
    typeInto(below, '0');
    click(button(card(r), 'Save'));
    await flush();
    expect(updateSettings).not.toHaveBeenCalled();
    expect(card(r).querySelector('[role="alert"]')?.textContent).toContain('whole number');
  });
});

describe('Wallet — how the wallet is kept (signer mode, platform)', () => {
  it('says the key is held by the signer when it supports signSecret', async () => {
    const { r } = mount(adapterFor(seeded()));
    await flush();
    expect(r.get('[data-fact="key-mode"]').textContent).toContain('Wallet key held by your signer');
    expect(r.all('[data-fact="platform"]')).toHaveLength(0); // mock platform: no storage claim
  });

  it('says the key is unlocked in the app otherwise, and adds the web note', async () => {
    const a = withAdapter(adapterFor(seeded()), {
      platform: 'web',
      signer: () =>
        Promise.resolve({
          kind: 'nip07',
          pubkey: mocks.ME,
          locked: false,
          supportsSignSecret: false,
        }),
    });
    const { r } = mount(a);
    await flush();
    expect(r.get('[data-fact="key-mode"]').textContent).toContain(
      'Wallet key unlocked in this app',
    );
    expect(r.get('[data-fact="platform"]').textContent).toContain('Nothing stored in this browser');
  });

  it('never renders the P2PK pubkey, proofs or secrets', async () => {
    const w = seeded();
    const p2pk = vi.spyOn(w, 'p2pkPubkey');
    const { r } = mount(adapterFor(w));
    await flush();
    expect(p2pk).not.toHaveBeenCalled();
    const html = r.container.innerHTML;
    expect(html).not.toContain(await w.p2pkPubkey());
    expect(html).not.toMatch(/"secret"|proofs/i);
  });
});

describe('WalletChip (shell header)', () => {
  it('shows the balance, the streaming rate only while > 0, and navigates on click', () => {
    const onClick = vi.fn();
    const r = render(createElement(WalletChip, { balance: 2100, satsPerMin: 14, onClick }));
    rendered.push(r);
    const chip = r.get('button.nf-walletchip');
    expect(chip.getAttribute('aria-label')).toBe('Wallet: 2,100 sats, streaming 14 sats/min');
    expect(r.get('.nf-walletchip__rate').textContent).toContain('streaming');
    click(chip);
    expect(onClick).toHaveBeenCalledTimes(1);
    r.rerender(createElement(WalletChip, { balance: 2100, satsPerMin: 0, onClick }));
    expect(r.all('.nf-walletchip__rate')).toHaveLength(0);
    expect(r.get('button.nf-walletchip').getAttribute('aria-label')).toBe('Wallet: 2,100 sats');
  });

  it('is static without onClick, compact above 10k, a skeleton while loading', () => {
    const r = render(createElement(WalletChip, { balance: 48_210 }));
    rendered.push(r);
    expect(r.all('button')).toHaveLength(0);
    expect(r.get('.nf-walletchip').textContent).toContain('48k');
    r.rerender(createElement(WalletChip, { balance: undefined }));
    expect(r.all('.nf-skeleton')).toHaveLength(1);
    expect(walletChipLabel(undefined)).toBe('Wallet: loading balance');
  });
});

describe('Wallet helpers', () => {
  it('bolt11 shape is loose, case-insensitive and never decodes', () => {
    const inv = INVOICE(1500);
    expect(isLikelyBolt11(inv)).toBe(true);
    expect(isLikelyBolt11(inv.toUpperCase())).toBe(true);
    expect(isLikelyBolt11(`lightning:${inv}`)).toBe(true);
    expect(isLikelyBolt11(`  ${inv.slice(0, 40)}\n${inv.slice(40)}  `)).toBe(true);
    expect(isLikelyBolt11(inv.replace(/^lnbc/, 'lntb'))).toBe(true);
    expect(isLikelyBolt11(inv.replace(/^lnbc/, 'lnbcrt'))).toBe(true);
    expect(isLikelyBolt11('lnbc1')).toBe(false);
    expect(
      isLikelyBolt11(
        'lnurl1dp68gurn8ghj7um9wfmxjcm99e3k7mf0v9cxj0m385ekvcenxc6r2c35xvukxefcv5mkvv34x5ekzd3ev56nyd3hxqurzepexejxxepnxscrvwfnv9nxzcn9xq6xyefhvgcxxcmyxymnserxfq5fns',
      ),
    ).toBe(false);
    expect(isLikelyBolt11('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')).toBe(false);
    expect(isLikelyBolt11(`${inv}"><script>`)).toBe(false);
    expect(normalizeInvoice(`LIGHTNING:${inv.toUpperCase()}`)).toBe(inv);
    expect(invoiceProblem(inv)).toBeUndefined();
    expect(invoiceProblem('you@getalby.com')).toContain('Lightning addresses');
  });

  it('the mint-answer check is prefix-only and refuses non-invoices', () => {
    expect(looksLikeMintInvoice('lnbc5000n1mockinvoicemockquote-1')).toBe(true);
    expect(looksLikeMintInvoice('<html>502 Bad Gateway</html>')).toBe(false);
    expect(looksLikeMintInvoice('')).toBe(false);
  });

  it('QR payload is LIGHTNING:<BOLT11> upper-cased (QR alphanumeric mode)', () => {
    const p = invoiceQrPayload(`lightning:${INVOICE(21)}`);
    expect(p.startsWith('LIGHTNING:LNBC21N1')).toBe(true);
    expect(/^[0-9A-Z $%*+./:-]+$/.test(p)).toBe(true);
    const upper = encode(p, { ecc: 'M', border: 0 });
    const lower = encode(`lightning:${INVOICE(21)}`, { ecc: 'M', border: 0 });
    expect(upper.size).toBeLessThanOrEqual(lower.size);
  });

  it('qrRuns covers exactly the dark modules of the encoded matrix', () => {
    const qr = encode(invoiceQrPayload(INVOICE(1500)), { ecc: 'M', border: 0 });
    const covered = new Set<string>();
    for (const run of qrRuns(qr.data))
      for (let x = run.x; x < run.x + run.w; x++) covered.add(`${String(x)},${String(run.y)}`);
    const dark = new Set<string>();
    qr.data.forEach((row, y) => {
      row.forEach((on, x) => {
        if (on) dark.add(`${String(x)},${String(y)}`);
      });
    });
    expect(covered).toEqual(dark);
    // finder patterns sit top-left, top-right and bottom-left (orientation sanity)
    const s = qr.size;
    for (const [x, y] of [
      [0, 0],
      [s - 7, 0],
      [0, s - 7],
    ] as const) {
      expect(qr.data[y]?.[x]).toBe(true);
      expect(qr.data[y + 6]?.[x + 6]).toBe(true);
      expect(qr.data[y + 1]?.[x + 1]).toBe(false);
    }
  });

  it('poll delays back off ×1.5 to the cap and never hammer', () => {
    const seq: number[] = [];
    let d: number | undefined;
    for (let i = 0; i < 8; i++) {
      d = nextPollDelay(d, 2000, 15_000);
      seq.push(d);
    }
    expect(seq).toEqual([2000, 3000, 4500, 6750, 10_125, 15_000, 15_000, 15_000]);
    // a zero first delay is honoured once; after that the floor is 500 ms
    expect(nextPollDelay(undefined, 0, 15_000)).toBe(0);
    expect(nextPollDelay(0, 0, 15_000)).toBe(500);
  });

  it('small formatters and predicates', () => {
    expect(formatCountdown(600)).toBe('10:00');
    expect(formatCountdown(59.9)).toBe('0:59');
    expect(formatCountdown(-3)).toBe('0:00');
    expect(parseSats('5,000')).toBe(5000);
    expect(parseSats('0')).toBeUndefined();
    expect(parseSats('1e3')).toBeUndefined();
    expect(parseSats('12.5')).toBeUndefined();
    expect(isAutoTopUpOn(undefined)).toBe(false);
    expect(isAutoTopUpOn({ belowSats: 0 as Sats, fromMint: MINTS.a })).toBe(false);
    expect(isAutoTopUpOn({ belowSats: 1 as Sats, fromMint: MINTS.a })).toBe(true);
  });

  it('describeWalletError maps failures to copy', () => {
    expect(describeWalletError(new Error('relay-down: x')).title).toBe('Relay down');
    expect(describeWalletError(new Error('no-signer')).title).toBe('Signer not available');
    expect(describeWalletError(new Error('insufficient balance at m')).title).toBe(
      'Not enough at this mint',
    );
    expect(describeWalletError(new Error('fetch failed')).title).toBe('Mint unreachable');
    expect(describeWalletError('boom').title).toBe('Something went wrong');
    expect(describeWalletError(undefined).detail).toBeUndefined();
  });

  it('historyLabel names the memos the wallet writes and passes others through', () => {
    const base: WalletHistoryEntry = {
      id: mocks.asEventId('h'),
      direction: 'in',
      amount: 1 as Sats,
      mint: MINTS.a,
      at: FIXTURE_NOW,
      created: [],
      destroyed: [],
    };
    expect(historyLabel({ ...base, memo: 'top-up' }).title).toBe('Top-up via Lightning');
    expect(historyLabel({ ...base, direction: 'out', memo: 'melt-out' }).title).toBe(
      'Withdrawal to Lightning',
    );
    expect(historyLabel({ ...base, memo: 'streamed 3 blocks of X' })).toEqual({
      icon: 'play',
      title: undefined,
    });
    expect(historyLabel(base).title).toBe('Received');
  });
});

describe('Wallet source hygiene', () => {
  it('no innerHTML-style APIs, no console, no window.location, no mocks, no renderSVG', () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), '..');
    const files = readdirSync(dir).filter(
      (f) => /\.tsx?$/.test(f) && !f.includes('.stories.') && !f.includes('.test.'),
    );
    expect(files.length).toBeGreaterThanOrEqual(6);
    for (const f of files) {
      // Code only: doc comments may name the APIs they avoid.
      const src = readFileSync(join(dir, f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      expect(src, f).not.toMatch(/dangerouslySetInnerHTML|innerHTML|insertAdjacentHTML|outerHTML/);
      expect(src, f).not.toMatch(/console\./);
      expect(src, f).not.toMatch(/window\.location|location\.href/);
      expect(src, f).not.toMatch(/MockNetworkAdapter|MockWallet|mocks/);
      expect(src, f).not.toMatch(/renderSVG|renderUnicode|renderANSI/);
      expect(src, f).not.toMatch(/localStorage|sessionStorage|indexedDB/);
    }
  });
});
