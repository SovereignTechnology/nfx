#!/usr/bin/env node
// Build-plan §7 / threat T12: "provenance where available".
//
// `npm audit signatures` verifies every registry signature and every provenance
// attestation that EXISTS, but says nothing about which packages have none. This report
// answers that: for every package in package-lock.json it asks the registry whether the
// exact installed version carries a Sigstore provenance attestation, and prints the
// direct dependencies of the workspace packages that do not — the list a reviewer reads
// on every bump. NETWORK REQUIRED (CI job `provenance`); never run from tests.
//
// Usage: node scripts/provenance-report.mjs [--json] [--fail-on-direct-missing]
//   --json                    machine-readable output
//   --fail-on-direct-missing  exit 1 if any DIRECT runtime dependency lacks provenance
//   --registry <url>          default https://registry.npmjs.org
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const CONCURRENCY = 12;

function parseArgs(argv) {
  const o = { json: false, failOnDirectMissing: false, registry: 'https://registry.npmjs.org' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') o.json = true;
    else if (argv[i] === '--fail-on-direct-missing') o.failOnDirectMissing = true;
    else if (argv[i] === '--registry') o.registry = argv[++i];
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return o;
}

async function fetchPackument(registry, name) {
  const res = await fetch(`${registry.replace(/\/$/, '')}/${name.replace('/', '%2F')}`, {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return res.json();
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

export async function report(opts) {
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
  const packages = lock.packages ?? {};
  const workspaces = Object.keys(packages).filter((k) => k !== '' && !k.includes('node_modules/'));
  const direct = new Set();
  for (const w of workspaces) {
    for (const d of Object.keys(packages[w].dependencies ?? {})) direct.add(d);
  }
  // one entry per name@version actually installed from a registry
  const installed = new Map();
  for (const [path, entry] of Object.entries(packages)) {
    if (!path.startsWith('node_modules/') || entry.link || !entry.version) continue;
    if (entry.resolved && !/^https?:\/\//.test(entry.resolved)) continue;
    const name = entry.name ?? path.slice(path.lastIndexOf('node_modules/') + 13);
    installed.set(`${name}@${entry.version}`, {
      name,
      version: entry.version,
      dev: !!entry.dev,
      optional: !!entry.optional,
    });
  }
  const byName = new Map();
  for (const v of installed.values()) {
    if (!byName.has(v.name)) byName.set(v.name, []);
    byName.get(v.name).push(v);
  }
  const names = [...byName.keys()].sort();
  const rows = [];
  const errors = [];
  await mapLimit(names, CONCURRENCY, async (name) => {
    let doc;
    try {
      doc = await fetchPackument(opts.registry, name);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
      return;
    }
    for (const v of byName.get(name)) {
      const dist = doc.versions?.[v.version]?.dist ?? {};
      rows.push({
        name,
        version: v.version,
        direct: direct.has(name),
        dev: v.dev,
        signed: Array.isArray(dist.signatures) && dist.signatures.length > 0,
        provenance: !!dist.attestations?.url,
      });
    }
  });
  rows.sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : a.version < b.version ? -1 : 1,
  );
  const summary = {
    packages: rows.length,
    signed: rows.filter((r) => r.signed).length,
    withProvenance: rows.filter((r) => r.provenance).length,
    direct: rows.filter((r) => r.direct).length,
    directWithProvenance: rows.filter((r) => r.direct && r.provenance).length,
    directRuntimeMissing: rows
      .filter((r) => r.direct && !r.dev && !r.provenance)
      .map((r) => `${r.name}@${r.version}`),
    errors,
  };
  return { summary, rows };
}

async function main(argv) {
  const opts = parseArgs(argv);
  const { summary, rows } = await report(opts);
  if (opts.json) {
    process.stdout.write(JSON.stringify({ summary, rows }, null, 2) + '\n');
  } else {
    process.stdout.write(
      `provenance-report: ${summary.packages} packages, ${summary.signed} registry-signed, ` +
        `${summary.withProvenance} with provenance attestations; ` +
        `direct deps ${summary.directWithProvenance}/${summary.direct} attested\n`,
    );
    const missing = rows.filter((r) => r.direct && !r.provenance);
    if (missing.length) {
      process.stdout.write('direct dependencies WITHOUT provenance (review on every bump):\n');
      for (const r of missing)
        process.stdout.write(`  ${r.name}@${r.version}${r.dev ? ' (dev)' : ''}\n`);
    }
    for (const e of summary.errors) process.stderr.write(`  warn: ${e}\n`);
  }
  if (summary.errors.length) return 2;
  if (opts.failOnDirectMissing && summary.directRuntimeMissing.length) return 1;
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(
        `provenance-report: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(2);
    },
  );
}
