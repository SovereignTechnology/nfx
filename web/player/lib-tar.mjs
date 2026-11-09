// web/player/lib-tar.mjs: write a tar whose bytes depend on the files' names and contents
// only, for lib-tar.sh. GNU tar's output depends on its version and options (the same flags
// gave different bytes on two hosts), so the archive is written here, byte by byte:
//
// - POSIX ustar members, in the order given (lib-tar.sh sorts the names), regular files only,
//   no directory entries and no pax or GNU extended headers;
// - mode 0644, uid and gid 0, empty user and group names, mtime 0, device numbers 0;
// - each member's data padded with zeros to 512 bytes, then two zero blocks, and no padding
//   to a record size.
//
//   node lib-tar.mjs <out.tar> <dir> <name>...
//
// Every name must be relative, plain (no `..`, no leading `/`), under 100 bytes, and name a
// regular file under <dir> that is not a symlink.
import { closeSync, lstatSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';

const [out, dir, ...names] = process.argv.slice(2);
if (!out || !dir || names.length === 0) {
  console.error('usage: node lib-tar.mjs <out.tar> <dir> <name>...');
  process.exit(2);
}

/** `n` as `width - 1` octal digits and a NUL. */
function octal(n, width) {
  const s = n.toString(8);
  if (s.length > width - 1) throw new Error(`${n} does not fit in ${width} bytes`);
  return s.padStart(width - 1, '0') + '\0';
}

function header(name, size) {
  const h = Buffer.alloc(512, 0);
  const put = (at, text) => h.write(text, at, 'ascii');
  const n = Buffer.from(name, 'utf8');
  if (n.length >= 100 || /[^\x21-\x7e]/.test(name)) throw new Error(`name not usable: ${name}`);
  n.copy(h, 0);
  put(100, octal(0o644, 8));
  put(108, octal(0, 8));
  put(116, octal(0, 8));
  put(124, octal(size, 12));
  put(136, octal(0, 12));
  put(148, '        '); // the checksum counts its own field as spaces
  put(156, '0'); // a regular file
  put(257, 'ustar\0');
  put(263, '00');
  put(329, octal(0, 8));
  put(337, octal(0, 8));
  let sum = 0;
  for (const b of h) sum += b;
  put(148, sum.toString(8).padStart(6, '0') + '\0 ');
  return h;
}

const fd = openSync(out, 'w', 0o644);
try {
  for (const name of names) {
    if (name.startsWith('/') || name.split('/').some((p) => p === '' || p === '.' || p === '..')) {
      throw new Error(`not a plain relative name: ${name}`);
    }
    const path = join(dir, name);
    const st = lstatSync(path);
    if (!st.isFile()) throw new Error(`not a regular file: ${name}`);
    const data = readFileSync(path);
    writeSync(fd, header(name, data.length));
    writeSync(fd, data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) writeSync(fd, Buffer.alloc(pad, 0));
  }
  writeSync(fd, Buffer.alloc(1024, 0));
} finally {
  closeSync(fd);
}
