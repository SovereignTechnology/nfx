// Node implementation of SeederProcess. The only file in the seeder that imports
// `node:child_process` or touches `process` signals/stdio.
import { spawn } from 'node:child_process';
import process from 'node:process';

import type { SeederProcess, SignalName } from '../process.js';

export const nodeProcess: SeederProcess = {
  argv: process.argv,
  env: (name) => process.env[name],
  writeStdout: (line) => {
    process.stdout.write(line + '\n');
  },
  writeStderr: (line) => {
    process.stderr.write(line + '\n');
  },
  onSignal: (signal: SignalName, cb) => {
    process.on(signal, cb);
    return () => {
      process.off(signal, cb);
    };
  },
  exit: (code) => {
    process.exit(code);
  },
  run: (cmd, args) =>
    new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { stdio: 'ignore' });
      child.once('error', reject);
      child.once('exit', (code) => {
        resolve({ code: code ?? -1 });
      });
    }),
};
