# Code Review — Cows To The Moon Online

Scope: engine (`src/`), networking (`server/`), client (`client/`), data
(`data/`) reviewed against Spec Draft v0.3, the rules PDF, and DECISIONS.md.
Goal: modularity, no spaghetti, no redundant/dead code, spec adherence —
readiness for the next round of edits. Last refreshed: 2026-07-19 (post-cleanup).

Verdict: **the codebase is in strong shape.** Architecture matches the spec
closely, layering is clean with no cycles, cards/counts/tunables are fully
data-driven, and all 96 tests pass. Findings below are minor.

## What's genuinely good

- **Layering is exactly what the spec asks for.** The engine (`src/`) is a
  pure `(state, action) -> state | error` state machine with zero I/O, no
  timers, no knowledge of sockets or React. `src/` imports nothing from
  `server/` or `client/`; `server/` imports nothing from `client/`. The
  transport sits behind the 4-method `ClientSocket` interface, so swapping
  `ws.ts` for Socket.IO later is contained (spec 3.2).
- **Data-driven cards are real, not nominal.** All 44 cards, counts, and every
  tunable number live in `cards.json` / `deck.json` / `config.json`. The
  engine reads them; nothing card-specific is hard-coded. Card counts total
  44 and match Appendix A / the Card Counts PDF exactly.
- **The Cownter stack is modeled cleanly.** One LIFO stack, parity-based
  resolution (`resolveStack`), no hard-coded depth limit, and Cownter is just
  `type: "event"` with `effect: "cancelEvent"` — so a Cownter countering a
  Cownter falls out of the same code path with no special-casing (spec 6.4).
- **Server-authoritative + hidden info is correct.** `views.ts` scopes state
  per player: own hand full, others as counts, deck as a count, RNG stripped.
  The client sends only `cardInstanceId` + targeting params; the server looks
  up effects (spec 7.1/7.3).
- **Single choke point for state changes.** `applyRoomAction` is the only path
  that drives the engine — client messages and server timers alike — which
  keeps timer/broadcast/game-over handling in one place.
- **Timers live entirely in `rooms.ts`; the engine stays pure.** AFK skip,
  Cownter auto-pass, room inactivity, and room cleanup are all server-side.
  `skipTurn` / `setActive` are server-fired only (no client message maps to
  them). This is the right seam.
- **Client obeys the one-store rule (spec 3.3).** One `useReducer` fed only by
  server messages; `useState` used only for disposable UI (draw picks, target
  picker, drag, zoom). Target pickers key off `effect` strings, not card ids.

## Cleanups done this pass (client-only, no behavior change)

1. **`isCownter(card)` helper added** in `app.js` and used everywhere the
   client needed to know "is this a Cownter." Previously the literal
   `card.effect === 'cancelEvent'` test was inlined ~6 times; it now has one
   definition (the only place `cancelEvent` appears in the client).
2. **`pieceInfo()` simplified.** It used to parse a rocket piece's type/part
   out of the cardId as a fallback "for an un-restarted server." The server
   always enriches every card with `pieceType`/`part` (`views.ts`), so that
   branch was dead; it now just reads those fields with graceful defaults.
3. **This review refreshed.** The prior version referenced a `TARGETED_EFFECTS`
   constant that no longer exists (the client uses `POPUP_EFFECTS` +
   `ZONE_EFFECTS`).

Verified after: `node --check client/app.js` clean, no `class=` / string-style
regressions, 96/96 tests green.

## Cleanup done 2026-07-20 (inert-code pass — no behavior change)

- **Removed the dead `setActive(active:false)` branch.** The engine action
  `setActive` carried a boolean, but the server only ever fired it with
  `active: true` (reconnect + "I'm back"), and a player only ever BECOMES
  inactive via `skipTurn` strikes — so the deactivate branch was unreachable.
  Renamed the action to `reactivate` (`{ type, playerId }`, no boolean) across
  `types.ts` / `engine.ts` / `rooms.ts` / tests, matching Decision #15's wording.
  All 97 tests still green.
- **Considered and rejected an engine-side "empty-deck draw" guard.** A deck
  pick when both piles are empty is a *deliberate* best-effort no-op ("draws
  what it can"): bots and simple clients draw `[deck, deck]` without inspecting
  pile sizes, and it's what keeps the Draw Phase from ever soft-locking
  (`endgame.test.ts` "survives both piles running dry" pins this). Avoiding a
  wasted deck click is correctly a client-only nicety (`app.js` `deckDisabled`),
  not an engine rule. Left as-is with a clarifying comment in `doDraw`.

## Intentionally-inert spots (documented defensive code — left as-is)

These are deliberate and commented; flagged so a reader doesn't mistake them
for live paths:

- **`cancelEvent` registry entry** (`effects.ts`): `apply` is a no-op —
  cancellation is handled by the response stack, not the registry. NOTE the
  `validate` here is NOT inert: it's what rejects a Cownter played as a normal
  action ("played in response to an event card, not as its own action"), so
  keep it. Cownter is identified by its `effect` string, per spec 4.1.
- **Type guard in `pieceAddError`** (`rocket.ts`): unreachable from its
  in-engine caller (`doPlayCard` branches on type first), but kept because the
  function is exported for external callers.
- **`?? 0` in `moveCowsFarmToRocket.apply`** (`effects.ts`): `validate`
  guarantees a positive integer and board state can't change between validate
  and apply, so the fallback never triggers. Belt-and-suspenders.

## Coupling to keep in mind before Phase 4/5 edits

- **New *targeted* mechanics touch the client too.** "90% of new cards need
  zero code" holds for effects/counts (add data, maybe one `effects.ts`
  handler). But a genuinely new *targeted* effect also needs client edits:
  add its `effect` key to `POPUP_EFFECTS` or `ZONE_EFFECTS`, a branch in
  `TargetPicker`, and possibly `describeTarget` / `LaunchPad` / `Farm`. This
  is inherent to needing a bespoke target UI (the CDN client can't import from
  `src/`), not a design flaw — just the thing most likely to surprise you
  mid-edit.
- **`rocketComplete` derives completeness from the pieces themselves** (three
  pieces with distinct concrete parts; wilds flex). It no longer trusts a
  play-time invariant, so a future effect that adds a piece by another route
  can't fool it. Good as-is; if piece-adding ever grows a second path,
  centralize it in one `addPiece` helper.

## Process / next-phase notes (not code issues)

- **No type-checking gate in this environment.** `node --experimental-strip-
  types` strips types without checking them, and `tsc` can't install in the
  sandbox (no npm). Nothing currently enforces the shared TS types. When the
  project moves to an environment with npm (planned Vite/Vitest migration),
  wire `npm run typecheck` (already in `package.json`) into the routine.
- **Expected gaps, correctly deferred:** `art.json` (Phase 5), real-time
  Cownter mode (spec 6.3, Phase 5+), and the one open Phase 3 item — a live
  manual pass over every card in a browser game (automated per-card coverage
  already exists in `effects.test.ts`).

## Spec adherence spot-checks (all pass)

- Draw phase: exactly 2 in any deck/store combination, or 5 from deck on an
  empty hand. Store not refilled mid-turn; refilled as the last thing before
  the turn passes (`finishTurn`). ✓ (spec 6.1)
- Action phase: 3 actions; Play / Recycle / Herd / Nothing; turns end only via
  explicit End Turn (Decision #13). ✓
- Rocket pieces and Launch resolve instantly and bypass the response window;
  only `type === "event"` opens it (spec 6.5). ✓
- Deck exhaustion reshuffles the discard (Decision #1). ✓
- Matching-set +1 capacity; wilds excluded from the bonus (Decision #11). ✓
- Rocket Thief returns over-capacity cows to the farm (Decision #12). ✓
- Inactive players: untargetable, excluded from response windows, turns passed
  over, Bad Weather clears on a skipped seat (Decisions #6, #16). ✓
- Room codes: config-driven length, unambiguous alphabet, collision-checked
  (spec 7.4). ✓

## Bottom line

Nothing needs fixing to keep building. The client cleanups above are done; the
one structural thing to remember is the targeted-card client coupling — what an
edit touches depends on whether it's pure-data/engine (isolated) or involves a
new target UI (spans the client).
