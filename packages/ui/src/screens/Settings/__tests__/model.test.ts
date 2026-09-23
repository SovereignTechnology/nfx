/** Pure helpers behind the Settings forms: URL validation, units, bounds, error copy. */
import { describe, expect, it } from 'vitest';
import {
  GIB,
  autoTopUpEnabled,
  clampPrefetch,
  describeLoadError,
  describeSaveError,
  formatBytes,
  gbFieldValue,
  parseDiskCapGb,
  parseThresholdSats,
  signerTitle,
  validateMintUrl,
  validateRelayUrl,
} from '../model.js';

describe('validateRelayUrl', () => {
  it('accepts wss:// and normalises host case, default port and trailing slash', () => {
    expect(validateRelayUrl('  wss://Relay.Example/  ')).toEqual({
      ok: true,
      value: 'wss://relay.example',
    });
    expect(validateRelayUrl('wss://relay.example:443/')).toEqual({
      ok: true,
      value: 'wss://relay.example',
    });
    expect(validateRelayUrl('wss://relay.example:7447/Nostr/')).toEqual({
      ok: true,
      value: 'wss://relay.example:7447/Nostr',
    });
  });

  it('rejects everything that is not wss:// with a specific message', () => {
    const err = (s: string): string => {
      const r = validateRelayUrl(s);
      if (r.ok) throw new Error(`expected ${s} to be rejected`);
      return r.error;
    };
    expect(err('')).toMatch(/Enter a relay address/);
    expect(err('ws://relay.example')).toMatch(/unencrypted ws:\/\/ relays are not allowed/);
    expect(err('https://relay.example')).toBe('Relays use wss://, not https://');
    expect(err('javascript:alert(1)')).toBe('Relays use wss://, not javascript://');
    expect(err('relay.example')).toMatch(/start with wss:\/\//);
    expect(err('wss://relay .example')).toMatch(/spaces/);
    expect(err('wss://user:pw@relay.example')).toMatch(/user name or password/);
    expect(err('wss://relay.example/#x')).toMatch(/no # part/);
    expect(err('wss://')).toMatch(/not a valid relay address/);
    expect(err(`wss://${'a'.repeat(600)}.example`)).toMatch(/too long/);
  });

  it('rejects duplicates after normalisation', () => {
    const r = validateRelayUrl('WSS://relay.example/', ['wss://relay.example']);
    expect(r).toEqual({ ok: false, error: 'That relay is already in your list.' });
  });

  it('encodes internationalised hosts (no look-alike Unicode in the list)', () => {
    const r = validateRelayUrl('wss://rеlay.example'); // Cyrillic "е"
    expect(r.ok && r.value.startsWith('wss://xn--')).toBe(true);
  });
});

describe('validateMintUrl', () => {
  it('accepts https:// and normalises to the contract form (no trailing slash)', () => {
    expect(validateMintUrl('https://Mint.Example/')).toEqual({
      ok: true,
      value: 'https://mint.example',
    });
    expect(validateMintUrl('https://mint.example/Bitcoin/')).toEqual({
      ok: true,
      value: 'https://mint.example/Bitcoin',
    });
  });

  it('rejects http://, other schemes, credentials, query/fragment and duplicates', () => {
    const err = (s: string, existing: readonly string[] = []): string => {
      const r = validateMintUrl(s, existing);
      if (r.ok) throw new Error(`expected ${s} to be rejected`);
      return r.error;
    };
    expect(err('http://mint.example')).toMatch(/expose your ecash/);
    expect(err('wss://mint.example')).toBe('Mints use https://, not wss://');
    expect(err('mint.example')).toMatch(/start with https:\/\//);
    expect(err('https://a:b@mint.example')).toMatch(/user name or password/);
    expect(err('https://mint.example/?x=1')).toMatch(/no \? or # part/);
    expect(err('https://mint.example/', ['https://mint.example'])).toMatch(/already a default/);
    expect(err('   ')).toMatch(/Enter a mint address/);
  });
});

describe('units and bounds', () => {
  it('formats bytes as GB (2^30) / MB', () => {
    expect(formatBytes(50 * GIB)).toBe('50 GB');
    expect(formatBytes(1.25 * GIB)).toBe('1.3 GB');
    expect(formatBytes(300 * 1024 ** 2)).toBe('300 MB');
    expect(formatBytes(0)).toBe('0 GB');
    expect(formatBytes(250 * GIB)).toBe('250 GB');
    expect(gbFieldValue(50 * GIB)).toBe('50');
    expect(gbFieldValue(12.5 * GIB)).toBe('12.5');
  });

  it('parses the disk cap field', () => {
    expect(parseDiskCapGb(' 20 ')).toEqual({ ok: true, value: 20 });
    expect(parseDiskCapGb('12.34')).toEqual({ ok: true, value: 12.3 });
    expect(parseDiskCapGb('0').ok).toBe(false);
    expect(parseDiskCapGb('10001').ok).toBe(false);
    expect(parseDiskCapGb('abc').ok).toBe(false);
    expect(parseDiskCapGb('').ok).toBe(false);
  });

  it('parses whole-sat thresholds', () => {
    expect(parseThresholdSats('2,500')).toEqual({ ok: true, value: 2500 });
    expect(parseThresholdSats('1.5').ok).toBe(false);
    expect(parseThresholdSats('0').ok).toBe(false);
    expect(parseThresholdSats('-4').ok).toBe(false);
    expect(parseThresholdSats('10000001').ok).toBe(false);
  });

  it('clamps prefetch to the slider steps', () => {
    expect(clampPrefetch(31)).toBe(30);
    expect(clampPrefetch(0)).toBe(5);
    expect(clampPrefetch(900)).toBe(120);
    expect(clampPrefetch(Number.NaN)).toBe(30);
  });

  it('reads a zero auto top-up threshold as off', () => {
    expect(autoTopUpEnabled(undefined)).toBe(false);
    expect(autoTopUpEnabled({ belowSats: 0 })).toBe(false);
    expect(autoTopUpEnabled({ belowSats: 1 })).toBe(true);
  });
});

describe('copy', () => {
  it('names signer kinds', () => {
    expect(signerTitle('nip07')).toBe('Browser extension (NIP-07)');
    expect(signerTitle('nip46')).toBe('Remote signer (NIP-46)');
    expect(signerTitle('local')).toBe('Local key (Local)');
  });

  it('maps load and save errors to human copy', () => {
    expect(describeLoadError(new Error('relay-down: no relays reachable'))).toMatchObject({
      title: 'Relay down',
      detail: 'relay-down: no relays reachable',
    });
    expect(describeLoadError('boom')).toMatchObject({
      title: 'Could not load your settings',
      detail: 'boom',
    });
    expect(describeLoadError(undefined).detail).toBeUndefined();
    expect(describeSaveError(new Error('relay-down'))).toMatch(/change was undone/);
    expect(describeSaveError(undefined)).toMatch(/change was undone/);
  });
});
