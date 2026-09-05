import { describe, expect, it } from 'vitest';

import type { ProcessRunner } from '@sovit/core';

import {
  LineSplitter,
  ProcessRunnerError,
  createBareProcessRunner,
} from '../bare-process-runner.js';
import type { BareReadable, BareSpawn, BareSubprocessHandle } from '../bare-subprocess-types.js';

/**
 * A fake `bare-subprocess.spawn`. Mirrors the real module's observable behaviour:
 * synchronous throw with `code` on spawn failure, `exit` then `close` on completion,
 * `'data'` chunks as Uint8Array on streamx pipes.
 */
type Listener = (...args: never[]) => void;

class FakePipe implements BareReadable {
  private readonly listeners = new Map<string, Listener[]>();
  on(event: string, listener: Listener): this {
    const l = this.listeners.get(event) ?? [];
    l.push(listener);
    this.listeners.set(event, l);
    return this;
  }
  emit(event: string, ...args: unknown[]): void {
    for (const l of this.listeners.get(event) ?? []) (l as (...a: unknown[]) => void)(...args);
  }
}

class FakeHandle implements BareSubprocessHandle {
  readonly pid = 4242;
  readonly stdout = new FakePipe();
  readonly stderr = new FakePipe();
  readonly killed: (number | string | undefined)[] = [];
  private readonly listeners = new Map<string, Listener[]>();
  on(event: string, listener: Listener): this {
    const l = this.listeners.get(event) ?? [];
    l.push(listener);
    this.listeners.set(event, l);
    return this;
  }
  emit(event: string, ...args: unknown[]): void {
    for (const l of this.listeners.get(event) ?? []) (l as (...a: unknown[]) => void)(...args);
  }
  kill(signum?: number | string): void {
    this.killed.push(signum);
  }
}

interface SpawnRecord {
  file: string;
  args: readonly string[];
  opts: Parameters<BareSpawn>[2];
  handle: FakeHandle;
}

function fakeSpawn(script?: (rec: SpawnRecord) => void): {
  spawn: BareSpawn;
  records: SpawnRecord[];
} {
  const records: SpawnRecord[] = [];
  const spawn: BareSpawn = (file, args, opts) => {
    const handle = new FakeHandle();
    const rec = { file, args, opts, handle };
    records.push(rec);
    script?.(rec);
    return handle;
  };
  return { spawn, records };
}

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

describe('createBareProcessRunner', () => {
  it('spawns argv-only with piped stdout/stderr and no shell', async () => {
    const { spawn, records } = fakeSpawn((rec) => {
      queueMicrotask(() => {
        rec.handle.stdout.emit('data', enc('{"streams":[]}'));
        rec.handle.emit('exit', 0, null);
        rec.handle.emit('close', 0, null);
      });
    });
    const runner: ProcessRunner = createBareProcessRunner(spawn);
    const hostile = "/in/$(id); rm -rf ~ 'x'.mp4";
    const r = await runner.run('/opt/ffmpeg/ffprobe', ['-print_format', 'json', hostile], {
      cwd: '/work',
    });
    expect(r.exitCode).toBe(0);
    expect(dec(r.stdout)).toBe('{"streams":[]}');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      file: '/opt/ffmpeg/ffprobe',
      args: ['-print_format', 'json', hostile],
      opts: { stdio: ['ignore', 'pipe', 'pipe'], shell: false, cwd: '/work' },
    });
    // the args array handed to spawn is a copy, and the hostile path is one element
    expect(records[0]?.args.at(-1)).toBe(hostile);
  });

  it('streams stderr lines (split on \\r and \\n) and returns the full stderr + exit code', async () => {
    const { spawn } = fakeSpawn((rec) => {
      queueMicrotask(() => {
        rec.handle.stderr.emit('data', enc('frame=1 time=00:00:01\rout_time_us=100'));
        rec.handle.stderr.emit('data', enc('0000\nprogress=end\n'));
        rec.handle.emit('exit', 1, null);
        rec.handle.emit('close', 1, null);
      });
    });
    const lines: string[] = [];
    const r = await createBareProcessRunner(spawn).run('ffmpeg', ['-i', 'x'], {
      onStderrLine: (l) => lines.push(l),
    });
    expect(r.exitCode).toBe(1);
    expect(lines).toEqual(['frame=1 time=00:00:01', 'out_time_us=1000000', 'progress=end']);
    expect(r.stderr).toBe('frame=1 time=00:00:01\rout_time_us=1000000\nprogress=end\n');
  });

  it('S-C finding 9: a SYNCHRONOUS throw from spawn (ENOENT) becomes a ProcessRunnerError rejection', async () => {
    const spawn: BareSpawn = () => {
      const err = new Error('no such file or directory') as Error & { code: string };
      err.code = 'ENOENT';
      throw err;
    };
    const runner = createBareProcessRunner(spawn);
    let caught: unknown;
    try {
      await runner.run('/missing/ffmpeg', ['-version']);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProcessRunnerError);
    expect(caught).toMatchObject({
      name: 'ProcessRunnerError',
      code: 'spawn-failed',
      errno: 'ENOENT',
      file: '/missing/ffmpeg',
      message: 'no such file or directory',
    });
    expect((caught as Error).cause).toBeInstanceOf(Error);
  });

  it('a throw without a uv code still maps to spawn-failed (no errno)', async () => {
    const spawn: BareSpawn = () => {
      throw new Error('IPC_CHANNEL_ALREADY_DEFINED: Only one IPC channel per subprocess');
    };
    await expect(createBareProcessRunner(spawn).run('ffmpeg', [])).rejects.toMatchObject({
      code: 'spawn-failed',
      errno: undefined,
    });
  });

  it("an async 'error' event also rejects with spawn-failed", async () => {
    const { spawn } = fakeSpawn((rec) => {
      queueMicrotask(() => {
        rec.handle.emit('error', new Error('pipe broke'));
      });
    });
    await expect(createBareProcessRunner(spawn).run('ffmpeg', [])).rejects.toMatchObject({
      code: 'spawn-failed',
      message: 'pipe broke',
    });
  });

  it('signal termination (exit code null) is reported as -1', async () => {
    const { spawn } = fakeSpawn((rec) => {
      queueMicrotask(() => {
        rec.handle.emit('exit', null, 'SIGSEGV');
        rec.handle.emit('close', null, 'SIGSEGV');
      });
    });
    const r = await createBareProcessRunner(spawn).run('ffmpeg', []);
    expect(r.exitCode).toBe(-1);
  });

  it('abort kills the child with SIGKILL and rejects with aborted; pre-aborted never spawns', async () => {
    const { spawn, records } = fakeSpawn();
    const ac = new AbortController();
    const p = createBareProcessRunner(spawn).run('ffmpeg', ['-i', 'x'], { signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: 'aborted' });
    expect(records[0]?.handle.killed).toEqual(['SIGKILL']);
    // a late close after abort is ignored
    records[0]?.handle.emit('close', 0, null);

    const { spawn: spawn2, records: records2 } = fakeSpawn();
    await expect(
      createBareProcessRunner(spawn2).run('ffmpeg', [], { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ code: 'aborted' });
    expect(records2).toHaveLength(0);
  });

  it('passes an explicit env through to spawn', async () => {
    const { spawn, records } = fakeSpawn((rec) => {
      queueMicrotask(() => {
        rec.handle.emit('close', 0, null);
      });
    });
    await createBareProcessRunner(spawn, { env: { PATH: '/nowhere' } }).run('ffmpeg', []);
    expect(records[0]?.opts.env).toEqual({ PATH: '/nowhere' });
  });

  it('LineSplitter buffers partial lines across chunks', () => {
    const got: string[] = [];
    const s = new LineSplitter((l) => got.push(l));
    s.push('a');
    s.push('b\r\nc');
    s.flush();
    expect(got).toEqual(['ab', 'c']);
  });
});
