// The "Example of Play" from the rules document, run as a literal test case
// (Phase 1 "done" signal, spec section 8).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyAll } from '../src/engine.ts';
import { newGame, player, setHand, setRocket, give, endTurn } from './helpers.ts';

describe('Example of Play (rules document)', () => {
  it('plays out exactly as written', () => {
    let s = newGame(['Player 1', 'Player 2'], 99);

    // Both players have completed rockets; Player 2's already holds 3 cows.
    setRocket(s, 'p1', ['nasa_import_top', 'farmmade_middle', 'nasa_import_bottom'], 0);
    setRocket(s, 'p2', ['farmmade_top', 'farmmade_middle', 'farmmade_bottom'], 3);
    const [ssc] = setHand(s, 'p1', ['super_speedy_cows', 'wind']);
    const [launch, newPiece, cownter] = setHand(s, 'p2', ['launch', 'heavily_improvised_top', 'cownter']);

    // --- Player 1's turn: draws two cards from the Rocket Store.
    const [store1, store2] = s.rocketStore;
    s = applyAll(s, [
      {
        type: 'draw',
        playerId: 'p1',
        picks: [
          { source: 'rocketStore', instanceId: store1!.instanceId },
          { source: 'rocketStore', instanceId: store2!.instanceId },
        ],
      },
      // Action 1: Super Speedy Cows, attempting to move three cows aboard.
      { type: 'playCard', playerId: 'p1', instanceId: ssc!.instanceId },
      // Player 2 responds with a Cownter, cancelling the move.
      { type: 'respond', playerId: 'p2', response: 'cownter', instanceId: cownter!.instanceId },
      // Player 1 could Cownter that in turn, but chooses not to.
      { type: 'respond', playerId: 'p1', response: 'pass' },
    ]);
    assert.equal(player(s, 'p1').rocket.cows, 0); // the move was cancelled

    // Remaining two actions: herd two cows into the rocket, then end the turn.
    s = applyAll(s, [
      { type: 'herd', playerId: 'p1' },
      { type: 'herd', playerId: 'p1' },
      endTurn('p1'),
    ]);
    // The store was refilled back to 4 as the turn passed.
    assert.equal(player(s, 'p1').rocket.cows, 2);
    assert.equal(s.turn.currentPlayerId, 'p2');
    assert.equal(s.rocketStore.length, 4);

    // --- Player 2's turn: draws one from the Rocket Store and one from the deck.
    const storeCard = s.rocketStore[0]!;
    s = applyAll(s, [
      {
        type: 'draw',
        playerId: 'p2',
        picks: [{ source: 'rocketStore', instanceId: storeCard.instanceId }, { source: 'deck' }],
      },
      // Action 1: herd one cow, bringing the rocket to four cows total.
      { type: 'herd', playerId: 'p2' },
    ]);
    assert.equal(player(s, 'p2').rocket.cows, 4);

    // Action 2: Launch — all four cows fly to the moon; the pieces are discarded.
    s = applyAll(s, [{ type: 'playCard', playerId: 'p2', instanceId: launch!.instanceId }]);
    assert.equal(player(s, 'p2').moon, 4);
    assert.equal(player(s, 'p2').rocket.pieces.length, 0);
    assert.equal(player(s, 'p2').rocket.cows, 0);

    // Action 3: weighs Bad Weather, decides to play a rocket piece instead.
    s = applyAll(s, [{ type: 'playCard', playerId: 'p2', instanceId: newPiece!.instanceId }, endTurn('p2')]);

    // Player 2's turn is over; back to Player 1.
    assert.equal(s.turn.currentPlayerId, 'p1');
    assert.equal(player(s, 'p2').rocket.pieces.length, 1);
    assert.equal(s.rocketStore.length, 4);
  });
});
