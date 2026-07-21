# Cows To The Moon — Online

Browser-based multiplayer adaptation of the card game. See the spec PDF in the
parent folder for the full plan.

## Status: Phase 4 UI ✅ + Phase 5 art/tactile started — needs a live playtest (Phases 1–3 ✅)

Phase 1 delivered the rules engine as a standalone, fully tested TypeScript
module. Phase 2 wraps it in a WebSocket server with code-based rooms and a
browser client. Phase 3 added the robustness layer: reconnection (refresh,
dropped connection, or closed tab — via saved tokens, "Rejoin" buttons, or
re-entering the code with your original name), a 30s Cownter auto-pass, a 90s
turn auto-skip with AFK marking after 2 idle turns ("I'm back!" to return), a
whole-room inactivity timeout, and automatic cleanup of dead rooms.

**Phase 4/5** made the client a calm, muted-felt three-column tabletop: a big
launch pad on the left, the moon above the farm in the middle, and the deck/
discard + rocket store clustered on the right. Real card and board art render
via `art.json`, and there's a tactile drag layer — rocket pieces and cow tokens
can be picked up, moved around, and snapped into place (assemble-the-rocket
feel). The hand peeks up from the bottom; click a card to view it big, drag up
to play, drag sideways to reorder; targeted cards use a player-pick popup or
click-a-zone. It's presentation only — the engine/protocol are unchanged (the
one exception is the incremental Draw Phase), and the drag layer is cosmetic
(the engine still owns rocket completeness and launching). Still needs a real
browser playtest (the sandbox can't run one). Details in `../CLAUDE.md` →
"Phase 4/5 — Tabletop UI & Art". Runs on plain Node 22+, no npm install.
Remaining Phase 5: audio, real animations, real-time Cownter mode.

## Playing locally

```
npm start       # then open http://localhost:8080 in 2-4 browser tabs
```

Create a game in one tab, copy the join code, join from the others, start.
(Port: set the PORT environment variable to override 8080.)

```
data/            The data-driven card system (spec section 4)
  cards.json     Card definitions (what each card does)
  deck.json      Deck manifest (how many of each) — edit to rebalance
  config.json    Tunable constants (actions per turn, capacities, ...)
src/             Phase 1: the game engine (pure state machine, no I/O)
  types.ts       Shared types: GameState, Action, CardDef, ...
  data.ts        Loads + validates the JSON data files
  rng.ts         Seeded RNG so games are reproducible
  rocket.ts      Rocket building rules (parts, wilds, capacity)
  util.ts        Shared helpers (draw/reshuffle, herding, win check)
  effects.ts     Effect handler registry — one entry per `effect` key
  engine.ts      createGame + applyAction (turn flow, Cownter stack)
  index.ts       Public API for later phases
server/          Phase 2: networking (knows nothing about game rules)
  ws.ts          Zero-dependency RFC 6455 WebSocket implementation
  views.ts       Per-player scoped state views — hidden hands (spec 7.3)
  rooms.ts       Room manager: join codes, lobby, spec 7.1/7.2 protocol
  server.ts      HTTP static files + WS upgrade on one port
client/          Phase 2 store + Phase 4/5 tabletop UI (React via CDN, no build)
  index.html     loads Google Fonts + styles.css
  app.js         Single store fed by server messages (spec 3.3) + all UI,
                 incl. the cosmetic piece/cow drag (local state only)
  styles.css     muted-felt three-column tabletop theme
  art.json       Phase 5: cardId→asset + board.{back,moon,farm} (spec 4.2)
  art/           Phase 5: the served card + board PNGs
test/            97 tests: engine suites, Example of Play run literally,
                 bot-vs-bot simulations, full games over real WebSockets,
                 and Phase 3 reconnect/timer/AFK/room-lifecycle coverage
```

## Running the tests

No dependencies needed — Node 22+ only:

```
npm test
```

The integration tests start a real server on a random port, connect real
WebSocket clients, and play complete 2-, 3-, and 4-player games to a win —
the Phase 2 "done" signal from the spec.

Notes: the WebSocket layer is hand-rolled (~200 lines) because the build
sandbox has no npm access; the transport is isolated behind a tiny interface
in rooms.ts, so swapping in Socket.IO later is contained to ws.ts. The client
loads React from a CDN for the same reason — a Vite build arrives with the
polish phases. (Vitest is in devDependencies for later; tests use `node:test`
so they run anywhere.)

## Adding or changing cards

- Change a count: edit `data/deck.json`.
- New card reusing an existing effect: add an entry to `data/cards.json`
  (e.g. a "move 2 cows" card is `"effect": "moveCowsFarmToRocket",
  "params": {"count": 2}`) plus a `deck.json` entry.
- Genuinely new mechanic: add one handler to `src/effects.ts`, then add the
  card as data. A card whose effect key has no handler resolves as a no-op
  and logs `cardEffectNotDefined` (spec 4.4 fallback).
- Art for a new card: drop the PNG in `client/art/` and add a `cards` entry to
  `client/art.json`. Unmapped cards just render as plain text.
- A new *targeted* card also needs client work (a bespoke target UI can't be
  data-driven): add its effect key to `POPUP_EFFECTS` or `ZONE_EFFECTS` in
  `app.js` and a branch in `TargetPicker`. Non-targeted cards need no client
  change.

Rules calls made during implementation are in `DECISIONS.md`.

## Next: live playtest, then finish Phase 5

The tabletop UI (three-column layout, real art, tactile piece/cow drag) is
built and needs a real browser playtest — this also covers Phase 3's last item
(a manual pass over every card in a live game). Remaining Phase 5: sound, real
animations (cards flying to the rocket, launches, cows landing), and the
toggleable real-time Cownter mode (spec 6.3) — all additive, no game logic
changes. The piece/cow drag is currently cosmetic; making manual assembly gate
launching would be a deliberate engine-level feature. See `../CLAUDE.md` →
"Phase 4/5 — Tabletop UI & Art" for the full write-up and open items.
