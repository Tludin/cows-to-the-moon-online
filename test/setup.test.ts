import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createGame } from '../src/engine.ts';
import { totalDeckSize, validateData } from '../src/data.ts';

describe('card data', () => {
  it('is internally consistent', () => {
    validateData();
  });

  it('has exactly 44 cards, matching the rules document', () => {
    assert.equal(totalDeckSize(), 44);
  });
});

describe('game setup', () => {
  it('deals 5 cards each, fills the Rocket Store with 4, farms start at 10', () => {
    const s = createGame({ playerNames: ['A', 'B', 'C'], seed: 1 });
    assert.equal(s.players.length, 3);
    for (const p of s.players) {
      assert.equal(p.hand.length, 5);
      assert.equal(p.farm, 10);
      assert.equal(p.moon, 0);
      assert.equal(p.rocket.pieces.length, 0);
      assert.equal(p.rocket.cows, 0);
    }
    assert.equal(s.rocketStore.length, 4);
    assert.equal(s.deck.length, 44 - 15 - 4);
    assert.equal(s.turn.currentPlayerId, 'p1');
    assert.equal(s.turn.phase, 'draw');
    assert.equal(s.status, 'playing');
  });

  it('is deterministic for the same seed', () => {
    const a = createGame({ playerNames: ['A', 'B'], seed: 7 });
    const b = createGame({ playerNames: ['A', 'B'], seed: 7 });
    assert.deepEqual(
      a.deck.map((c) => c.cardId),
      b.deck.map((c) => c.cardId),
    );
  });

  it('rejects player counts outside config bounds', () => {
    assert.throws(() => createGame({ playerNames: ['solo'], seed: 1 }));
    assert.throws(() => createGame({ playerNames: ['a', 'b', 'c', 'd', 'e'], seed: 1 }));
  });

  it('honors firstPlayerIndex', () => {
    const s = createGame({ playerNames: ['A', 'B'], seed: 1, firstPlayerIndex: 1 });
    assert.equal(s.turn.currentPlayerId, 'p2');
  });
});
