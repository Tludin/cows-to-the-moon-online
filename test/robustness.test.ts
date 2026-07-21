// Phase 3 engine tests: turn skipping, the AFK/inactive rules (Decisions
// #6/#14/#15/#16), and how inactivity interacts with targeting, the Cownter
// window, and Bad Weather. Server timers are tested separately over real
// WebSockets in reconnect.test.ts — here we drive the actions directly.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, applyAll } from '../src/engine.ts';
import type { Action, GameState } from '../src/types.ts';
import { drawTwo, endTurn, give, newGame, player, setRocket } from './helpers.ts';

const skip = (playerId: string): Action => ({ type: 'skipTurn', playerId });
const reactivate = (playerId: string): Action => ({ type: 'reactivate', playerId });

describe('skipTurn (Decision #14)', () => {
  it('forfeits the turn from the draw phase and counts a strike', () => {
    let s = newGame();
    s = applyAll(s, [skip('p1')]);
    assert.equal(s.turn.currentPlayerId, 'p2');
    assert.equal(s.turn.phase, 'draw');
    assert.equal(player(s, 'p1').consecutiveSkips, 1);
    assert.equal(player(s, 'p1').inactive, false);
    assert.equal(s.rocketStore.length, 4); // store still refilled on the way out
  });

  it('forfeits mid-action-phase too', () => {
    let s = newGame();
    s = applyAll(s, [drawTwo('p1'), skip('p1')]);
    assert.equal(s.turn.currentPlayerId, 'p2');
    assert.equal(player(s, 'p1').consecutiveSkips, 1);
  });

  it('is rejected for anyone but the current player', () => {
    const s = newGame();
    assert.match(applyAction(s, skip('p2')).error!, /Not the current player/);
  });

  it('costs NO strike when the player already used an action this turn', () => {
    // Pausing at the End Turn button is playing, not being AFK (Decision #6).
    let s = newGame();
    s = applyAll(s, [drawTwo('p1'), { type: 'pass', playerId: 'p1' }, skip('p1')]);
    assert.equal(s.turn.currentPlayerId, 'p2'); // turn still auto-ends…
    assert.equal(player(s, 'p1').consecutiveSkips, 0); // …but no strike
    assert.ok(s.log.some((e) => e.type === 'turnAutoEnded' && e.playerId === 'p1'));
    assert.ok(!s.log.some((e) => e.type === 'turnSkipped'));
  });

  it('drawing alone does not count as taking an action (still a strike)', () => {
    let s = newGame();
    s = applyAll(s, [drawTwo('p1'), skip('p1')]);
    assert.equal(player(s, 'p1').consecutiveSkips, 1);
  });

  it('any real own-turn action resets the strike count', () => {
    let s = newGame();
    s = applyAll(s, [skip('p1'), skip('p2')]); // both at 1 strike
    s = applyAll(s, [drawTwo('p1')]); // p1 shows up
    assert.equal(player(s, 'p1').consecutiveSkips, 0);
    assert.equal(player(s, 'p2').consecutiveSkips, 1);
  });
});

describe('going inactive (Decision #6)', () => {
  function withInactiveP2(): GameState {
    // p1 and p3 keep playing normally; p2 times out twice and goes inactive.
    // Ends with p3 to act, p2 inactive, p1/p3 at zero strikes.
    let s = newGame(['Alice', 'Bob', 'Cara']);
    s = applyAll(s, [
      drawTwo('p1'),
      endTurn('p1'),
      skip('p2'),
      drawTwo('p3'),
      endTurn('p3'),
      drawTwo('p1'),
      endTurn('p1'),
      skip('p2'),
    ]);
    assert.equal(player(s, 'p2').inactive, true);
    return s;
  }

  it('marks the player inactive at the configured strike limit', () => {
    const s = withInactiveP2();
    assert.equal(s.config.playerInactivityTurnLimit, 2);
    assert.ok(s.log.some((e) => e.type === 'playerWentInactive' && e.playerId === 'p2'));
  });

  it('their turns are passed over entirely', () => {
    let s = withInactiveP2(); // p3 to act
    s = applyAll(s, [drawTwo('p3'), endTurn('p3')]);
    assert.equal(s.turn.currentPlayerId, 'p1'); // straight past p2
    s = applyAll(s, [drawTwo('p1'), endTurn('p1')]);
    assert.equal(s.turn.currentPlayerId, 'p3'); // and past p2 again
    assert.ok(s.log.some((e) => e.type === 'turnPassedOver' && e.playerId === 'p2'));
  });

  it('they cannot be targeted by event cards', () => {
    let s = withInactiveP2();
    setRocket(s, 'p2', ['nasa_import_top'], 1);
    s = applyAll(s, [drawTwo('p3')]);
    const wrangler = give(s, 'p3', 'cow_wrangler');
    const r = applyAction(s, {
      type: 'playCard',
      playerId: 'p3',
      instanceId: wrangler.instanceId,
      params: { targetPlayerId: 'p2' },
    });
    assert.match(r.error!, /inactive/);
  });

  it('they are skipped by the Cownter response window', () => {
    let s = withInactiveP2();
    s = applyAll(s, [drawTwo('p3')]);
    const ssc = give(s, 'p3', 'super_speedy_cows');
    s = applyAll(s, [{ type: 'playCard', playerId: 'p3', instanceId: ssc.instanceId }]);
    assert.deepEqual(s.pending!.toRespond, ['p1']); // p2 not asked
  });

  it('an event resolves immediately when every opponent is inactive', () => {
    let s = newGame(); // 2 players
    s = applyAll(s, [skip('p1'), skip('p2'), skip('p1'), skip('p2')]);
    assert.equal(player(s, 'p2').inactive, true);
    // p1 went inactive too; bring them back the way the server would.
    s = applyAll(s, [reactivate('p1')]);
    s = applyAll(s, [drawTwo('p1')]);
    setRocket(s, 'p1', ['nasa_import_top']);
    const ssc = give(s, 'p1', 'super_speedy_cows');
    s = applyAll(s, [{ type: 'playCard', playerId: 'p1', instanceId: ssc.instanceId }]);
    assert.equal(s.pending, null); // no window: resolved on the spot
    assert.equal(player(s, 'p1').rocket.cows, 3); // SSC moved its full 3 cows
    assert.ok(s.log.some((e) => e.type === 'eventResolved'));
  });

  it('a passed-over turn still clears Bad Weather (Decision #16)', () => {
    let s = withInactiveP2();
    s.badWeather = ['p2']; // as if Bob had played Bad Weather before going AFK
    // Seating is p1 p2 p3: p2's seat comes up after p1's turn ends.
    s = applyAll(s, [drawTwo('p3'), endTurn('p3')]);
    assert.deepEqual(s.badWeather, ['p2']); // not their seat yet
    s = applyAll(s, [drawTwo('p1'), endTurn('p1')]);
    assert.deepEqual(s.badWeather, []); // cleared as p2's turn was passed over
    assert.equal(s.turn.currentPlayerId, 'p3');
  });
});

describe('coming back (Decision #15)', () => {
  it('reactivate clears inactive and the strike count', () => {
    let s = newGame();
    s = applyAll(s, [skip('p1'), skip('p2'), skip('p1'), skip('p2')]);
    s = applyAll(s, [reactivate('p2')]);
    const p2 = player(s, 'p2');
    assert.equal(p2.inactive, false);
    assert.equal(p2.consecutiveSkips, 0);
    assert.ok(s.log.some((e) => e.type === 'playerReturned' && e.playerId === 'p2'));
  });

  it('a returned player takes turns and can be targeted again', () => {
    let s = newGame(['Alice', 'Bob', 'Cara']);
    s = applyAll(s, [
      drawTwo('p1'),
      endTurn('p1'),
      skip('p2'),
      drawTwo('p3'),
      endTurn('p3'),
      drawTwo('p1'),
      endTurn('p1'),
      skip('p2'),
    ]);
    assert.equal(player(s, 'p2').inactive, true);
    s = applyAll(s, [reactivate('p2')]);
    s = applyAll(s, [drawTwo('p3'), endTurn('p3')]);
    assert.equal(s.turn.currentPlayerId, 'p1');
    s = applyAll(s, [drawTwo('p1'), endTurn('p1')]);
    assert.equal(s.turn.currentPlayerId, 'p2'); // back in the rotation
  });

  it('reactivate is legal even while a response window is open (reconnect case)', () => {
    let s = newGame(['Alice', 'Bob', 'Cara']);
    s = applyAll(s, [
      drawTwo('p1'),
      endTurn('p1'),
      skip('p2'),
      drawTwo('p3'),
      endTurn('p3'),
      drawTwo('p1'),
      endTurn('p1'),
      skip('p2'),
    ]);
    assert.equal(player(s, 'p2').inactive, true);
    s = applyAll(s, [drawTwo('p3')]);
    const ssc = give(s, 'p3', 'super_speedy_cows');
    s = applyAll(s, [{ type: 'playCard', playerId: 'p3', instanceId: ssc.instanceId }]);
    assert.notEqual(s.pending, null);
    const r = applyAction(s, reactivate('p2'));
    assert.equal(r.error, undefined);
    assert.equal(player(r.state, 'p2').inactive, false);
    // The already-open window is not retroactively expanded.
    assert.deepEqual(r.state.pending!.toRespond, ['p1']);
  });

  it('other actions are still blocked during a response window', () => {
    let s = newGame();
    s = applyAll(s, [drawTwo('p1')]);
    setRocket(s, 'p1', ['nasa_import_top']);
    const ssc = give(s, 'p1', 'super_speedy_cows');
    s = applyAll(s, [{ type: 'playCard', playerId: 'p1', instanceId: ssc.instanceId }]);
    assert.match(applyAction(s, skip('p1')).error!, /Waiting for Cownter responses/);
  });
});
