import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, applyAll } from '../src/engine.ts';
import { newGame, player, setRocket, give, drawTwo } from './helpers.ts';

describe('deck exhaustion (Decision #1)', () => {
  it('reshuffles the discard pile into a fresh deck when the deck empties', () => {
    let s = newGame();
    // Move all but one deck card into the discard pile.
    s.discard.push(...s.deck.splice(0, s.deck.length - 1));
    const discardSize = s.discard.length;
    s = applyAll(s, [drawTwo('p1')]); // needs 2 cards, deck has 1 -> reshuffle mid-draw
    assert.equal(player(s, 'p1').hand.length, 7);
    assert.equal(s.deck.length, discardSize - 1);
    assert.equal(s.discard.length, 0);
    assert.ok(s.log.some((e) => e.type === 'deckReshuffled'));
  });

  it('survives both piles running dry (draws what it can)', () => {
    let s = newGame();
    s.deck = [];
    s.discard = [];
    s = applyAll(s, [drawTwo('p1')]);
    assert.equal(player(s, 'p1').hand.length, 5); // drew nothing, no crash
    assert.equal(s.turn.phase, 'action');
  });
});

describe('winning the game', () => {
  it('launching the 10th cow ends the game immediately', () => {
    let s = newGame();
    const p1 = player(s, 'p1');
    p1.moon = 6;
    p1.farm = 0;
    setRocket(s, 'p1', ['nasa_import_top', 'farmmade_middle', 'nasa_import_bottom']);
    p1.rocket.cows = 4;
    const launch = give(s, 'p1', 'launch');
    s = applyAll(s, [drawTwo('p1'), { type: 'playCard', playerId: 'p1', instanceId: launch.instanceId }]);
    assert.equal(s.status, 'ended');
    assert.equal(s.winnerId, 'p1');
    // No further actions are accepted.
    assert.ok(applyAction(s, { type: 'pass', playerId: 'p1' }).error);
    assert.ok(applyAction(s, drawTwo('p2')).error);
  });

  it('Mini Rocket landing the 10th cow also wins', () => {
    let s = newGame();
    const p2 = player(s, 'p2');
    p2.moon = 9;
    p2.farm = 1;
    // p2 wins on p1's turn — the engine doesn't care whose turn it is.
    const mr = give(s, 'p1', 'mini_rocket');
    s = applyAll(s, [
      drawTwo('p1'),
      { type: 'playCard', playerId: 'p1', instanceId: mr.instanceId, params: { targetPlayerId: 'p2', from: 'farm' } },
      { type: 'respond', playerId: 'p2', response: 'pass' },
    ]);
    assert.equal(s.status, 'ended');
    assert.equal(s.winnerId, 'p2');
  });

  it('a cancelled winning play does not end the game', () => {
    let s = newGame();
    const p2 = player(s, 'p2');
    p2.moon = 9;
    p2.farm = 1;
    const mr = give(s, 'p1', 'mini_rocket');
    give(s, 'p2', 'cownter');
    s = applyAll(s, [
      drawTwo('p1'),
      { type: 'playCard', playerId: 'p1', instanceId: mr.instanceId, params: { targetPlayerId: 'p2', from: 'farm' } },
      { type: 'respond', playerId: 'p2', response: 'cownter' },
      { type: 'respond', playerId: 'p1', response: 'pass' },
    ]);
    assert.equal(s.status, 'playing');
    assert.equal(player(s, 'p2').moon, 9);
  });
});

describe('immutability', () => {
  it('applyAction never mutates the input state', () => {
    const s = newGame();
    const snapshot = JSON.stringify(s);
    applyAction(s, drawTwo('p1'));
    applyAction(s, { type: 'pass', playerId: 'p1' }); // error path
    assert.equal(JSON.stringify(s), snapshot);
  });
});
