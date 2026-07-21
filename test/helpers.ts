// Test utilities: rig hands/rockets into known configurations so scenarios
// are deterministic regardless of the shuffle.

import { createGame } from '../src/engine.ts';
import type { CardInstance, GameState, PlayerState } from '../src/types.ts';

export function newGame(names: string[] = ['Alice', 'Bob'], seed = 42): GameState {
  return createGame({ playerNames: names, seed });
}

export function player(s: GameState, id: string): PlayerState {
  const p = s.players.find((x) => x.id === id);
  if (!p) throw new Error(`no player ${id}`);
  return p;
}

/** Creates a fresh card instance of the given cardId (not taken from the deck). */
export function mint(s: GameState, cardId: string): CardInstance {
  return { instanceId: `t${s.nextInstance++}`, cardId };
}

/** Replaces a player's hand with exactly these cards. Returns the instances in order. */
export function setHand(s: GameState, playerId: string, cardIds: string[]): CardInstance[] {
  const p = player(s, playerId);
  p.hand = cardIds.map((id) => mint(s, id));
  return p.hand;
}

/** Adds one card to a player's hand. Returns its instance. */
export function give(s: GameState, playerId: string, cardId: string): CardInstance {
  const c = mint(s, cardId);
  player(s, playerId).hand.push(c);
  return c;
}

/** Puts rocket pieces straight onto a player's launch pad. Returns the instances. */
export function setRocket(
  s: GameState,
  playerId: string,
  pieceCardIds: string[],
  cows = 0,
): CardInstance[] {
  const p = player(s, playerId);
  p.rocket.pieces = pieceCardIds.map((id) => mint(s, id));
  p.rocket.cows = cows;
  p.farm = Math.max(0, p.farm - cows);
  return p.rocket.pieces;
}

/** Skips the current player's draw phase legally (draws 2 from deck). */
export const drawTwo = (playerId: string) =>
  ({ type: 'draw', playerId, picks: [{ source: 'deck' }, { source: 'deck' }] }) as const;

/** Explicit end of turn (Decision #13). */
export const endTurn = (playerId: string) => ({ type: 'endTurn', playerId }) as const;
