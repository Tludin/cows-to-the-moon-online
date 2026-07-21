import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, applyAll } from '../src/engine.ts';
import { rocketCapacity, rocketComplete } from '../src/rocket.ts';
import { newGame, player, setHand, setRocket, give, drawTwo } from './helpers.ts';

describe('rocket building', () => {
  it('plays pieces in any order, but never two of the same part (Decision #11)', () => {
    let s = newGame();
    const [top, top2, bottom] = setHand(s, 'p1', ['nasa_import_top', 'farmmade_top', 'nasa_import_bottom']);
    give(s, 'p1', 'launch'); // padding so hand isn't empty for draw rule
    s = applyAll(s, [drawTwo('p1'), { type: 'playCard', playerId: 'p1', instanceId: top!.instanceId }]);
    assert.equal(player(s, 'p1').rocket.pieces.length, 1);

    // A second top is illegal…
    assert.ok(applyAction(s, { type: 'playCard', playerId: 'p1', instanceId: top2!.instanceId }).error);
    // …but a bottom is fine (top was played first: any order).
    s = applyAll(s, [{ type: 'playCard', playerId: 'p1', instanceId: bottom!.instanceId }]);
    assert.equal(player(s, 'p1').rocket.pieces.length, 2);
  });

  it('wild cards flex to any part and complete a rocket', () => {
    let s = newGame();
    const [top, wild1, wild2] = setHand(s, 'p1', ['nasa_import_top', 'wild_card', 'wild_card']);
    give(s, 'p1', 'launch');
    s = applyAll(s, [
      drawTwo('p1'),
      { type: 'playCard', playerId: 'p1', instanceId: top!.instanceId },
      { type: 'playCard', playerId: 'p1', instanceId: wild1!.instanceId },
      { type: 'playCard', playerId: 'p1', instanceId: wild2!.instanceId },
    ]);
    const rocket = player(s, 'p1').rocket;
    assert.equal(rocket.pieces.length, 3);
    // Wilds break the matching-set bonus: capacity stays 4.
    assert.equal(rocketCapacity(rocket, s.config), 4);
  });

  it('a rocket never takes a fourth piece', () => {
    let s = newGame();
    setRocket(s, 'p1', ['nasa_import_top', 'nasa_import_middle', 'nasa_import_bottom']);
    const piece = give(s, 'p1', 'farmmade_top');
    s = applyAll(s, [drawTwo('p1')]);
    assert.ok(applyAction(s, { type: 'playCard', playerId: 'p1', instanceId: piece.instanceId }).error);
  });

  it('rocketComplete is derived from the pieces, not just their count', () => {
    const s = newGame();
    // Fewer than three pieces: never complete.
    setRocket(s, 'p1', ['nasa_import_top', 'nasa_import_middle']);
    assert.equal(rocketComplete(player(s, 'p1').rocket), false);
    // Three distinct concrete parts: complete.
    setRocket(s, 'p1', ['nasa_import_top', 'farmmade_middle', 'heavily_improvised_bottom']);
    assert.equal(rocketComplete(player(s, 'p1').rocket), true);
    // Wilds flex to fill the gaps: complete.
    setRocket(s, 'p1', ['nasa_import_top', 'wild_card', 'wild_card']);
    assert.equal(rocketComplete(player(s, 'p1').rocket), true);
    // Three pieces but a duplicate concrete part (only reachable by bypassing
    // play-time validation) is NOT complete — the derived check catches it.
    setRocket(s, 'p2', ['nasa_import_top', 'farmmade_top', 'nasa_import_bottom']);
    assert.equal(rocketComplete(player(s, 'p2').rocket), false);
  });

  it('a full matching set holds 5 cows, a mixed set 4', () => {
    const s = newGame();
    setRocket(s, 'p1', ['nasa_import_top', 'nasa_import_middle', 'nasa_import_bottom']);
    assert.equal(rocketCapacity(player(s, 'p1').rocket, s.config), 5);
    setRocket(s, 'p2', ['nasa_import_top', 'farmmade_middle', 'nasa_import_bottom']);
    assert.equal(rocketCapacity(player(s, 'p2').rocket, s.config), 4);
  });
});

describe('herding (Decision #9: needs at least one piece)', () => {
  it('rejects herding with an empty launch pad', () => {
    let s = newGame();
    s = applyAll(s, [drawTwo('p1')]);
    assert.ok(applyAction(s, { type: 'herd', playerId: 'p1' }).error);
  });

  it('herds onto a partial rocket, up to capacity', () => {
    let s = newGame();
    setRocket(s, 'p1', ['nasa_import_top']);
    s = applyAll(s, [drawTwo('p1'), { type: 'herd', playerId: 'p1' }]);
    const p = player(s, 'p1');
    assert.equal(p.rocket.cows, 1);
    assert.equal(p.farm, 9);
  });

  it('rejects herding into a full rocket', () => {
    let s = newGame();
    setRocket(s, 'p1', ['nasa_import_top', 'farmmade_middle', 'nasa_import_bottom'], 4);
    s = applyAll(s, [drawTwo('p1')]);
    assert.ok(applyAction(s, { type: 'herd', playerId: 'p1' }).error);
  });
});

describe('launching', () => {
  it('requires a complete rocket', () => {
    let s = newGame();
    setRocket(s, 'p1', ['nasa_import_top', 'nasa_import_middle']);
    const launch = give(s, 'p1', 'launch');
    s = applyAll(s, [drawTwo('p1')]);
    assert.ok(applyAction(s, { type: 'playCard', playerId: 'p1', instanceId: launch.instanceId }).error);
  });

  it('sends cows to the moon, discards the rocket, resolves instantly (not counterable), and allows rebuilding', () => {
    let s = newGame();
    setRocket(s, 'p1', ['nasa_import_top', 'farmmade_middle', 'nasa_import_bottom'], 3);
    const launch = give(s, 'p1', 'launch');
    give(s, 'p1', 'cownter'); // opponent having cownters is irrelevant; launch can't be countered
    const discardBefore = s.discard.length;
    s = applyAll(s, [drawTwo('p1'), { type: 'playCard', playerId: 'p1', instanceId: launch.instanceId }]);
    const p = player(s, 'p1');
    assert.equal(s.pending, null); // never opened a response window
    assert.equal(p.moon, 3);
    assert.equal(p.rocket.cows, 0);
    assert.equal(p.rocket.pieces.length, 0);
    assert.equal(s.discard.length, discardBefore + 4); // launch card + 3 pieces

    // Same turn: start a new rocket on the now-empty pad.
    const piece = give(s, 'p1', 'farmmade_top');
    s = applyAll(s, [{ type: 'playCard', playerId: 'p1', instanceId: piece.instanceId }]);
    assert.equal(player(s, 'p1').rocket.pieces.length, 1);
  });

  it('launching an empty completed rocket is legal (if pointless)', () => {
    let s = newGame();
    setRocket(s, 'p1', ['nasa_import_top', 'farmmade_middle', 'nasa_import_bottom'], 0);
    const launch = give(s, 'p1', 'launch');
    s = applyAll(s, [drawTwo('p1'), { type: 'playCard', playerId: 'p1', instanceId: launch.instanceId }]);
    assert.equal(player(s, 'p1').moon, 0);
    assert.equal(player(s, 'p1').rocket.pieces.length, 0);
  });
});
