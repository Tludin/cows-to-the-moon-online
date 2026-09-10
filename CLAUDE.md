# Cows To The Moon — Online (code)

Full project handoff, status, decisions, and environment notes live one
folder up in `../CLAUDE.md` — read that first.

Quick facts: plain Node 22+, zero runtime dependencies, `npm test` (106
tests, run without `--test-force-exit` for a stable count — see
`../CLAUDE.md`) and `npm start` (localhost:8080). Engine in `src/` (pure, no
I/O), networking in `server/`, React-via-CDN client in `client/` (app.js +
styles.css + art.json + art/ + menu-snapshot.json, no build step), all card
behavior defined in `data/*.json`, rules calls in `DECISIONS.md`.
`scripts/gen-menu-snapshot.ts` regenerates menu-snapshot.json from a real
bot-simulated game.

Phases 1–3 done. **Phase 4 (UX) built + redesigned + Phase 5 started** — the
in-game client (on branch `improved_graphics`) is a "tabletop realism" scene:
a wood-rimmed disc floating in a starfield, wood/felt/paper/brass materials, a
drag-to-spin + zoom camera (tilt derives from zoom), click-a-zone targeting
(Cownter response is the only remaining popup), pieces that snap back to
their own home slot when dragged — plus real card + board art (via
`art.json`). There is NO card-flight animation, no piece-to-piece magnetic
snapping, and no `prefers-reduced-motion` fallback.

**The home/lobby menu PANEL is a separate, unrelated redesign (2026-09-10,
farmpunk/farmtech).** `Home`/`Lobby` render as a weathered wood-plank frame
with a rust-streaked paper ledger nailed to it (screws, a duct-tape patch,
punch holes that show the wood frame through them, an "Approved / County /
Rocketry Board" stamp). Designed through ~15 rounds of live iteration
against a published Artifact mockup before being ported into
`client/app.js`/`client/styles.css` — see `../CLAUDE.md`'s Phase 4/5 item 4
for the full build notes. The BACKDROP behind it (`MenuTable`) is NOT part
of that redesign — a from-scratch grass-field version was built and
reviewed the same day, then reverted the same day back to the pre-existing
spinning table + frozen bot-simulated game (`client/menu-snapshot.json` +
`scripts/gen-menu-snapshot.ts`, both briefly deleted mid-session and
recreated byte-for-byte) once a look at the panel live showed the table had
stopped spinning, which wasn't wanted.

Piece/cow arrangement (in-game) is COSMETIC only — the engine still owns
rocket completeness and launching. Needs a live browser playtest (the build
sandbox can't run one). Full detail in `../CLAUDE.md` → "Phase 4/5 —
Tabletop Realism Redesign" (supersedes the layout/material parts of the
older "Phase 4/5 — Tabletop UI & Art" section, which still covers
component-level behavior). Remaining Phase 5: audio, real animations for
launch/landing, real-time Cownter mode.

Client gotcha (htm + React, no build): use `className` not `class`, and pass
`style` an object not a string — both break only at render time, which
`node --check` won't catch.
