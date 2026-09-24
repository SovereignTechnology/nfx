# Pre-push review: A2 test player (`web/player/`, 2026-09-23)

Scope: `web/player/` — `index.html`, `src/player.ts`, `src/verify.ts`, `e2e.ts`,
`package.json` and its lock, `tsconfig.json`.

Method: `differential-review` (the browser trust boundary) and `sharp-edges`.

## Adversarial pass

| Attack | Result |
|---|---|
| An origin or CDN serves wrong bytes | The loader fetches as `arraybuffer` and hashes before handing over; a mismatch becomes `onError`. Tested: a proxy flipping one byte in every segment has all of them rejected, and playback never starts (`currentTime` stays 0). |
| Partial data slipping through progressive loading | The wrapper passes no `onProgress` to the inner loader, and `progressive: false`. |
| A forged hash list | It must hash to `root`, which comes from the URL (in M1, the manifest's `root`, copied by the operator). |
| An unlisted file, or a URL that names no hash | Refused: every URL must be a listed content name or the master convenience URL. |
| Playlists changed by text decoding | Playlists are verified as bytes, then decoded strictly (`fatal: true`) for hls.js. |
| No WebCrypto (an insecure context) | The player refuses to run and never falls back to native HLS or to unverified bytes. |
| XSS via the query string | Inputs are set through `.value`, the log through `textContent`, and `root` is checked as 64 hex before use. |
| e2e side effects | Loopback and ephemeral ports only. Every child runs in its own process group and only those groups are killed. The work dir (holding the throwaway node key) is mode 0700 and deleted. Chromium runs headless in a fresh context, never a real profile. |

## Sharp edges carried forward

- **`root` is typed in, not resolved.** The M1 player trusts the `root` in its URL.
  Resolving a manifest `a` tag over Nostr and verifying it in the browser comes with
  the `nfx-proto` WASM bindings.
- **An insecure context cannot play** until those bindings land. Serve the page over
  HTTPS, or from localhost.
- **Not in CI.** The e2e needs Chromium, ffmpeg and a cargo build, and the typecheck
  needs `npm install`. Both are run by hand before a push.

Verdict: **no blocker.** The push waits for sovtech's OK.
