/**
 * MockWallet — fake sats for screens and Storybook. No cashu-ts, no relays, no crypto.
 * Balances are in-memory; `mintQuote` + `pollQuote` simulate a paid invoice after N polls.
 */
import type {
  CashuP2pkPubkey,
  CashuProof,
  LockedProofSet,
  MeltQuote,
  MintKeyset,
  MintQuote,
  MintUrl,
  NostrEventId,
  Sats,
  UnixSeconds,
  Wallet,
  WalletChangeEvent,
  WalletHistoryEntry,
} from '../contracts/index.js';
import { asEventId, asP2pk, MINTS, sats, unix } from './fixtures.js';
import { denominate } from './mock-payment-engine.js';

export interface MockWalletOptions {
  readonly balances?: ReadonlyMap<MintUrl, Sats> | Readonly<Record<string, number>>;
  /** Polls before a mint quote flips to PAID. Default 2. */
  readonly quotePollsUntilPaid?: number;
  readonly now?: () => UnixSeconds;
}

export class MockWallet implements Wallet {
  private readonly bal = new Map<MintUrl, number>();
  private readonly hist: WalletHistoryEntry[] = [];
  private readonly listeners = new Set<(e: WalletChangeEvent) => void>();
  private readonly quotes = new Map<string, { quote: MintQuote; polls: number }>();
  private readonly pollsUntilPaid: number;
  private readonly now: () => UnixSeconds;
  private seq = 0;

  constructor(opts: MockWalletOptions = {}) {
    const b = opts.balances ?? { [MINTS.a]: 2100, [MINTS.b]: 0 };
    const entries = b instanceof Map ? [...b.entries()] : Object.entries(b);
    for (const [m, v] of entries) this.bal.set(m as MintUrl, Number(v));
    this.pollsUntilPaid = opts.quotePollsUntilPaid ?? 2;
    this.now = opts.now ?? ((): UnixSeconds => unix(Math.floor(Date.now() / 1000)));
  }

  mints(): Promise<readonly MintUrl[]> {
    return Promise.resolve([...this.bal.keys()]);
  }

  balance(mint: MintUrl): Promise<Sats> {
    return Promise.resolve(sats(this.bal.get(mint) ?? 0));
  }

  balances(): Promise<ReadonlyMap<MintUrl, Sats>> {
    return Promise.resolve(new Map([...this.bal].map(([m, v]) => [m, sats(v)])));
  }

  p2pkPubkey(): Promise<CashuP2pkPubkey> {
    return Promise.resolve(asP2pk('mock-wallet'));
  }

  mintQuote(mint: MintUrl, amount: Sats): Promise<MintQuote> {
    const quoteId = `mockquote-${String(++this.seq)}`;
    const quote: MintQuote = {
      mint,
      quoteId,
      amount,
      bolt11: `lnbc${amount}n1mockinvoice${quoteId}`,
      expiry: this.now() + 600,
      state: 'UNPAID',
    };
    this.quotes.set(quoteId, { quote, polls: 0 });
    this.emit({ type: 'quote', quote });
    return Promise.resolve(quote);
  }

  pollQuote(quote: MintQuote): Promise<{ state: MintQuote['state']; minted?: Sats }> {
    const q = this.quotes.get(quote.quoteId);
    if (!q) return Promise.resolve({ state: 'UNPAID' });
    if (q.quote.state === 'ISSUED') return Promise.resolve({ state: 'ISSUED' });
    q.polls++;
    if (q.polls < this.pollsUntilPaid) return Promise.resolve({ state: 'UNPAID' });
    q.quote = { ...q.quote, state: 'ISSUED' };
    this.credit(quote.mint, quote.amount, 'in', 'top-up');
    this.emit({ type: 'quote', quote: q.quote });
    return Promise.resolve({ state: 'ISSUED', minted: sats(quote.amount) });
  }

  send(
    amount: Sats,
    opts: { readonly p2pk: CashuP2pkPubkey; readonly mint: MintUrl },
  ): Promise<LockedProofSet> {
    const have = this.bal.get(opts.mint) ?? 0;
    if (have < amount)
      return Promise.reject(
        new Error(`insufficient balance at ${opts.mint}: have ${have}, need ${amount}`),
      );
    this.credit(opts.mint, -Number(amount), 'out', `send ${amount} sat (P2PK)`);
    const proofs: CashuProof[] = denominate(amount).map((amt) => ({
      id: 'mockkeyset00',
      amount: amt,
      secret: `mock:w${String(++this.seq)}`,
      C: 'mock',
      dleq: { s: 'mock-s', e: 'mock-e' },
    }));
    return Promise.resolve({ mint: opts.mint, unit: 'sat', lockedTo: opts.p2pk, proofs });
  }

  receive(
    set: LockedProofSet | { readonly mint: MintUrl; readonly proofs: readonly CashuProof[] },
  ): Promise<Sats> {
    const total = set.proofs.reduce((a, p) => a + p.amount, 0);
    this.credit(set.mint, total, 'in', 'receive');
    return Promise.resolve(sats(total));
  }

  meltQuote(mint: MintUrl, bolt11: string): Promise<MeltQuote> {
    const amount = Number(/lnbc(\d+)/.exec(bolt11)?.[1] ?? 0);
    return Promise.resolve({
      mint,
      quoteId: `mockmelt-${String(++this.seq)}`,
      amount,
      feeReserve: Math.ceil(amount * 0.01),
      expiry: this.now() + 600,
      state: 'UNPAID',
    });
  }

  melt(quote: MeltQuote): Promise<{ paid: boolean; preimage?: string; change: Sats }> {
    const need = quote.amount + quote.feeReserve;
    const have = this.bal.get(quote.mint) ?? 0;
    if (have < need) return Promise.resolve({ paid: false, change: sats(0) });
    this.credit(quote.mint, -quote.amount, 'out', 'melt-out');
    return Promise.resolve({
      paid: true,
      preimage: '00'.repeat(32),
      change: sats(quote.feeReserve),
    });
  }

  keyset(mint: MintUrl, keysetId: string): Promise<MintKeyset> {
    return Promise.resolve({
      mint,
      id: keysetId,
      unit: 'sat',
      active: true,
      keys: { '1': '02mock', '2': '02mock', '4': '02mock' },
      fetchedAt: this.now(),
    });
  }

  history(opts?: {
    readonly limit?: number;
    readonly mint?: MintUrl;
  }): Promise<readonly WalletHistoryEntry[]> {
    let h = [...this.hist].reverse();
    if (opts?.mint) h = h.filter((e) => e.mint === opts.mint);
    if (opts?.limit !== undefined) h = h.slice(0, opts.limit);
    return Promise.resolve(h);
  }

  onChange(cb: (e: WalletChangeEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Test hook. */
  credit(mint: MintUrl, delta: number, direction: 'in' | 'out', memo: string): void {
    this.bal.set(mint, (this.bal.get(mint) ?? 0) + delta);
    const id: NostrEventId = asEventId(`hist:${String(++this.seq)}`);
    const entry: WalletHistoryEntry = {
      id,
      direction,
      amount: sats(Math.abs(delta)),
      mint,
      at: this.now(),
      memo,
      created: [asEventId(`tok:${String(this.seq)}`)],
      destroyed: [],
    };
    this.hist.push(entry);
    this.emit({ type: 'balance', mint, balance: sats(this.bal.get(mint) ?? 0) });
    this.emit({ type: 'history', entry });
  }

  private emit(e: WalletChangeEvent): void {
    for (const cb of this.listeners) cb(e);
  }
}
