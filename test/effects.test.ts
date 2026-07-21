import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, applyAll } from '../src/engine.ts';
import { cardsById } from '../src/data.ts';
import { newGame, player, setRocket, give, drawTwo, endTurn } from './helpers.ts';
import type { Action, GameState } from '../src/types.ts';

/** Plays an event card as p1's first action and has every opponent pass. */
function playResolved(s: GameState, instanceId: string, params?: Record<string, unknown>): GameState {
  const others = s.players.filter((p) => p.id !== 'p1').map((p) => p.id);
  return applyAll(s, [
    drawTwo('p1'),
    { type: 'playCard', playerId: 'p1', instanceId, params } as Action,
    ...others.map((pid): Action => ({ type: 'respond', playerId: pid, response: 'pass' })),
  ]);
}

describe('Super Speedy Cows', () => {
  it('moves up to 3, limited by capacity', () => {
    let s = newGame();
    setRocket(s, 'p1', ['nasa_import_top', 'farmmade_middle', 'nasa_import_bottom'], 2); // room for 2 more
    const ssc = give(s, 'p1', 'super_speedy_cows');
    s = playResolved(s, ssc.instanceId);
    assert.equal(player(s, 'p1').rocket.cows, 4);
  });

  it('moves zero if there is no rocket piece (legal fizzle, Decision #9)', () => {
    let s = newGame();
    const ssc = give(s, 'p1', 'super_speedy_cows');
    s = playResolved(s, ssc.instanceId);
    assert.equal(player(s, 'p1').rocket.cows, 0);
    assert.equal(player(s, 'p1').farm, 10);
  });
});

describe('Space Cowboy', () => {
  it('returns an opponent moon cow to their farm', () => {
    let s = newGame();
    player(s, 'p2').moon = 3;
    player(s, 'p2').farm = 7;
    const sc = give(s, 'p1', 'space_cowboy');
    s = playResolved(s, sc.instanceId, { targetPlayerId: 'p2' });
    assert.equal(player(s, 'p2').moon, 2);
    assert.equal(player(s, 'p2').farm, 8);
  });

  it('may target no one, and rejects targets with no moon cows', () => {
    let s = newGame();
    const sc = give(s, 'p1', 'space_cowboy');
    const sc2 = give(s, 'p1', 'space_cowboy');
    s = applyAll(s, [drawTwo('p1')]);
    assert.ok(applyAction(s, { type: 'playCard', playerId: 'p1', instanceId: sc.instanceId, params: { targetPlayerId: 'p2' } }).error);
    s = applyAll(s, [
      { type: 'playCard', playerId: 'p1', instanceId: sc2.instanceId },
      { type: 'respond', playerId: 'p2', response: 'pass' },
    ]);
    assert.equal(s.pending, null); // fizzled cleanly
  });
});

describe('Mini Rocket (Decision #10: any player’s cow)', () => {
  it('puts one of your own farm cows on the moon', () => {
    let s = newGame();
    const mr = give(s, 'p1', 'mini_rocket');
    s = playResolved(s, mr.instanceId, { targetPlayerId: 'p1', from: 'farm' });
    assert.equal(player(s, 'p1').moon, 1);
    assert.equal(player(s, 'p1').farm, 9);
  });

  it('can move a cow out of a rocket, and can target an opponent', () => {
    let s = newGame();
    setRocket(s, 'p2', ['nasa_import_top'], 2);
    const mr = give(s, 'p1', 'mini_rocket');
    s = playResolved(s, mr.instanceId, { targetPlayerId: 'p2', from: 'rocket' });
    assert.equal(player(s, 'p2').moon, 1);
    assert.equal(player(s, 'p2').rocket.cows, 1);
  });

  it('requires a valid source zone', () => {
    let s = newGame();
    const mr = give(s, 'p1', 'mini_rocket');
    s = applyAll(s, [drawTwo('p1')]);
    assert.ok(
      applyAction(s, { type: 'playCard', playerId: 'p1', instanceId: mr.instanceId, params: { targetPlayerId: 'p2', from: 'rocket' } }).error,
    );
  });
});

describe('Cow Wrangler (Decision #2: any player, or no one)', () => {
  it('returns all cows in the target rocket to that player’s farm', () => {
    let s = newGame();
    setRocket(s, 'p2', ['nasa_import_top', 'farmmade_middle'], 3);
    const cw = give(s, 'p1', 'cow_wrangler');
    s = playResolved(s, cw.instanceId, { targetPlayerId: 'p2' });
    assert.equal(player(s, 'p2').rocket.cows, 0);
    assert.equal(player(s, 'p2').farm, 10);
    assert.equal(player(s, 'p2').rocket.pieces.length, 2); // pieces untouched
  });
});

describe('Rocket Thief (Decision #12: excess cows go home)', () => {
  it('steals a piece into the thief’s hand; over-capacity cow returns to farm', () => {
    let s = newGame();
    // Full matching set: capacity 5, fully loaded.
    const pieces = setRocket(s, 'p2', ['nasa_import_top', 'nasa_import_middle', 'nasa_import_bottom'], 5);
    const rt = give(s, 'p1', 'rocket_thief');
    s = playResolved(s, rt.instanceId, { targetPlayerId: 'p2', pieceInstanceId: pieces[0]!.instanceId });
    const p2 = player(s, 'p2');
    assert.equal(p2.rocket.pieces.length, 2);
    assert.equal(p2.rocket.cows, 4); // capacity dropped 5 -> 4, one cow walked home
    assert.equal(p2.farm, 6); // 10 - 5 boarded + 1 returned
    const p1 = player(s, 'p1');
    assert.ok(p1.hand.some((c) => c.instanceId === pieces[0]!.instanceId));
  });

  it('stealing the last piece sends all cows home', () => {
    let s = newGame();
    const pieces = setRocket(s, 'p2', ['nasa_import_top'], 3);
    const rt = give(s, 'p1', 'rocket_thief');
    s = playResolved(s, rt.instanceId, { targetPlayerId: 'p2', pieceInstanceId: pieces[0]!.instanceId });
    const p2 = player(s, 'p2');
    assert.equal(p2.rocket.pieces.length, 0);
    assert.equal(p2.rocket.cows, 0);
    assert.equal(p2.farm, 10);
  });

  it('the stolen piece can be played into the thief’s own rocket', () => {
    let s = newGame();
    const pieces = setRocket(s, 'p2', ['nasa_import_top'], 0);
    const rt = give(s, 'p1', 'rocket_thief');
    s = playResolved(s, rt.instanceId, { targetPlayerId: 'p2', pieceInstanceId: pieces[0]!.instanceId });
    s = applyAll(s, [{ type: 'playCard', playerId: 'p1', instanceId: pieces[0]!.instanceId }]);
    assert.equal(player(s, 'p1').rocket.pieces.length, 1);
  });
});

describe('Bad Weather', () => {
  it('blocks every launch (including the owner’s) until the start of the owner’s next turn', () => {
    let s = newGame();
    setRocket(s, 'p1', ['nasa_import_top', 'farmmade_middle', 'nasa_import_bottom'], 2);
    setRocket(s, 'p2', ['farmmade_top', 'nasa_import_middle', 'farmmade_bottom'], 2);
    const bw = give(s, 'p1', 'bad_weather');
    const myLaunch = give(s, 'p1', 'launch');
    const theirLaunch = give(s, 'p2', 'launch');

    s = playResolved(s, bw.instanceId);
    // Owner is blocked for the rest of their own turn too ("prevents anyone").
    assert.ok(applyAction(s, { type: 'playCard', playerId: 'p1', instanceId: myLaunch.instanceId }).error);
    s = applyAll(s, [
      { type: 'pass', playerId: 'p1' },
      { type: 'pass', playerId: 'p1' },
      endTurn('p1'),
    ]);

    // p2's whole turn: still blocked.
    s = applyAll(s, [drawTwo('p2')]);
    assert.ok(applyAction(s, { type: 'playCard', playerId: 'p2', instanceId: theirLaunch.instanceId }).error);
    s = applyAll(s, [
      { type: 'pass', playerId: 'p2' },
      { type: 'pass', playerId: 'p2' },
      { type: 'pass', playerId: 'p2' },
      endTurn('p2'),
    ]);

    // Back to p1: weather cleared at the start of their turn, launch works.
    assert.equal(s.badWeather.length, 0);
    s = applyAll(s, [drawTwo('p1'), { type: 'playCard', playerId: 'p1', instanceId: myLaunch.instanceId }]);
    assert.equal(player(s, 'p1').moon, 2);
  });
});

describe('Wind', () => {
  it('trades hands with the chosen player and must target someone else', () => {
    let s = newGame();
    const wind = give(s, 'p1', 'wind');
    s = applyAll(s, [drawTwo('p1')]);
    assert.ok(applyAction(s, { type: 'playCard', playerId: 'p1', instanceId: wind.instanceId }).error); // no target
    assert.ok(applyAction(s, { type: 'playCard', playerId: 'p1', instanceId: wind.instanceId, params: { targetPlayerId: 'p1' } }).error); // self

    const p1Cards = player(s, 'p1').hand.filter((c) => c.instanceId !== wind.instanceId).map((c) => c.instanceId);
    const p2Cards = player(s, 'p2').hand.map((c) => c.instanceId);
    s = applyAll(s, [
      { type: 'playCard', playerId: 'p1', instanceId: wind.instanceId, params: { targetPlayerId: 'p2' } },
      { type: 'respond', playerId: 'p2', response: 'pass' },
    ]);
    assert.deepEqual(player(s, 'p1').hand.map((c) => c.instanceId), p2Cards);
    assert.deepEqual(player(s, 'p2').hand.map((c) => c.instanceId), p1Cards);
  });
});

describe('unknown effect fallback (spec 4.4)', () => {
  it('resolves as a no-op and logs cardEffectNotDefined', () => {
    cardsById.set('mystery_card', {
      id: 'mystery_card',
      name: 'Mystery Card',
      type: 'event',
      text: 'Does something nobody has written yet.',
      effect: 'notImplementedYet',
      params: null,
      pieceType: null,
      part: null,
    });
    try {
      let s = newGame();
      const m = give(s, 'p1', 'mystery_card');
      s = playResolved(s, m.instanceId);
      assert.ok(s.log.some((e) => e.type === 'cardEffectNotDefined' && e.cardId === 'mystery_card'));
    } finally {
      cardsById.delete('mystery_card');
    }
  });
});
