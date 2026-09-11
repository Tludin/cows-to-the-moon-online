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

**The home/lobby screen had a farmpunk/farmtech redesign pass on
2026-09-10 (both the panel and the `MenuTable` backdrop), and BOTH HALVES
WERE REVERTED on 2026-09-11** after a look at the live result — net effect,
`Home`/`Lobby`/`MenuTable` are back to exactly what's described below (the
translucent paper panel, the spinning table + frozen game). The farmpunk
panel isn't lost, just not live: it's saved at commit `e470646` on
`improved_graphics`, tagged `menu-panel-farmpunk` — a weathered wood-plank
frame with a rust-streaked paper ledger nailed to it (screws, a duct-tape
patch, punch holes that show the wood frame through them, an "Approved /
County / Rocketry Board" stamp). `git checkout menu-panel-farmpunk --
client/app.js client/styles.css` brings it back. Full build notes (incl.
two load-bearing CSS fixes worth knowing before restoring it) in
`../CLAUDE.md`'s Phase 4/5 item 4. A from-scratch grass-field replacement
for the backdrop was also built and reviewed live in the same session, but
was never committed — it exists nowhere in git history, so restoring that
idea means rebuilding it, not checking it out.

Piece/cow arrangement (in-game) is COSMETIC only — the engine still owns
rocket completeness and launching. Needs a live browser playtest (the build
sandbox can't run one). Full detail in `../CLAUDE.md` → "Phase 4/5 —
Tabletop Realism Redesign" (supersedes the layout/material parts of the
older "Phase 4/5 — Tabletop UI & Art" section, which still covers
component-level behavior). Remaining Phase 5: audio, real animations for
launch/landing, real-time Cownter mode.

**A full Rules / "How to Play" page landed 2026-09-11** — a new `Rules`
component (`app.js`) reached via a "How to play" link on `Home` and a
floating "?" during a game (`Game`), both toggling one client-only
`showRules` boolean in `App()` (never touches the server). Full-screen,
independently scrolling, real rulebook content (adapted from
`../Cows_To_the_Moon_Rules_Revised__Edited_.pdf`) plus an app-specific
"Using the Web App" section. See `../CLAUDE.md`'s dedicated section for
the z-index layering, the `.help-fab` corner-picking rationale, and the
mockup rounds that led to it.

Client gotcha (htm + React, no build): use `className` not `class`, and pass
`style` an object not a string — both break only at render time, which
`node --check` won't catch.
