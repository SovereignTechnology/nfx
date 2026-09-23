/**
 * Our own WebTorrent tracker (S3): bittorrent-tracker's WebSocket server, admitting only
 * the swarms of NFX videos it knows. Each rendition is one swarm whose stream swarm ID is
 * `nfx/1/web/<namespace>:<video-id>/<rendition-id>`; the infohash is computed exactly as
 * p2p-media-loader v4 announces it (`computeInfoHash`, base64(sha1(id)[0..15])).
 *
 * Usage: npx tsx tracker.ts <port> <hashlist.json>[,<hashlist.json>…]
 * Prints JSON lines: {"event":"allow"|"reject"|"listening", …}.
 */
import { readFileSync } from 'node:fs';
import Server from 'bittorrent-tracker/server';
import { computeInfoHash } from 'p2p-media-loader-core/server';

const [portArg, listsArg] = process.argv.slice(2);
if (!portArg || !listsArg) {
  console.error('usage: tracker.ts <port> <hashlist.json>[,…]');
  process.exit(2);
}

/** The NFX stream swarm ID for one rendition (proposed NFX-10 §2 replacement). */
export const streamSwarmId = (video: string, renditionId: string): string => `nfx/1/web/${video}/${renditionId}`;

const allowed = new Map<string, string>(); // tracker-side hex of the 20 ASCII chars -> swarm id
for (const path of listsArg.split(',')) {
  const list = JSON.parse(readFileSync(path, 'utf8')) as { video: string; renditions: { id: string }[] };
  for (const r of list.renditions) {
    const id = streamSwarmId(list.video, r.id);
    allowed.set(Buffer.from(computeInfoHash(id), 'latin1').toString('hex'), id);
  }
}

const log = (o: object): void => console.log(JSON.stringify(o));
const server = new Server({
  udp: false,
  http: false,
  ws: true,
  stats: false,
  filter(infoHash: string, _params: unknown, cb: (err: Error | null) => void) {
    const id = allowed.get(infoHash);
    if (id) {
      log({ event: 'allow', infoHash, swarm: id });
      cb(null);
    } else {
      log({ event: 'reject', infoHash });
      cb(new Error('not an NFX swarm'));
    }
  },
});
server.on('error', (e: Error) => log({ event: 'error', error: String(e) }));
server.on('warning', (e: Error) => log({ event: 'warning', error: String(e) }));
server.listen(Number(portArg), '0.0.0.0', () =>
  log({ event: 'listening', port: Number(portArg), swarms: [...allowed.values()] }),
);
