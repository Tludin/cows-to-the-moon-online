import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, applyAll } from '../src/engine.ts';
import { newGame, player, setHand, setRocket, give, drawTwo, endTurn } from './helpers.ts';

describe('the Cownter response window (spec 6.2)', () => {
  it('an event card opens a response window instead of resolving', () => {
    let s = newGame(['A', 'B', 'C']);
    setRocket(s, 'p1', ['nasa_import_top']);
    const ssc = give(s, 'p1', 'super_speedy_cows');
    s = applyAll(s, [drawTwo('p1'), { type: 'playCard', playerId: 'p1', instanceId: ssc.instanceId }]);
    assert.ok(s.pending);
    assert.deepEqual(s.pending!.toRespond, ['p2', 'p3']); // turn order, starting left of p1
    assert.equal(player(s, 'p1').rocket.cows, 0); // not resolved yet
    // No other actions are legal while the window is open.
    assert.ok(applyAction(s, { type: 'herd', playerId: 'p1' }).error);
  });

  it('resolves once every other player passes', () => {
    let s = newGame(['A', 'B', 'C']);
    setRocket(s, 'p1', ['nasa_import_top']);
    const ssc = give(s, 'p1', 'super_speedy_cows');
    s = applyAll(s, [
      drawTwo('p1'),
      { type: 'playCard', playerId: 'p1', instanceId: ssc.instanceId },
      { type: 'respond', playerId: 'p2', response: 'pass' },
      { type: 'respond', playerId: 'p3', response: 'pass' },
    ]);
    assert.equal(s.pending, null);
    assert.equal(player(s, 'p1').rocket.cows, 3);
  });

  it('a Cownter cancels the event; the action is still spent and the cards are discarded', () => {
    let s = newGame();
    setRocket(s, 'p1', ['nasa_import_top']);
    const ssc = give(s, 'p1', 'super_speedy_cows');
    give(s, 'p2', 'cownter');
    s = applyAll(s, [
      drawTwo('p1'),
      { type: 'playCard', playerId: 'p1', instanceId: ssc.instanceId },
      { type: 'respond', playerId: 'p2', response: 'cownter' },
      { type: 'respond', playerId: 'p1', response: 'pass' }, // p1 declines to counter back
    ]);
    assert.equal(s.pending, null);
    assert.equal(player(s, 'p1').rocket.cows, 0); // cancelled
    assert.equal(s.turn.actionsRemaining, 2); // p1's action was spent; p2's Cownter was free
    assert.ok(s.discard.some((c) => c.instanceId === ssc.instanceId));
    assert.ok(s.log.some((e) => e.type === 'eventCancelled'));
  });

  it('a Cownter can be Cowntered: the original event then resolves (spec 6.4)', () => {
    let s = newGame();
    setRocket(s, 'p1', ['nasa_import_top']);
    const ssc = give(s, 'p1', 'super_speedy_cows');
    give(s, 'p1', 'cownter');
    give(s, 'p2', 'cownter');
    s = applyAll(s, [
      drawTwo('p1'),
      { type: 'playCard', playerId: 'p1', instanceId: ssc.instanceId },
      { type: 'respond', playerId: 'p2', response: 'cownter' },
      { type: 'respond', playerId: 'p1', response: 'cownter' },
      { type: 'respond', playerId: 'p2', response: 'pass' },
    ]);
    assert.equal(s.pending, null);
    assert.equal(player(s, 'p1').rocket.cows, 3); // net: event resolves
  });

  it('supports a triple chain in a 3-player game', () => {
    let s = newGame(['A', 'B', 'C']);
    setRocket(s, 'p1', ['nasa_import_top']);
    const ssc = give(s, 'p1', 'super_speedy_cows');
    give(s, 'p2', 'cownter');
    give(s, 'p3', 'cownter');
    give(s, 'p1', 'cownter');
    s = applyAll(s, [
      drawTwo('p1'),
      { type: 'playCard', playerId: 'p1', instanceId: ssc.instanceId },
      { type: 'respond', playerId: 'p2', response: 'cownter' }, // stack: ssc, C(p2)
      { type: 'respond', playerId: 'p3', response: 'cownter' }, // stack: ssc, C(p2), C(p3)
      { type: 'respond', playerId: 'p1', response: 'cownter' }, // stack: ssc, C(p2), C(p3), C(p1)
      { type: 'respond', playerId: 'p2', response: 'pass' },
      { type: 'respond', playerId: 'p3', response: 'pass' },
    ]);
    // 3 cownters -> odd -> base event cancelled.
    assert.equal(player(s, 'p1').rocket.cows, 0);
  });

  it('enforces responding in priority order and holding an actual Cownter', () => {
    let s = newGame(['A', 'B', 'C']);
    setRocket(s, 'p1', ['nasa_import_top']);
    const ssc = give(s, 'p1', 'super_speedy_cows');
    s = applyAll(s, [drawTwo('p1'), { type: 'playCard', playerId: 'p1', instanceId: ssc.instanceId }]);
    // p3 tries to jump the queue.
    assert.ok(applyAction(s, { type: 'respond', playerId: 'p3', response: 'pass' }).error);
    // p1 has nothing to respond to (their own card is on top).
    assert.ok(applyAction(s, { type: 'respond', playerId: 'p1', response: 'pass' }).error);
    // p2 has no cownter in hand.
    setHand(s, 'p2', ['wind']);
    assert.ok(applyAction(s, { type: 'respond', playerId: 'p2', response: 'cownter' }).error);
  });

  it('a Cownter cannot be played proactively as a normal action', () => {
    let s = newGame();
    const cownter = give(s, 'p1', 'cownter');
    s = applyAll(s, [drawTwo('p1')]);
    assert.ok(applyAction(s, { type: 'playCard', playerId: 'p1', instanceId: cownter.instanceId }).error);
  });

  it('the turn cannot end while a response window is open', () => {
    let s = newGame();
    setRocket(s, 'p1', ['nasa_import_top']);
    const ssc = give(s, 'p1', 'super_speedy_cows');
    s = applyAll(s, [
      drawTwo('p1'),
      { type: 'pass', playerId: 'p1' },
      { type: 'pass', playerId: 'p1' },
      { type: 'playCard', playerId: 'p1', instanceId: ssc.instanceId },
    ]);
    assert.ok(s.pending);
    assert.ok(applyAction(s, endTurn('p1')).error); // window open: no ending the turn
    s = applyAll(s, [{ type: 'respond', playerId: 'p2', response: 'pass' }]);
    assert.equal(player(s, 'p1').rocket.cows, 3);
    assert.equal(s.turn.currentPlayerId, 'p1'); // still p1 until End Turn (Decision #13)
    s = applyAll(s, [endTurn('p1')]);
    assert.equal(s.turn.currentPlayerId, 'p2');
  });
});
