# Cows To The Moon — Online (code)

Full project handoff, status, decisions, and environment notes live one
folder up in `../CLAUDE.md` — read that first.

Quick facts: plain Node 22+, zero runtime dependencies, `npm test` (106
tests, run without `--test-force-exit` for a stable count — see
`../CLAUDE.md`) and `npm start` (localhost:8080). Engine in `src/` (pure, no
I/O), networking in `server/`, React-via-CDN client in `client/` (app.js +
styles.css + art.json + art/, no build step), all card behavior defined in
`data/*.json`, rules calls in `DECISIONS.md`.

Phases 1–3 done. **Phase 4 (UX) built + redesigned + Phase 5 started** — the
client (on branch `improved_graphics`) is a "tabletop realism" scene: a
wood-rimmed disc floating in a starfield, wood/felt/paper/brass materials, a
drag-to-spin + zoom camera (tilt derives from zoom), click-a-zone targeting
(Cownter response is the only remaining popup), pieces that snap back to
their own home slot when dragged — plus real card + board art (via
`art.json`). There is NO card-flight animation, no piece-to-piece magnetic
snapping, no menu idle-spin scene, and no `prefers-reduced-motion` fallback
— an earlier version of this doc claimed all four; same-day follow-up
commits on the redesign branch removed them before this doc was corrected
(2026-09-09). Piece/cow arrangement is COSMETIC only — the engine still owns
rocket completeness and launching. Needs a live browser playtest (the build
sandbox can't run one). Full detail in `../CLAUDE.md` → "Phase 4/5 —
Tabletop Realism Redesign" (supersedes the layout/material parts of the
older "Phase 4/5 — Tabletop UI & Art" section, which still covers
component-level behavior). Remaining Phase 5: audio, real animations for
launch/landing, real-time Cownter mode.

Client gotcha (htm + React, no build): use `className` not `class`, and pass
`style` an object not a string — both break only at render time, which
`node --check` won't catch.
