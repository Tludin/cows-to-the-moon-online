# Cows To The Moon — Online (code)

Full project handoff, status, decisions, and environment notes live one
folder up in `../CLAUDE.md` — read that first.

Quick facts: plain Node 22+, zero runtime dependencies, `npm test` (97
tests) and `npm start` (localhost:8080). Engine in `src/` (pure, no I/O),
networking in `server/`, React-via-CDN client in `client/` (app.js +
styles.css + art.json + art/, no build step), all card behavior defined in
`data/*.json`, rules calls in `DECISIONS.md`.

Phases 1–3 done. **Phase 4 (UX) built + Phase 5 started** — the client is a
calm muted-felt three-column tabletop (big launch pad | moon-above-farm | pile
cluster) with real card + board art (via `art.json`) and a tactile drag layer
(rocket pieces and cow tokens can be picked up, moved, and snapped into place).
The drag layer is COSMETIC only — the engine still owns rocket completeness and
launching. Needs a live browser playtest (the build sandbox can't run one).
Full detail in `../CLAUDE.md` → "Phase 4/5 — Tabletop UI & Art". Remaining
Phase 5: audio, real animations, real-time Cownter mode.

Client gotcha (htm + React, no build): use `className` not `class`, and pass
`style` an object not a string — both break only at render time, which
`node --check` won't catch.
