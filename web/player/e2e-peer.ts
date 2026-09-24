/**
 * Test fixture for e2e-mesh.ts, never part of the player: a mesh peer that shares whatever
 * its origin gave it, verified or not. It uses the hash list only to name its swarms
 * (NFX-10 §2), so it meets honest viewers in theirs. Fed by a lying origin, it plays the
 * part of a peer serving tampered bytes.
 */
import Hls from 'hls.js';
import { HlsJsP2PEngine } from 'p2p-media-loader-hlsjs';

import { Anchor } from './src/verify';

const q = new URLSearchParams(location.search);
const origin = q.get('origin') ?? '';
const root = q.get('root') ?? '';
const tracker = q.get('tracker') ?? '';
const st = { ready: false, uploaded: 0, peers: 0, errors: [] as string[] };
(window as unknown as { __peer: typeof st }).__peer = st;

const anchor = await Anchor.load(origin, root);
const HlsWithP2P = HlsJsP2PEngine.injectMixin(Hls);
const hls = new HlsWithP2P({
  maxBufferLength: 120,
  maxMaxBufferLength: 120,
  p2p: {
    core: {
      announceTrackers: [tracker],
      rtcConfig: { iceServers: [] },
      streamSwarmIdBuilder: ({ runtimeId }: { runtimeId: string }) => anchor.streamSwarmId(runtimeId),
      // Everything over HTTP, far ahead, so there is plenty to share.
      highDemandTimeWindow: 120,
      httpDownloadTimeWindow: 120,
      simultaneousHttpDownloads: 2,
    },
    onHlsJsCreated(h: { p2pEngine: { addEventListener(n: string, f: (...a: never[]) => void): void } }) {
      h.p2pEngine.addEventListener('onChunkUploaded', (n: number) => {
        st.uploaded += n;
      });
      h.p2pEngine.addEventListener('onPeerConnect', () => {
        st.peers += 1;
      });
    },
  },
} as never) as Hls;
hls.on(Hls.Events.MANIFEST_PARSED, () => {
  hls.currentLevel = 0;
  st.ready = true;
});
hls.on(Hls.Events.ERROR, (_, d) => {
  if (d.fatal) st.errors.push(d.details);
});
hls.loadSource(`${origin}/${root}/master.m3u8`);
hls.attachMedia(document.getElementById('v') as HTMLVideoElement);
