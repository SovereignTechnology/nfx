import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SeederProcess, SignalName } from '../adapters/process.js';
import { ENV_DATA_DIR, ENV_DISK_CAP, ENV_MAX_STREAMS, parseDaemonEnv } from '../cli/daemon.js';
import {
  HARDENING_DIRECTIVES,
  installShutdownHooks,
  renderSystemdUnit,
  sdNotify,
} from '../host/systemd.js';
import { capturedLogger } from './helpers.js';

class FakeProcess implements SeederProcess {
  argv: string[] = [];
  vars = new Map<string, string>();
  out: string[] = [];
  err: string[] = [];
  exits: number[] = [];
  runs: { cmd: string; args: readonly string[] }[] = [];
  runResult: { code: number } | Error = { code: 0 };
  private handlers = new Map<SignalName, Set<() => void>>();

  env(name: string): string | undefined {
    return this.vars.get(name);
  }
  writeStdout(line: string): void {
    this.out.push(line);
  }
  writeStderr(line: string): void {
    this.err.push(line);
  }
  onSignal(signal: SignalName, cb: () => void): () => void {
    const set = this.handlers.get(signal) ?? new Set();
    set.add(cb);
    this.handlers.set(signal, set);
    return () => set.delete(cb);
  }
  exit(code: number): void {
    this.exits.push(code);
  }
  run(cmd: string, args: readonly string[]): Promise<{ code: number }> {
    this.runs.push({ cmd, args });
    return this.runResult instanceof Error
      ? Promise.reject(this.runResult)
      : Promise.resolve(this.runResult);
  }
  signal(s: SignalName): void {
    for (const cb of this.handlers.get(s) ?? []) cb();
  }
  handlerCount(s: SignalName): number {
    return this.handlers.get(s)?.size ?? 0;
  }
}

describe('systemd unit', () => {
  it('renders every §7 hardening directive, a dedicated user and a single writable path', () => {
    const unit = renderSystemdUnit({
      user: 'nutflix',
      execStart: '/usr/bin/node /opt/nutflix/seeder.js',
      dataDir: '/var/lib/nutflix',
      environment: { NUTFLIX_SEEDER_DISK_CAP_BYTES: '1000' },
    });
    for (const d of [
      'NoNewPrivileges=yes',
      'ProtectSystem=strict',
      'ProtectHome=yes',
      'PrivateTmp=yes',
      'RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX',
      'User=nutflix',
      'Group=nutflix',
      'ReadWritePaths=/var/lib/nutflix',
      'Type=notify',
      'Environment=NUTFLIX_SEEDER_DATA_DIR=/var/lib/nutflix',
      'Environment=NUTFLIX_SEEDER_DISK_CAP_BYTES=1000',
      'ExecStart=/usr/bin/node /opt/nutflix/seeder.js',
    ])
      expect(unit).toContain(d);
    for (const d of HARDENING_DIRECTIVES) expect(unit).toContain(d);
    // deliberately absent: V8 JIT dies under it
    expect(unit).not.toMatch(/^MemoryDenyWriteExecute=/m);
    expect(unit.startsWith('[Unit]\n')).toBe(true);
    expect(unit).toContain('\n[Install]\nWantedBy=multi-user.target');
  });
});

describe('sdNotify', () => {
  it('is a no-op without NOTIFY_SOCKET and shells out to systemd-notify with it', async () => {
    const p = new FakeProcess();
    expect(await sdNotify(p, 'READY=1')).toBe(false);
    expect(p.runs).toEqual([]);
    p.vars.set('NOTIFY_SOCKET', '/run/systemd/notify');
    expect(await sdNotify(p, 'READY=1')).toBe(true);
    expect(await sdNotify(p, 'STOPPING=1')).toBe(true);
    expect(await sdNotify(p, 'STATUS=seeding 3 cores')).toBe(true);
    expect(p.runs.map((r) => r.args)).toEqual([
      ['--ready'],
      ['STOPPING=1'],
      ['--status=seeding 3 cores'],
    ]);
    const { logger, records } = capturedLogger();
    p.runResult = new Error('ENOENT');
    expect(await sdNotify(p, 'READY=1', logger)).toBe(false);
    expect(records.some((r) => r.msg === 'systemd-notify unavailable')).toBe(true);
  });
});

describe('installShutdownHooks', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('closes once on SIGTERM, notifies STOPPING, exits 0', async () => {
    const p = new FakeProcess();
    p.vars.set('NOTIFY_SOCKET', 'x');
    const { logger } = capturedLogger();
    let closes = 0;
    const off = installShutdownHooks({
      proc: p,
      logger,
      close: () => {
        closes++;
        return Promise.resolve();
      },
    });
    p.signal('SIGTERM');
    p.signal('SIGINT'); // second signal while closing: ignored
    await vi.advanceTimersByTimeAsync(0);
    expect(closes).toBe(1);
    expect(p.exits).toEqual([0]);
    expect(p.runs[0]?.args).toEqual(['STOPPING=1']);
    off();
    expect(p.handlerCount('SIGTERM')).toBe(0);
  });

  it('exits 1 when close hangs past the timeout or rejects', async () => {
    const p = new FakeProcess();
    const { logger } = capturedLogger();
    installShutdownHooks({
      proc: p,
      logger,
      close: () => new Promise(() => undefined),
      timeoutMs: 100,
    });
    p.signal('SIGHUP');
    await vi.advanceTimersByTimeAsync(100);
    expect(p.exits).toEqual([1]);

    const q = new FakeProcess();
    installShutdownHooks({ proc: q, logger, close: () => Promise.reject(new Error('boom')) });
    q.signal('SIGTERM');
    await vi.advanceTimersByTimeAsync(0);
    expect(q.exits).toEqual([1]);
  });
});

describe('parseDaemonEnv', () => {
  it('requires the data dir and validates numbers', () => {
    const p = new FakeProcess();
    expect(parseDaemonEnv(p)).toMatchObject({ ok: false });
    p.vars.set(ENV_DATA_DIR, '/var/lib/nutflix');
    expect(parseDaemonEnv(p)).toMatchObject({
      ok: true,
      config: { dataDir: '/var/lib/nutflix', swarm: {} },
    });
    p.vars.set(ENV_DISK_CAP, 'lots');
    expect(parseDaemonEnv(p)).toMatchObject({ ok: false });
    p.vars.set(ENV_DISK_CAP, '123');
    p.vars.set(ENV_MAX_STREAMS, '0');
    expect(parseDaemonEnv(p)).toMatchObject({ ok: false });
    p.vars.set(ENV_MAX_STREAMS, '7');
    expect(parseDaemonEnv(p)).toEqual({
      ok: true,
      config: {
        dataDir: '/var/lib/nutflix',
        diskCapBytes: 123,
        swarm: {},
        rateLimits: { maxStreams: 7 },
      },
    });
  });
});
