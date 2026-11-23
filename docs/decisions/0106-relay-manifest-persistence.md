# 106. The embedded relay keeps manifests in plain files under the state directory

Date: 2026-11-23

## Status

Proposed 2026-11-23, with issue #114 and its PR.

## Context

- `nfxd --embed-relay` held every manifest in memory, so a restart emptied the relay. A seeder
  that resolves its videos from that relay then waited in `Resolving` until a creator published
  again. On the reference deployment this caused two outages, one of them 5.5 hours long.
- NFX-04 §7 allows an embedded relay to persist one thing: "only kind 38504 is ever persisted".
  Beacons stay ephemeral, and signaling carries viewers' connection data.
- A relay can be open to anonymous publishers, so whatever it writes must stay bounded, and a
  damaged file must never stop it from starting.

## Decision

1. **With an explicit `--state`, the relay keeps accepted manifests in
   `<state>/relay-manifests/`** (mode 0700). Without `--state`, behaviour is unchanged.
2. **One file per address, no database.** `<sha256 of the a-tag>.json` (mode 0600) holds the
   newest signed revision. The name is a hash, so nothing a publisher chooses reaches a path. A
   single snapshot file was rejected: it could mean rewriting up to about 1.3 GiB on each
   publish. An embedded database was rejected because it adds a locked dependency for a store
   this simple.
3. **A file grants nothing.** On load every event is checked again (id, signature, expiry) and
   put through the relay's current admission rules, without the publish budget. A manifest the
   current flags refuse is not served, and its file stays, so restoring the flag restores it.
4. **Replaceable rules hold across a restart.** The newest revision the current rules admit
   wins, a tie goes to the lowest id, and an older copy is refused. The one exception is a
   stored revision the rules refuse, for example after the clock was set back: it does not
   block an older revision they accept. That older revision is kept beside it in
   `<sha256 of the a-tag>.fallback` (mode 0600) and served. The refused file stays and replaces
   it at the first load whose rules admit it. A deletion that covers a revision removes it, and
   a newer accepted revision removes both, so neither can return when the clock catches up.
5. **Deletions stay honoured.** `deletions.jsonl` (mode 0600) records `{"a", "until"}` for each
   withdrawn address. It holds that date, not the signed kind-5 event, because §7 persists only
   kind 38504. An expired revision leaves its date there too, so the revision it replaced cannot
   return. A failed write of this file is retried on later batches of any kind, waiting 1 second
   and doubling up to 5 minutes.
6. **Writes are durable and bounded.** Temp file, fsync, rename, directory fsync, on one writer
   thread. `OK` waits for the disk for up to 5 seconds. At most 20,000 files of 64 KiB each,
   fallback files included, the same limits as the memory store. Past the limit, addresses with
   nothing to serve go first, then the oldest. A load keeps the newest valid records whatever
   order the directory lists them in, and removes only confirmed excess.
7. **Damage never stops a start.** Corrupt, truncated, oversized or badly signed files are logged
   and removed. Unreadable or non-regular files are logged and left alone.
8. **One writer per directory.** `nfxd` had no lock on `--state`, and the blob store's own lock
   is taken only after the relay has loaded. The relay now holds an exclusive lock on
   `relay-manifests` itself, from before it reads anything until its writer exits. The kernel
   releases it however the process ends. A relay that cannot get it within 5 seconds logs why
   and runs in memory, as it does with no state directory.

## Consequences

- A restart no longer empties the relay of manifests.
- After a restart the relay still refuses a withdrawn revision, but it no longer returns the
  kind-5 event to readers. Keeping it would need a decision on NFX-04 §7.
- An open relay run with `--state` can now be made to write to disk by anonymous publishers, up
  to about 1.3 GiB. `--allow-creator` removes that exposure. A full disk is logged and the relay
  keeps serving from memory.
- If a newer revision cannot be written, the older file stays and is served after a restart,
  although the publisher received `OK`. The failure is logged.
- If the directory sync fails after a rename, the new file is live but may not survive a power
  loss. The failure is logged and the sync is tried again with the next batch.
- Until a failed write of `deletions.jsonl` succeeds, a deletion holds in memory only, so a
  restart in that window can forget it.
- An expired revision ends any older fallback beside it, even one accepted after it was refused.
  This fails closed: the publisher has to send a new revision.
- Past the limit the oldest recorded deletions are dropped, as the oldest events are in memory,
  so on an open relay enough new deletions can age out an old one before a restart.
