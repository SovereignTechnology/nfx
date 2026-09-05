/**
 * Parses ffmpeg `-progress pipe:2` output (key=value per line). Verified against n8.1.2:
 * `out_time_us=3000000`, `out_time_ms=3000000` (also µs — a long-standing ffmpeg quirk),
 * `out_time=00:00:03.000000`, `fps=0.00`, `progress=continue|end`.
 */

export interface ProgressSample {
  readonly outTimeSec?: number;
  readonly fps?: number;
  readonly end?: boolean;
}

export function parseProgressLine(line: string): ProgressSample | undefined {
  const eq = line.indexOf('=');
  if (eq <= 0) return undefined;
  const key = line.slice(0, eq).trim();
  const value = line.slice(eq + 1).trim();
  switch (key) {
    case 'out_time_us':
    case 'out_time_ms': {
      const n = Number(value);
      return Number.isFinite(n) && n >= 0 ? { outTimeSec: n / 1_000_000 } : undefined;
    }
    case 'out_time': {
      const m = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(value);
      if (!m) return undefined;
      const sec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
      return Number.isFinite(sec) ? { outTimeSec: sec } : undefined;
    }
    case 'fps': {
      const n = Number(value);
      return Number.isFinite(n) ? { fps: n } : undefined;
    }
    case 'progress':
      return { end: value === 'end' };
    default:
      return undefined;
  }
}

/** Folds progress lines into a monotone percentage for one rendition. */
export class ProgressTracker {
  private lastPercent = 0;
  private lastFps: number | undefined;

  constructor(
    private readonly durationSec: number,
    private readonly emit: (percent: number, fps?: number) => void,
  ) {}

  line(line: string): void {
    const s = parseProgressLine(line);
    if (!s) return;
    if (s.fps !== undefined && s.fps > 0) this.lastFps = s.fps;
    if (s.outTimeSec !== undefined && this.durationSec > 0) {
      const pct = Math.min(100, Math.floor((s.outTimeSec / this.durationSec) * 100));
      if (pct > this.lastPercent) {
        this.lastPercent = pct;
        this.emit(pct, this.lastFps);
      }
    }
    if (s.end && this.lastPercent < 100) {
      this.lastPercent = 100;
      this.emit(100, this.lastFps);
    }
  }
}
