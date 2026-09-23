# Contract request — L5-Studio (against `CONTRACTS_VERSION = 3`)

**Status: requests for the v4 bump, none blocking.** The Studio screen ships against v3 with
screen props and honest copy as the workarounds (the way L5-Home handled `followedTags`).
Items are ordered by how much they would change the user experience.

## 1. Cancel an upload — `upload(…, opts?: { signal })`

`studio.upload(input, onProgress)` takes no abort signal, so **an upload cannot be stopped once
it starts**. The screen says exactly that while it runs, and offers no Cancel button (a button
that only stops *listening* would lie: ffmpeg would keep burning CPU and the video would still
be published).

Core is already most of the way there: `ProcessRunner.run` accepts a `signal` and the pipeline
maps an aborted runner to `MediaError('aborted')`, which the screen already words as "Upload
stopped — nothing was published". `runStudioUpload` just does not thread a signal through.

```ts
studio: {
  upload(
    input: UploadInput,
    onProgress: (p: UploadProgress) => void,
    opts?: {
      /** Aborts probing/transcoding/writing; publishing already under way is not undone. */
      readonly signal?: { readonly aborted: boolean; addEventListener(t: 'abort', cb: () => void): void };
      /** See 2. */
      readonly chooseThumbnail?: (candidates: readonly ThumbnailCandidate[]) => Promise<number | BlobLike>;
    },
  ): Promise<VideoManifest>;
}
```

## 2. Pick the thumbnail from the candidates — `opts.chooseThumbnail`

build-plan §6.1 Studio says "thumbnail pick", and the `thumbnails` progress stage delivers the
candidates — but `UploadInput.thumbnailChoice` must be decided **before** `upload()` is called,
and `runStudioUpload` resolves it immediately after emitting `thumbnails`. There is no moment
where a pick made from the candidates can reach the pipeline.

Shipped instead: before publishing the user chooses "A frame from the video" (candidate 0) or
"Your own image" (`thumbnailChoice: BlobLike`); during the upload the candidates render
read-only with the used one marked, plus the sentence "Choosing a different frame after
transcoding is not supported yet".

`media/upload.ts` `chooseThumbnail()` is already `async` and sits exactly between the
`thumbnails` event and the Hyperblobs writes, so awaiting a caller-supplied
`chooseThumbnail(candidates)` there is a small change. The screen would then make the candidate
strip a radio group with a "Use this frame" confirm.

Related: candidates are bare `string`s — on desktop, local file paths from the work dir. Please
type them as

```ts
interface ThumbnailCandidate { readonly url: string; readonly sha256?: Sha256Hex; readonly timeSec?: number }
```

so they can go through `adapter.image(url, sha256)` with a hash like every other image (T16),
and the desktop adapter's `image()` knows it must serve a work-dir file. Today the screen calls
`adapter.image(candidate)` with no hash.

## 3. A code on the progress error — `{ stage: 'error'; message; code? }`

`UploadProgress`'s `error` stage carries only `message`. The screen recognises "ffmpeg not
found" from the rejected promise's `code` (`MediaError`/`ProcessRunnerError`, also via
`cause`), and **falls back to matching the message** ("… could not spawn <file> (ENOENT)")
because an Electron IPC hop drops custom error properties. Adding
`code?: MediaErrorCode | 'relay-down' | 'no-signer'` to the `error` stage (and preserving it
across IPC) would let the screen stop parsing prose.

## 4. ffmpeg probe + path setting — `studio.ffmpeg()` and `Settings.ffmpegPath`

ADR 0005: no bundled ffmpeg; L6 resolves it from PATH "and an optional explicit path in
Settings", and Studio shows an "ffmpeg not found" state. v3 has neither half:

- **Probe.** Shipped as a screen prop, `ffmpeg?: { found; path?; version?; os? }` (+
  `onRecheckFfmpeg`), filled by the shell. With it the state shows **before** the form; without
  it the screen only learns from a failed upload. A contract method would let the screen own it:

  ```ts
  studio: {
    ffmpeg(): Promise<{
      readonly found: boolean;
      readonly path?: string;           // resolved binary, or the configured one that failed
      readonly version?: string;
      readonly os?: 'macos' | 'windows' | 'linux'; // which install steps to show first
    }>;
  }
  ```

  `platform === 'web'` would answer `{ found: true }` (not needed there) — or the method is
  optional on web.
- **Setting.** The state's primary action is "Set ffmpeg path in Settings" →
  `navigate({ name: 'settings' })`, but `Settings` has no field for it. Suggest
  `Settings.ffmpegPath?: string` (desktop only; `ffprobe` resolved next to it).

## 5. Re-attach to a running upload — `studio.uploads()` / `onUploads`

Progress arrives only through the `onProgress` callback of the original `upload()` call. The
screen keeps the run in `Studio` state so switching Studio tabs is fine, but leaving Studio
(or a shell that remounts it) loses the progress view while the upload keeps going. The screen
says so. A read-back would fix it:

```ts
studio: {
  uploads(): Promise<readonly { readonly id: string; readonly title: string; readonly progress: UploadProgress }[]>;
  onUploads(cb: (u: readonly { readonly id: string; readonly title: string; readonly progress: UploadProgress }[]) => void): Unsubscribe;
}
```

## 6. "First paid view" — `VideoStats.firstPaidAt?`

build-plan §6.4 step 5: "Studio shows: seeder count, first paid view, sats earned." Seeder
count (`seedersOnline`) and sats (`satsToCreator`, `satsByRendition`) exist; the first paid
view does not. Shipped: the Paid views tile says "No paid views yet" at 0. Suggest
`firstPaidAt?: UnixSeconds` (earliest kind 9321 for the video) on `VideoStats`.

## 7. Melt-out amount — `seeder.melt` returns only `{ paid }`

To show the amount **before** the user confirms ("price shown vs price charged"), the confirm
sheet asks `adapter.wallet.meltQuote(mint, bolt11)` for `amount` + `feeReserve`, then calls
`adapter.seeder.melt(mint, bolt11)` (which quotes again inside). That assumes seeder earnings
are swapped into `adapter.wallet` (true in the mock; `PaymentEngineSeeder.flush` says "swaps own
proofs into the wallet"). Please either state that in the contract, or give the seeder side its
own quote so the confirmed quote is the one that is paid:

```ts
seeder: {
  meltQuote(mint: MintUrl, bolt11: string): Promise<MeltQuote>;
  melt(quote: MeltQuote): Promise<{ readonly paid: boolean; readonly change: Sats }>;
}
```

## Not a contract item (orchestrator-owned `screens/shared/route.ts`)

`{ name: 'studio', tab: 'analytics' }` has no `videoId`, so "Analytics" for a given video is
local state, and a deep link cannot name the video. `videoId?: NostrEventId` on the `studio`
route would fix it; the screen would read it the way it reads `tab`.
