/**
 * Process adapter: the daemon's contact surface with the host (stdio, env, signals,
 * child processes, exit). Node implementation in `adapters/node/`; L6 swaps in
 * `bare-process` / `bare-subprocess`.
 */
export type SignalName = 'SIGTERM' | 'SIGINT' | 'SIGHUP';

export interface SeederProcess {
  readonly argv: readonly string[];
  env(name: string): string | undefined;
  writeStdout(line: string): void;
  writeStderr(line: string): void;
  onSignal(signal: SignalName, cb: () => void): () => void;
  exit(code: number): void;
  /** Run a child to completion. Only used for `systemd-notify`. */
  run(cmd: string, args: readonly string[]): Promise<{ readonly code: number }>;
}
