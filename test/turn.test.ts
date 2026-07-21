import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, applyAll } from '../src/engine.ts';
import { newGame, player, setHand, drawTwo, endTurn } from './helpers.ts';

describe('draw phase', () => {
  it('draws 2 from the deck', () => {
    let s = newGame();
    const deckBefore = s.deck.length;
    s = applyAll(s, [drawTwo('p1')]);
    assert.equal(player(s, 'p1').hand.length, 7);
    assert.equal(s.deck.length, deckBefore - 2);
    assert.equal(s.turn.phase, 'action');
    assert.equal(s.turn.actionsRemaining, 3);
  });

  it('can draw specific cards from the Rocket Store, which is not refilled until end of turn', () => {
    let s = newGame();
    const storeCard = s.rocketStore[0]!;
    s = applyAll(s, [
      { type: 'draw', playerId: 'p1', picks: [{ source: 'rocketStore', instanceId: storeCard.instanceId }, { source: 'deck' }] },
    ]);
    assert.ok(player(s, 'p1').hand.some((c) => c.instanceId === storeCard.instanceId));
    assert.equal(s.rocketStore.length, 3); // not refilled mid-turn

    // Burn all three actions: the turn does NOT pass by itself (Decision #13).
    s = applyAll(s, [
      { type: 'pass', playerId: 'p1' },
      { type: 'pass', playerId: 'p1' },
      { type: 'pass', playerId: 'p1' },
    ]);
    assert.equal(s.turn.currentPlayerId, 'p1');
    assert.equal(s.rocketStore.length, 3); // still not refilled
    assert.ok(applyAction(s, { type: 'pass', playerId: 'p1' }).error); // out of actions

    // End Turn is the only remaining move: store refills, play passes left.
    s = applyAll(s, [endTurn('p1')]);
    assert.equal(s.rocketStore.length, 4);
    assert.equal(s.turn.currentPlayerId, 'p2');
    assert.equal(s.turn.phase, 'draw');
  });

  it('draws 5 from the deck when hand is empty', () => {
    let s = newGame();
    setHand(s, 'p1', []);
    s = applyAll(s, [{ type: 'draw', playerId: 'p1', picks: [] }]);
    assert.equal(player(s, 'p1').hand.length, 5);
  });

  it('rejects drawing out of turn or twice', () => {
    let s = newGame();
    assert.ok(applyAction(s, drawTwo('p2')).error);
    s = applyAll(s, [drawTwo('p1')]);
    assert.ok(applyAction(s, drawTwo('p1')).error);
  });

  it('draws one card at a time, revealing each before the phase ends', () => {
    let s = newGame();
    // First pick: hand grows by one, but we're still in the Draw Phase.
    s = applyAll(s, [{ type: 'draw', playerId: 'p1', picks: [{ source: 'deck' }] }]);
    assert.equal(player(s, 'p1').hand.length, 6);
    assert.equal(s.turn.phase, 'draw');
    assert.equal(s.turn.drawsRemaining, 1);
    // Second pick completes the phase.
    s = applyAll(s, [{ type: 'draw', playerId: 'p1', picks: [{ source: 'deck' }] }]);
    assert.equal(player(s, 'p1').hand.length, 7);
    assert.equal(s.turn.phase, 'action');
    assert.equal(s.turn.drawsRemaining, 0);
  });

  it('rejects too many picks and unknown store cards', () => {
    const s = newGame();
    // More picks than draws remaining is rejected.
    assert.ok(
      applyAction(s, {
        type: 'draw',
        playerId: 'p1',
        picks: [{ source: 'deck' }, { source: 'deck' }, { source: 'deck' }],
      }).error,
    );
    assert.ok(
      applyAction(s, {
        type: 'draw',
        playerId: 'p1',
        picks: [{ source: 'rocketStore', instanceId: 'nope' }, { source: 'deck' }],
      }).error,
    );
  });
});

describe('action phase', () => {
  it('requires drawing before acting', () => {
    const s = newGame();
    assert.ok(applyAction(s, { type: 'pass', playerId: 'p1' }).error);
  });

  it('recycle discards then draws', () => {
    let s = newGame();
    s = applyAll(s, [drawTwo('p1')]);
    const card = player(s, 'p1').hand[0]!;
    const discardBefore = s.discard.length;
    s = applyAll(s, [{ type: 'recycle', playerId: 'p1', instanceId: card.instanceId }]);
    assert.equal(player(s, 'p1').hand.length, 7); // net unchanged
    assert.equal(s.discard.length, discardBefore + 1);
    assert.equal(s.turn.actionsRemaining, 2);
  });

  it('turns cycle around the table via explicit End Turn', () => {
    let s = newGame(['A', 'B', 'C']);
    for (const pid of ['p1', 'p2', 'p3']) {
      assert.equal(s.turn.currentPlayerId, pid);
      s = applyAll(s, [
        drawTwo(pid),
        { type: 'pass', playerId: pid },
        { type: 'pass', playerId: pid },
        { type: 'pass', playerId: pid },
        endTurn(pid),
      ]);
    }
    assert.equal(s.turn.currentPlayerId, 'p1');
  });

  it('End Turn early forfeits remaining actions; ending before drawing is illegal', () => {
    let s = newGame();
    assert.ok(applyAction(s, endTurn('p1')).error); // must draw first
    s = applyAll(s, [drawTwo('p1'), { type: 'pass', playerId: 'p1' }, endTurn('p1')]);
    assert.equal(s.turn.currentPlayerId, 'p2'); // 2 actions forfeited
    assert.ok(applyAction(s, endTurn('p1')).error); // not your turn
  });

  it('rejects actions from the non-current player', () => {
    let s = newGame();
    s = applyAll(s, [drawTwo('p1')]);
    assert.ok(applyAction(s, { type: 'pass', playerId: 'p2' }).error);
  });
});
