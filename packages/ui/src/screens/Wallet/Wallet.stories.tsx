/**
 * Screens/Wallet — one story per STATE against `MockNetworkAdapter` + `MockWallet`
 * (execution plan §0 rule 8). The screenshot script writes these to artifacts/screens/wallet/.
 * Mocks are allowed here and in tests only, never in the screen source.
 *
 * Sheet and toast stories render inside a `transform`ed frame so the screen's
 * `position: fixed` sheet/toasts are laid out inside the story frame the script captures.
 * Stories whose state needs a click (confirm, save) do it in `play` with plain DOM calls.
 */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { mocks } from '@sovit/core';
import type { MintUrl, NetworkAdapter, Sats, UnixSeconds, Wallet as WalletApi } from '@sovit/core';
import type { ReactElement, ReactNode } from 'react';
import { NOW } from '../../../.storybook/fixtures.js';
import type { Route } from '../shared/route.js';
import { Wallet, type WalletProps } from './Wallet.js';
import { WalletChip } from './WalletChip.js';
import './Wallet.css';

const { MockNetworkAdapter, MockWallet, MINTS, asMint } = mocks;

type AdapterOptions = ConstructorParameters<typeof MockNetworkAdapter>[0];
type WalletOptions = ConstructorParameters<typeof MockWallet>[0];

/** A third, unfunded mint from Settings → the designed "No balance at this mint" row. */
const MINT_C: MintUrl = asMint('https://mint.fixture-c.example');

const clock = (): number => NOW;

/** An invoice long enough to look real (the mock parses the leading digits as the amount). */
const invoice = (amount: number): string =>
  `lnbc${String(amount)}n1pj9x7qzpp5qy8r3f0k2m6c4v7w9x2z5a8d3g6j9l2n5q8s1u4w7y0b3e6h9k2m5pqsp5` +
  'zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygs9qrsgq7ea976txfraylvgzuxs8kgcw23ezlrszfnh8r6qtfpr6cxga50aj6txm9rxrydzd06dfeawfk6swupvz4erwd9sslkavh6rwcylqqq3t4n2g';

/** Seeded NIP-60 history (oldest first); ends at a = 2,100 sats, b = 1,100 sats. */
function seededWallet(opts: WalletOptions = {}): mocks.MockWallet {
  let t: number = NOW - 3 * 86400;
  const w = new MockWallet({
    balances: { [MINTS.a]: 0, [MINTS.b]: 0 },
    ...opts,
    now: () => t as UnixSeconds,
  });
  const at = (secondsAgo: number): void => {
    t = NOW - secondsAgo;
  };
  at(3 * 86400);
  w.credit(MINTS.a, 5000, 'in', 'top-up');
  at(2 * 86400);
  w.credit(
    MINTS.a,
    -240,
    'out',
    'streamed 30 blocks of Hohmann transfers explained with a garden hose',
  );
  at(26 * 3600);
  w.credit(MINTS.b, 100, 'in', 'nutzap from **Kilnfire** for “Raku firing at night”');
  at(20 * 3600);
  w.credit(MINTS.a, -2000, 'out', 'melt-out');
  at(5 * 3600);
  w.credit(MINTS.a, -21, 'out', 'nutzap 21 sat');
  at(3 * 3600);
  w.credit(
    MINTS.a,
    -639,
    'out',
    'streamed 80 blocks of Why Starlink satellites fall out of the sky',
  );
  at(2 * 3600);
  w.credit(MINTS.b, 1000, 'in', 'top-up');
  t = NOW; // quotes made from here on expire NOW + 600
  return w;
}

function adapterWith(opts: AdapterOptions = {}, wallet?: WalletApi): mocks.MockNetworkAdapter {
  const a = new MockNetworkAdapter(wallet ? { ...opts, wallet } : opts);
  // (a relay-down mock rejects this too; the story does not care)
  a.updateSettings({ defaultMints: [MINTS.a, MINT_C] }).catch(() => undefined);
  return a;
}

/** Same adapter with some `wallet` methods replaced (a mint that fails, a stuck poll, …). */
function withWallet(base: NetworkAdapter, patch: Partial<WalletApi>): NetworkAdapter {
  const w = base.wallet;
  const wallet = new Proxy(w, {
    get(target, prop, receiver): unknown {
      const own = (patch as Record<string | symbol, unknown>)[prop];
      if (own !== undefined) return own;
      const v: unknown = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? (v as (...args: unknown[]) => unknown).bind(target) : v;
    },
  });
  return new Proxy(base, {
    get(target, prop, receiver): unknown {
      if (prop === 'wallet') return wallet;
      const v: unknown = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? (v as (...args: unknown[]) => unknown).bind(target) : v;
    },
  });
}

/** Same adapter with top-level methods/fields replaced (signer mode, platform, settings). */
function withAdapter(base: NetworkAdapter, patch: Record<string, unknown>): NetworkAdapter {
  return new Proxy(base, {
    get(target, prop, receiver): unknown {
      if (typeof prop === 'string' && prop in patch) return patch[prop];
      const v: unknown = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? (v as (...args: unknown[]) => unknown).bind(target) : v;
    },
  });
}

const navigate = (to: Route): void => {
  console.warn('navigate', to);
};

function Screen(props: Partial<WalletProps> & { readonly adapter: NetworkAdapter }): ReactElement {
  return <Wallet navigate={navigate} clock={clock} pollIntervalMs={0} {...props} />;
}

/** Contains the screen's `position: fixed` sheet + toasts inside the captured frame. */
function Framed({ children }: { readonly children: ReactNode }): ReactElement {
  return <div style={{ transform: 'translateZ(0)', minHeight: 900 }}>{children}</div>;
}

async function waitFor<T>(find: () => T | null | undefined, timeoutMs = 3000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = find();
    if (v !== null && v !== undefined) return v;
    if (Date.now() - start > timeoutMs) throw new Error('story play: element never appeared');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function buttonByText(root: HTMLElement, text: RegExp): HTMLButtonElement | undefined {
  return Array.from(root.querySelectorAll('button')).find(
    (b) => text.test(b.textContent ?? '') && !b.disabled,
  );
}

const meta = {
  title: 'Screens/Wallet',
  component: Wallet,
  parameters: { nf: { width: 1248 } },
} satisfies Meta<typeof Wallet>;
export default meta;
type Story = StoryObj<typeof meta>;

// ---- page states ---------------------------------------------------------------------------

export const Loading: Story = {
  name: 'Loading (skeletons)',
  render: () => <Screen adapter={adapterWith({ latencyMs: 5000 })} />,
};

export const Populated: Story = {
  name: 'Populated (balances per mint, history)',
  render: () => <Screen adapter={adapterWith({}, seededWallet())} />,
};

export const AutoTopUpOn: Story = {
  name: 'Populated — auto top-up on',
  render: () => {
    const a = adapterWith({}, seededWallet());
    void a.updateSettings({ autoTopUp: { belowSats: 500 as Sats, fromMint: MINTS.b } });
    return <Screen adapter={a} />;
  },
};

export const NoBalance: Story = {
  name: 'Empty — no balance (failWith no-balance)',
  render: () => <Screen adapter={adapterWith({ failWith: 'no-balance' })} />,
};

export const NoHistory: Story = {
  name: 'Empty — no history yet',
  render: () => <Screen adapter={adapterWith()} />,
};

export const NoMints: Story = {
  name: 'Empty — no mints configured',
  render: () => {
    const a = new MockNetworkAdapter({ wallet: new MockWallet({ balances: {} }) });
    void a.updateSettings({ defaultMints: [] });
    return <Screen adapter={a} />;
  },
};

export const SignerModeWeb: Story = {
  name: 'Web portal — wallet key unlocked in the page',
  render: () => {
    const base = adapterWith({}, seededWallet());
    return (
      <Screen
        adapter={withAdapter(base, {
          platform: 'web',
          signer: () =>
            Promise.resolve({
              kind: 'nip07',
              pubkey: mocks.ME,
              locked: false,
              supportsSignSecret: false,
              detail: 'nos2x',
            }),
        })}
      />
    );
  },
};

// ---- fund (NUT-04) ---------------------------------------------------------------------------

export const FundForm: Story = {
  name: 'Fund — pick mint and amount',
  render: () => (
    <Framed>
      <Screen adapter={adapterWith({}, seededWallet())} intent={{ action: 'fund', mint: MINT_C }} />
    </Framed>
  ),
};

export const FundInvoice: Story = {
  name: 'Fund — invoice QR, waiting for payment',
  render: () => {
    const w = seededWallet({ quotePollsUntilPaid: 1e9 });
    // A full-length bolt11 so the QR has a real invoice's density (the mock's is 30 chars).
    const realistic = withWallet(adapterWith({}, w), {
      mintQuote: (mint, amount) =>
        w.mintQuote(mint, amount).then((q) => ({ ...q, bolt11: invoice(amount) })),
    });
    return (
      <Framed>
        <Screen
          adapter={realistic}
          intent={{ action: 'fund', mint: MINTS.b, amount: 5000 }}
          pollIntervalMs={60_000}
        />
      </Framed>
    );
  },
};

export const FundPaid: Story = {
  name: 'Fund — paid (ecash minted)',
  render: () => (
    <Framed>
      <Screen
        adapter={adapterWith({}, seededWallet({ quotePollsUntilPaid: 1 }))}
        intent={{ action: 'fund', mint: MINTS.b, amount: 5000 }}
      />
    </Framed>
  ),
};

export const FundExpired: Story = {
  name: 'Fund — invoice expired',
  render: () => {
    const w = seededWallet({ quotePollsUntilPaid: 1e9 });
    // Quotes from this wallet expired 100 s before the screen's clock.
    const expiredQuotes = withWallet(adapterWith({}, w), {
      mintQuote: (mint, amount) =>
        w.mintQuote(mint, amount).then((q) => ({ ...q, expiry: NOW - 100 })),
    });
    return (
      <Framed>
        <Screen adapter={expiredQuotes} intent={{ action: 'fund', mint: MINTS.b, amount: 5000 }} />
      </Framed>
    );
  },
};

export const FundQuoteFailed: Story = {
  name: 'Error — could not create an invoice',
  render: () => (
    <Framed>
      <Screen
        adapter={withWallet(adapterWith({}, seededWallet()), {
          mintQuote: () =>
            Promise.reject(new Error('fetch failed: mint.fixture-c.example unreachable')),
        })}
        intent={{ action: 'fund', mint: MINT_C, amount: 5000 }}
      />
    </Framed>
  ),
};

export const FundUnreachable: Story = {
  name: 'Error — mint unreachable while waiting',
  render: () => (
    <Framed>
      <Screen
        adapter={withWallet(adapterWith({}, seededWallet()), {
          pollQuote: () => Promise.reject(new Error('fetch failed: network error')),
        })}
        intent={{ action: 'fund', mint: MINTS.b, amount: 5000 }}
        maxPollIntervalMs={0}
      />
    </Framed>
  ),
};

// ---- withdraw (NUT-05 melt) -------------------------------------------------------------------

export const WithdrawForm: Story = {
  name: 'Withdraw — paste an invoice',
  render: () => (
    <Framed>
      <Screen
        adapter={adapterWith({}, seededWallet())}
        intent={{ action: 'withdraw', mint: MINTS.a }}
      />
    </Framed>
  ),
};

export const WithdrawInvalid: Story = {
  name: 'Withdraw — not a Lightning invoice',
  render: () => (
    <Framed>
      <Screen
        adapter={adapterWith({}, seededWallet())}
        intent={{ action: 'withdraw', mint: MINTS.a, invoice: 'me@wallet.example' }}
      />
    </Framed>
  ),
};

export const WithdrawReview: Story = {
  name: 'Withdraw — fee shown before confirm',
  render: () => (
    <Framed>
      <Screen
        adapter={adapterWith({}, seededWallet())}
        intent={{ action: 'withdraw', mint: MINTS.a, invoice: invoice(1500) }}
      />
    </Framed>
  ),
};

export const WithdrawShort: Story = {
  name: 'Withdraw — not enough at this mint',
  render: () => (
    <Framed>
      <Screen
        adapter={adapterWith({}, seededWallet())}
        intent={{ action: 'withdraw', mint: MINTS.a, invoice: invoice(5000) }}
      />
    </Framed>
  ),
};

export const WithdrawSent: Story = {
  name: 'Withdraw — sent',
  render: () => (
    <Framed>
      <Screen
        adapter={adapterWith({}, seededWallet())}
        intent={{ action: 'withdraw', mint: MINTS.a, invoice: invoice(1500) }}
      />
    </Framed>
  ),
  play: async ({ canvasElement }) => {
    (await waitFor(() => buttonByText(canvasElement, /^Withdraw up to/))).click();
  },
};

export const WithdrawNotPaid: Story = {
  name: 'Withdraw — payment did not go through',
  render: () => (
    <Framed>
      <Screen
        adapter={withWallet(adapterWith({}, seededWallet()), {
          melt: () => Promise.resolve({ paid: false, change: 0 as Sats }),
        })}
        intent={{ action: 'withdraw', mint: MINTS.a, invoice: invoice(1500) }}
      />
    </Framed>
  ),
  play: async ({ canvasElement }) => {
    (await waitFor(() => buttonByText(canvasElement, /^Withdraw up to/))).click();
  },
};

// ---- errors / identity -------------------------------------------------------------------------

export const RelayDown: Story = {
  name: 'Error — relay down',
  render: () => <Screen adapter={adapterWith({ failWith: 'relay-down' })} />,
};

export const NoSigner: Story = {
  name: 'Error — no signer',
  render: () => <Screen adapter={adapterWith({ failWith: 'no-signer' })} />,
};

export const NoSeeders: Story = {
  name: 'Error — no seeders (wallet unaffected)',
  render: () => <Screen adapter={adapterWith({ failWith: 'no-seeders' }, seededWallet())} />,
};

export const BalanceFailed: Story = {
  name: 'Error — balance and history unavailable',
  render: () => (
    <Screen
      adapter={withWallet(adapterWith(), {
        balances: () => Promise.reject(new Error('relay-down: wallet events unreachable')),
        history: () => Promise.reject(new Error('relay-down: wallet events unreachable')),
      })}
    />
  ),
};

export const AutoTopUpSaveFailed: Story = {
  name: 'Error — auto top-up not saved (rolled back)',
  render: () => {
    const base = adapterWith({}, seededWallet());
    return (
      <Framed>
        <Screen
          adapter={withAdapter(base, {
            updateSettings: () => Promise.reject(new Error('relay-down: settings not published')),
          })}
        />
      </Framed>
    );
  },
  play: async ({ canvasElement }) => {
    const box = await waitFor(() =>
      canvasElement.querySelector<HTMLInputElement>('.nf-wallet__check input'),
    );
    box.click();
    (await waitFor(() => buttonByText(canvasElement, /^Save$/))).click();
  },
};

export const SignedOut: Story = {
  name: 'Signed out',
  render: () => <Screen adapter={adapterWith({ signedIn: false })} />,
};

// ---- the shell's header chip -------------------------------------------------------------------

function ChipRow({ children }: { readonly children: ReactNode }): ReactElement {
  return (
    <div style={{ display: 'flex', gap: 16, alignItems: 'center', padding: 16 }}>{children}</div>
  );
}

export const HeaderChip: Story = {
  name: 'Header chip — balance',
  parameters: { nf: { width: 480 } },
  render: () => (
    <ChipRow>
      <WalletChip balance={2100} onClick={() => undefined} />
      <WalletChip balance={48_210} onClick={() => undefined} />
      <WalletChip balance={undefined} />
    </ChipRow>
  ),
};

export const HeaderChipStreaming: Story = {
  name: 'Header chip — streaming while playing',
  parameters: { nf: { width: 480 } },
  render: () => (
    <ChipRow>
      <WalletChip balance={2100} satsPerMin={14} onClick={() => undefined} />
    </ChipRow>
  ),
};
