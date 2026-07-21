// Rocket-building rules (rules doc "Building, Launching, and Getting to the Moon"
// + Design Decision #11: pieces may be played in any order, but a rocket may
// never contain two pieces for the same part; Wild Cards flex to any part).

import { getCardDef } from './data.ts';
import type { GameConfig, RocketState, CardDef, Part } from './types.ts';

/**
 * A rocket is complete when it holds three pieces AND those pieces can fill
 * bottom/middle/top with no clash — i.e. the concrete (non-wild) parts are
 * distinct, with wilds flexing into whatever remains.
 *
 * This is computed from the pieces themselves rather than trusting a play-time
 * invariant: `pieceAddError` already blocks duplicate concrete parts when a
 * piece is played, so in normal play any 3 pieces are completable and this
 * reduces to a length check. Deriving it here means the function stays correct
 * even if a future effect ever places pieces by another route.
 */
export function rocketComplete(rocket: RocketState): boolean {
  if (rocket.pieces.length !== 3) return false;
  const concreteParts = rocket.pieces
    .map((p) => getCardDef(p.cardId).part)
    .filter((part): part is Part => part !== 'any');
  return new Set(concreteParts).size === concreteParts.length;
}

/** Base 4, +1 if all three pieces share one concrete pieceType (wilds don't count). */
export function rocketCapacity(rocket: RocketState, config: GameConfig): number {
  let capacity = config.rocketBaseCapacity;
  if (rocket.pieces.length === 3) {
    const types = rocket.pieces.map((p) => getCardDef(p.cardId).pieceType);
    const first = types[0];
    if (first && first !== 'wild' && types.every((t) => t === first)) {
      capacity += config.rocketMatchingSetBonusCows;
    }
  }
  return capacity;
}

/** Returns an error message if this piece can't be added, or null if it can. */
export function pieceAddError(rocket: RocketState, def: CardDef): string | null {
  // Defensive: `doPlayCard` only calls this on rocketPiece cards, but this is
  // exported (index.ts), so guard external callers rather than assume the type.
  if (def.type !== 'rocketPiece') return `${def.name} is not a rocket piece`;
  if (rocket.pieces.length >= 3) {
    return 'Your rocket already has all three pieces';
  }
  if (def.part !== 'any') {
    const clash = rocket.pieces.some((p) => {
      const existing = getCardDef(p.cardId);
      return existing.part !== 'any' && existing.part === def.part;
    });
    if (clash) return `Your rocket already has a ${def.part} piece`;
  }
  return null;
}
