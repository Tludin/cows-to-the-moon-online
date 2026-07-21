// Fuzz-style verification: simple bots play entire games via the public API.
// Every action either succeeds or is cleanly rejected; games must reach a
// winner. This exercises deck reshuffles, store refills, launches, and turn
// cycling under realistic load.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, createGame } from '../src/engine.ts';
import { getCardDef } from '../src/data.ts';
import type { Action, GameState } from '../src/types.ts';

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
  candidates.push({ type: 'endTurn', playerId: pid }); // once actions run out

  for (const a of candidates) {
    if (!applyAction(s, a).error) return a;
  }
  return { type: 'endTurn', playerId: pid };
}

describe('full-game simulation', () => {
  for (const players of [2, 3, 4]) {
    it(`${players} bots always reach a winner`, () => {
      for (let seed = 1; seed <= 5; seed++) {
        let s = createGame({
          playerNames: Array.from({ length: players }, (_, i) => `Bot ${i + 1}`),
          seed: seed * 1000 + players,
        });
        let steps = 0;
        while (s.status === 'playing' && steps < 20000) {
          const a = botAction(s);
          const r = applyAction(s, a);
          assert.equal(r.error, undefined, `seed ${seed}: ${JSON.stringify(a)} -> ${r.error}`);
          s = r.state;
          steps++;
        }
        assert.equal(s.status, 'ended', `seed ${seed} never finished (${steps} steps)`);
        const winner = s.players.find((p) => p.id === s.winnerId)!;
        assert.equal(winner.moon, 10);
        // Conservation: every player still owns exactly 10 cows.
        for (const p of s.players) {
          assert.equal(p.farm + p.moon + p.rocket.cows, 10);
        }
      }
    });
  }
});
