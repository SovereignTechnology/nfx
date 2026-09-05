/**
 * Test doubles for the pipeline: an in-memory `FsAdapter`, a recording `ProcessRunner`
 * that answers by argv shape, an in-memory `BlobSink`, and synthetic MP4/ffprobe fixtures.
 * Runtime-agnostic (no `node:` imports) so the same fakes serve a Bare-side test later;
 * hashing is injected by the test (e.g. `nodeSha256`).
 */
import type { HyperblobRef } from '../../contracts/manifest.js';
import type { BlobSink, FsAdapter, ProcessRunner } from '../../contracts/media.js';
import type { CoreKeyHex } from '../../contracts/primitives.js';
import { ProcessRunnerError } from '../errors.js';

export class MemoryFs implements FsAdapter {
  readonly files = new Map<string, Uint8Array>();
  readonly removed: string[] = [];
  private tmpCounter = 0;

  set(path: string, data: Uint8Array | string): void {
    this.files.set(path, typeof data === 'string' ? new TextEncoder().encode(data) : data);
  }

  readFile(path: string): Promise<Uint8Array> {
    const f = this.files.get(path);
    if (!f) return Promise.reject(new Error(`ENOENT: ${path}`));
    return Promise.resolve(f);
  }
  writeFile(path: string, data: Uint8Array): Promise<void> {
    this.files.set(path, data);
    return Promise.resolve();
  }
  stat(path: string): Promise<{ readonly size: number }> {
    const f = this.files.get(path);
    if (!f) return Promise.reject(new Error(`ENOENT: ${path}`));
    return Promise.resolve({ size: f.length });
  }
  mkdtemp(prefix: string): Promise<string> {
    return Promise.resolve(`/tmp/${prefix}${String(++this.tmpCounter)}`);
  }
  rm(path: string): Promise<void> {
    this.removed.push(path);
    for (const k of [...this.files.keys()])
      if (k === path || k.startsWith(`${path}/`)) this.files.delete(k);
    return Promise.resolve();
  }
  readChunks(path: string, chunkSize: number): AsyncIterable<Uint8Array> {
    const f = this.files.get(path);
    return {
      async *[Symbol.asyncIterator]() {
        if (!f) throw new Error(`ENOENT: ${path}`);
        for (let i = 0; i < f.length; i += chunkSize) {
          await Promise.resolve();
          yield f.subarray(i, i + chunkSize);
        }
      },
    };
  }
}

export interface RecordedCall {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd?: string;
}

export type FakeHandler = (
  call: RecordedCall,
  emitStderr: (line: string) => void,
) =>
  | { exitCode?: number; stdout?: Uint8Array | string; stderr?: string }
  | Promise<{
      exitCode?: number;
      stdout?: Uint8Array | string;
      stderr?: string;
    }>;

/** Records every argv; `handler` decides the outcome (and may write files into `fs`). */
export class FakeRunner implements ProcessRunner {
  readonly calls: RecordedCall[] = [];
  constructor(private readonly handler: FakeHandler) {}

  async run(
    file: string,
    args: readonly string[],
    opts?: Parameters<ProcessRunner['run']>[2],
  ): ReturnType<ProcessRunner['run']> {
    const call: RecordedCall = { file, args: [...args], ...(opts?.cwd ? { cwd: opts.cwd } : {}) };
    this.calls.push(call);
    if (opts?.signal?.aborted) throw new ProcessRunnerError('aborted', file);
    const r = await this.handler(call, (l) => opts?.onStderrLine?.(l));
    const stdout =
      typeof r.stdout === 'string'
        ? new TextEncoder().encode(r.stdout)
        : (r.stdout ?? new Uint8Array());
    return { exitCode: r.exitCode ?? 0, stdout, stderr: r.stderr ?? '' };
  }
}

/** Minimal synthetic MP4 bytes: `ftyp` + `moov` + `mdat` (faststart) or `mdat` before `moov`. */
export function syntheticMp4(
  opts: { faststart: boolean; mdatSize?: number } = { faststart: true },
): Uint8Array {
  const mdat = box('mdat', new Uint8Array(opts.mdatSize ?? 1000));
  const moov = box('moov', new Uint8Array(200));
  const ftyp = box('ftyp', new TextEncoder().encode('isomiso2avc1mp41'));
  return concat(opts.faststart ? [ftyp, moov, mdat] : [ftyp, mdat, moov]);
}

export function box(type: string, payload: Uint8Array): Uint8Array {
  const size = 8 + payload.length;
  const out = new Uint8Array(size);
  out[0] = (size >>> 24) & 255;
  out[1] = (size >>> 16) & 255;
  out[2] = (size >>> 8) & 255;
  out[3] = size & 255;
  out.set(new TextEncoder().encode(type), 4);
  out.set(payload, 8);
  return out;
}

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** ffprobe-shaped JSON for a fake input or output. */
export function probeJson(o: {
  format?: string;
  duration?: number;
  bitrate?: number;
  video?: {
    codec?: string;
    width: number;
    height: number;
    fps?: string;
    rotation?: number;
    pix_fmt?: string;
  };
  audio?: { codec?: string; channels?: number; sampleRate?: number };
}): string {
  const streams: unknown[] = [];
  if (o.video) {
    streams.push({
      codec_type: 'video',
      codec_name: o.video.codec ?? 'h264',
      width: o.video.width,
      height: o.video.height,
      r_frame_rate: o.video.fps ?? '30/1',
      avg_frame_rate: o.video.fps ?? '30/1',
      pix_fmt: o.video.pix_fmt ?? 'yuv420p',
      disposition: { attached_pic: 0 },
      ...(o.video.rotation !== undefined
        ? { side_data_list: [{ side_data_type: 'Display Matrix', rotation: o.video.rotation }] }
        : {}),
    });
  }
  if (o.audio) {
    streams.push({
      codec_type: 'audio',
      codec_name: o.audio.codec ?? 'aac',
      channels: o.audio.channels ?? 2,
      sample_rate: String(o.audio.sampleRate ?? 48000),
    });
  }
  return JSON.stringify({
    streams,
    format: {
      format_name: o.format ?? 'mov,mp4,m4a,3gp,3g2,mj2',
      duration: o.duration !== undefined ? o.duration.toFixed(6) : undefined,
      bit_rate: o.bitrate !== undefined ? String(o.bitrate) : undefined,
    },
  });
}

/** A BlobSink that drains the chunks into memory and returns a fixed core key. */
export class MemorySink implements BlobSink {
  readonly puts: { bytes: Uint8Array; blockSize?: number }[] = [];
  constructor(private readonly core: string = 'a'.repeat(64)) {}
  async put(
    chunks: AsyncIterable<Uint8Array>,
    opts?: { readonly blockSize?: number },
  ): Promise<HyperblobRef> {
    const parts: Uint8Array[] = [];
    for await (const c of chunks) parts.push(c);
    const bytes = concat(parts);
    this.puts.push({
      bytes,
      ...(opts?.blockSize !== undefined ? { blockSize: opts.blockSize } : {}),
    });
    const blockSize = opts?.blockSize ?? 65_536;
    return {
      core: this.core as CoreKeyHex,
      blob: {
        byteOffset: 0,
        blockOffset: 0,
        blockLength: Math.ceil(bytes.length / blockSize),
        byteLength: bytes.length,
      },
    };
  }
}
