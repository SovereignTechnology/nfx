# Frontend design reference (build-plan §6.3)

Supplied by sovtech on 2026-09-05 as a written brief: no files or mock-ups; the reference
is how YouTube and Rumble work and feel, a clean experience like those mainstream sites.

## What that means for L4 / L5

- **Reference sites: YouTube and Rumble.** Layout, information density, navigation model,
  card grid, watch page (player + title/channel/actions row + description + comments,
  related list on the right at desktop width), channel page tabs, search results list,
  Shorts vertical feed, Library, Studio upload flow, Settings — follow those two sites'
  conventions. Where they differ, prefer YouTube's; Rumble is the second reference.
- **"Clean, like the mainstream sites"**: no experimental layouts, no novelty chrome. The
  differences from YouTube are the *content* Nutflix adds — the price/`SatsBadge` shown
  before playback, `MintChip`, `PeerMeter`, wallet balance — rendered as ordinary UI
  elements in those same layouts, not as a separate "crypto" visual language.
- No files, palette, type or brand assets were supplied. L4 chooses defaults that match the
  brief (neutral palette with light + dark themes, a system UI font stack, YouTube-like
  density and radii) and **records every such choice in the lane report (not published)** so sovtech can
  react to the PNGs in `artifacts/screens/` (execution plan §0 rule 8) rather than to JSX.
- **Theme (sovtech, 2026-09-05, ADR 0005): light + dark, follow the system
  (`prefers-color-scheme`), with a user toggle in Settings.** Both themes are token sets.
- Anything in this file beyond the quoted brief and the theme answer is the orchestrator's
  reading of it, not a requirement from sovtech. Open styling questions go to sovtech via `docs/status.md` "Inputs
  still needed", not into invented spec.
