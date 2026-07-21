// Shared helpers used by both the engine and the effect handlers.

import { shuffle } from './rng.ts';
import { rocketCapacity } from './rocket.ts';
import type { CardInstance, GameState, PlayerState } from './types.ts';

export function getPlayer(s: GameState, playerId: string): PlayerState | undefined {
  return s.players.find((p) => p.id === playerId);
}

export function requirePlayer(s: GameState, playerId: string): PlayerState {
  const p = getPlayer(s, playerId);
  if (!p) throw new Error(`Unknown player: ${playerId}`);
  return p;
}

/**
 * Draws one card from the deck, reshuffling the discard pile into a fresh deck
 * if the deck is empty (Design Decision #1). Returns undefined only when both
 * piles are empty.
 */
export function drawOneFromDeck(s: GameState): CardInstance | undefined {
  if (s.deck.length === 0 && s.discard.length > 0) {
    s.deck = s.discard;
    s.discard = [];
    shuffle(s, s.deck);
    s.log.push({ type: 'deckReshuffled', cards: s.deck.length });
  }
  return s.deck.pop();
}

/**
 * The single source of truth for whether a cow may board (Decision #9: needs
 * at least 1 piece). Returns a player-facing reason, or null if herding is legal.
 */
export function herdError(s: GameState, p: PlayerState): string | null {
  if (p.farm < 1) return 'You have no cows on your farm';
  if (p.rocket.pieces.length < 1) {
    return 'You need at least one rocket piece on your launch pad before cows can board';
  }
  if (p.rocket.cows >= rocketCapacity(p.rocket, s.config)) return 'Your rocket is full';
  return null;
}

/** Moves one cow farm -> rocket if legal. Returns success. */
export function tryHerdOne(s: GameState, p: PlayerState): boolean {
  if (herdError(s, p)) return false;
  p.farm -= 1;
  p.rocket.cows += 1;
  return true;
}

/** Call after any cow reaches the moon. Ends the game if someone has all 10 up there. */
export function checkWin(s: GameState, p: PlayerState): void {
  if (s.status === 'playing' && p.moon >= s.config.startingCowsPerPlayer) {
    s.status = 'ended';
    s.winnerId = p.id;
    s.log.push({ type: 'gameOver', winnerId: p.id });
  }
}

/**
 * All ACTIVE players except `playerId`, in seating order starting from the
 * player to their left. Inactive players are excluded (Decision #6): they
 * can't respond to events, so the Cownter window never waits on them.
 */
export function othersInTurnOrder(s: GameState, playerId: string): string[] {
  const idx = s.players.findIndex((p) => p.id === playerId);
  const out: string[] = [];
  for (let i = 1; i < s.players.length; i++) {
    const p = s.players[(idx + i) % s.players.length];
    if (p && !p.inactive) out.push(p.id);
  }
  return out;
}

/**
 * Shared targeting gate (Decision #6: inactive players can't be targeted).
 * Returns a player-facing error, or null if the target is legal.
 */
export function untargetableError(s: GameState, targetPlayerId: string): string | null {
  const t = getPlayer(s, targetPlayerId);
  if (!t) return 'No such player';
  if (t.inactive) return `${t.name} is inactive and can't be targeted`;
  return null;
}
