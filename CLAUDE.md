# Cows To The Moon — Online (code)

Full project handoff, status, decisions, and environment notes live one
folder up in `../CLAUDE.md` — read that first.

Quick facts: plain Node 22+, zero runtime dependencies, `npm test` (97
tests) and `npm start` (localhost:8080). Engine in `src/` (pure, no I/O),
networking in `server/`, React-via-CDN client in `client/` (app.js +
styles.css + art.json + art/, no build step), all card behavior defined in
`data/*.json`, rules calls in `DECISIONS.md`.

Phases 1–3 done. **Phase 4 (UX) built + redesigned + Phase 5 started** — the
client (on branch `improved_graphics`) is a 3D "tabletop realism" scene: a
wood-rimmed disc floating in a starfield, wood/felt/paper/brass materials, a
rotate/zoom camera, click-a-zone targeting (Cownter response is the only
remaining popup), native-WAAPI card-flight animation, and magnetic
rocket-piece snapping — plus real card + board art (via `art.json`). Piece/
cow arrangement is COSMETIC only — the engine still owns rocket completeness
and launching. Needs a live browser playtest (the build sandbox can't run
one). Full detail in `../CLAUDE.md` → "Phase 4/5 — Tabletop Realism Redesign
(2026-08-14)" (supersedes the layout/material parts of the older "Phase 4/5
— Tabletop UI & Art" section, which still covers component-level behavior).
Remaining Phase 5: audio, real animations for launch/landing, real-time
Cownter mode.

Client gotcha (htm + React, no build): use `className` not `class`, and pass
`style` an object not a string — both break only at render time, which
`node --check` won't catch.
