// Generates client/menu-snapshot.json: a real, engine-simulated 3-player
// game state, frozen after exactly 12 completed turns (4 each), used to
// dress the menu's idle-spin table backdrop (see MenuTable in client/app.js)
// so it shows a state that's actually reachable under the real rules instead
// of hand-fabricated numbers. Re-run this whenever you want a different
// frozen snapshot (a new SEED, or a different STOP_AFTER_TURNS):
//
//   node --experimental-strip-types scripts/gen-menu-snapshot.ts
//
// The bot policy is the same "build -> launch -> herd -> speedy cows ->
// recycle -> pass -> end turn" priority order used by test/simulation.test.ts
// to play full bot-vs-bot games, just stopped early and snapshotted instead
// of run to a winner. scopedView (the exact function server/rooms.ts uses to
// build each player's real state view) turns the resulting GameState into
// precisely the JSON shape client/app.js already knows how to render — no
// separate enrichment logic to keep in sync.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyAction, createGame, getCardDef } from '../src/index.ts';
import { scopedView } from '../server/views.ts';
import type { Action, GameState } from '../src/index.ts';

const SEED = 20260910;
const STOP_AFTER_TURNS = 12; // 4 turns each for 3 players

function botAction(s: GameState): Action {
  if (s.pending) {
    return { type: 'respond', playerId: s.pending.toRespond[0]!, response: 'pass' };
  }
  const pid = s.turn.currentPlayerId;
  const p = s.players.find((x) => x.id === pid)!;

  if (s.turn.phase === 'draw') {
    return p.hand.length === 0
      ? { type: 'draw', playerId: pid, picks: [] }
      : { type: 'draw', playerId: pid, picks: [{ source: 'deck' }, { source: 'deck' }] };
  }

  // Priority: build -> launch -> herd -> speedy cows -> recycle -> pass.
  const candidates: Action[] = [];
  for (const c of p.hand) {
    const def = getCardDef(c.cardId);
    if (def.type === 'rocketPiece') candidates.push({ type: 'playCard', playerId: pid, instanceId: c.instanceId });
  }
  const launch = p.hand.find((c) => getCardDef(c.cardId).type === 'launch');
  if (launch) candidates.push({ type: 'playCard', playerId: pid, instanceId: launch.instanceId });
  candidates.push({ type: 'herd', playerId: pid });
  const ssc = p.hand.find((c) => c.cardId === 'super_speedy_cows');
  if (ssc) candidates.push({ type: 'playCard', playerId: pid, instanceId: ssc.instanceId });
  if (p.hand.length > 0) {
    candidates.push({ type: 'recycle', playerId: pid, instanceId: p.hand[0]!.instanceId });
  }
  candidates.push({ type: 'pass', playerId: pid });
  candidates.push({ type: 'endTurn', playerId: pid });

  for (const a of candidates) {
    if (!applyAction(s, a).error) return a;
  }
  return { type: 'endTurn', playerId: pid };
}

let s = createGame({ playerNames: ['Bessie', 'Otis', 'Clarabelle'], seed: SEED });
let turnsEnded = 0;
let steps = 0;
while (s.status === 'playing' && turnsEnded < STOP_AFTER_TURNS && steps < 20000) {
  const a = botAction(s);
  const r = applyAction(s, a);
  if (r.error) throw new Error(`bot produced an illegal action: ${JSON.stringify(a)} -> ${r.error}`);
  s = r.state;
  if (a.type === 'endTurn') turnsEnded++;
  steps++;
}
if (s.status !== 'playing') {
  throw new Error(`game ended before ${STOP_AFTER_TURNS} turns (after ${turnsEnded}) — pick a different SEED`);
}

const connectedIds = new Set(s.players.map((p) => p.id));
const snapshot = scopedView(s, s.players[0]!.id, connectedIds);

const outPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'client', 'menu-snapshot.json');
writeFileSync(outPath, JSON.stringify(snapshot, null, 2) + '\n');
console.log(`Wrote ${outPath} (seed ${SEED}, ${turnsEnded} turns, ${steps} actions).`);
