import type { Rendition, VideoManifest } from '../contracts/manifest.js';
import type {
  BlobSink,
  FsAdapter,
  MediaPipeline,
  MediaProbe,
  RenditionSpec,
  TranscodeOutput,
} from '../contracts/media.js';
import type { UploadInput, UploadProgress } from '../contracts/network-adapter.js';
import type { Sha256Hex } from '../contracts/primitives.js';
import { MediaError } from './errors.js';
import type { Sha256Factory } from './types.js';

/**
 * `Studio.upload`-shaped orchestration (contracts/network-adapter.ts `studio.upload`) for
 * the desktop path, where `input.file` is a local path. Drives the pipeline end to end and
 * maps `TranscodeProgress` onto `UploadProgress`. The NIP-71 event itself is built and
 * signed by the manifest lane (L1): this function hands it a fully hashed `UploadDraft` via
 * the injected `publish` and returns whatever verified manifest comes back.
 */

/** A rendition with everything the media side knows; Blossom-dependent fields are left to L1. */
export type RenditionDraft = Omit<Rendition, 'image' | 'captions' | 'storyboard'>;

export interface UploadDraft {
  readonly input: UploadInput;
  readonly probe: MediaProbe;
  readonly output: TranscodeOutput;
  readonly renditions: readonly RenditionDraft[];
  /** Chosen thumbnail: a pipeline candidate (path) or user-supplied bytes; sha256 is the Blossom `x`. */
  readonly thumbnail:
    | { readonly kind: 'candidate'; readonly path: string; readonly sha256: Sha256Hex }
    | { readonly kind: 'custom'; readonly bytes: Uint8Array; readonly sha256: Sha256Hex };
  readonly storyboard?: TranscodeOutput['storyboard'];
  readonly workDir: string;
}

export interface StudioUploadDeps {
  readonly pipeline: MediaPipeline;
  /** Hyperblobs sink; one per rendition if the seeder wants separate cores. */
  readonly sink: BlobSink | ((spec: RenditionSpec) => BlobSink);
  /** L1/L2: build + sign the NIP-71 event, start seeding, return the verified manifest. */
  readonly publish: (draft: UploadDraft) => Promise<VideoManifest>;
  /** Optional BUD-02 mirror per server; `false` = that server failed (reported, not fatal). */
  readonly mirror?: (server: string, draft: UploadDraft, video: VideoManifest) => Promise<boolean>;
  readonly sha256: Sha256Factory;
  readonly fs: FsAdapter;
  readonly workDir?: string;
  /** Remove the work directory after a successful publish. Default false. */
  readonly removeWorkDir?: boolean;
  readonly planOpts?: { readonly maxHeight?: number; readonly codec?: RenditionSpec['codec'] };
}

const mimeFor = (c: RenditionSpec['container']): Rendition['mime'] =>
  c === 'webm' ? 'video/webm' : 'video/mp4';

/** Wraps a sink so the orchestrator can report `writing` percent without touching the pipeline. */
function countingSink(sink: BlobSink, total: number, onBytes: (done: number) => void): BlobSink {
  return {
    put(chunks, opts) {
      let done = 0;
      async function* counted(): AsyncGenerator<Uint8Array> {
        for await (const c of chunks) {
          done += c.length;
          onBytes(total > 0 ? Math.min(100, Math.floor((done / total) * 100)) : 100);
          yield c;
        }
      }
      return sink.put(counted(), opts);
    },
  };
}

export async function runStudioUpload(
  input: UploadInput,
  onProgress: (p: UploadProgress) => void,
  deps: StudioUploadDeps,
): Promise<VideoManifest> {
  try {
    if (typeof input.file !== 'string') {
      throw new MediaError(
        'unsupported-input',
        'desktop upload needs a local path; web uploads transcode at the gateway',
      );
    }
    const path = input.file;
    const { pipeline, fs } = deps;

    onProgress({ stage: 'probing' });
    const probe = await pipeline.probe(path);
    const plan = pipeline.plan(probe, deps.planOpts);
    const workDir = deps.workDir ?? (await fs.mkdtemp('nutflix-upload-'));

    const output = await pipeline.transcode(
      path,
      plan,
      (p) => {
        switch (p.stage) {
          case 'rendition':
            onProgress({ stage: 'transcoding', rendition: p.label, percent: p.percent });
            break;
          case 'thumbnails':
            // candidates are reported once all exist (see below)
            break;
          case 'probe':
          case 'storyboard':
          case 'hash':
          case 'write':
            break;
        }
      },
      { workDir },
    );
    onProgress({ stage: 'thumbnails', candidates: output.thumbnails.map((t) => t.path) });

    // ---- thumbnail choice ---------------------------------------------------------------
    const thumbnail = await chooseThumbnail(input, output, deps.sha256);

    // ---- Hyperblobs writes ----------------------------------------------------------------
    const renditions: RenditionDraft[] = [];
    for (const r of output.renditions) {
      const base = typeof deps.sink === 'function' ? deps.sink(r.spec) : deps.sink;
      onProgress({ stage: 'writing', rendition: r.spec.label, percent: 0 });
      const sink = countingSink(base, r.size, (percent) => {
        onProgress({ stage: 'writing', rendition: r.spec.label, percent });
      });
      const written = await pipeline.publish(r, sink);
      renditions.push({
        label: r.spec.label,
        mime: mimeFor(r.spec.container),
        sha256: written.sha256,
        size: written.size,
        width: r.width,
        height: r.height,
        bitrateKbps: r.spec.videoBitrateKbps + r.spec.audioBitrateKbps,
        hyper: written.hyper,
        hyperUrl: written.hyperUrl,
        fallbacks: [],
        placeholder: output.placeholderDataUrl,
      });
    }

    const draft: UploadDraft = {
      input,
      probe,
      output,
      renditions,
      thumbnail,
      ...(output.storyboard ? { storyboard: output.storyboard } : {}),
      workDir,
    };

    onProgress({ stage: 'publishing' });
    const video = await deps.publish(draft);

    if (deps.mirror && input.mirrorTo) {
      for (const server of input.mirrorTo) {
        let ok = false;
        try {
          ok = await deps.mirror(server, draft, video);
        } catch {
          ok = false;
        }
        onProgress({ stage: 'mirroring', server, ok });
      }
    }

    if (deps.removeWorkDir === true) await fs.rm(workDir, { recursive: true });

    onProgress({ stage: 'done', video });
    return video;
  } catch (e) {
    onProgress({ stage: 'error', message: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}

async function chooseThumbnail(
  input: UploadInput,
  output: TranscodeOutput,
  sha256: Sha256Factory,
): Promise<UploadDraft['thumbnail']> {
  const choice = input.thumbnailChoice;
  if (choice !== undefined && typeof choice !== 'number') {
    const bytes = new Uint8Array(await choice.arrayBuffer());
    const h = sha256();
    h.update(bytes);
    return { kind: 'custom', bytes, sha256: h.digest() };
  }
  const idx =
    typeof choice === 'number' && Number.isInteger(choice)
      ? Math.min(Math.max(0, choice), output.thumbnails.length - 1)
      : 0;
  const t = output.thumbnails[idx];
  if (!t) throw new MediaError('process-failed', 'pipeline produced no thumbnail candidates');
  return { kind: 'candidate', path: t.path, sha256: t.sha256 };
}
