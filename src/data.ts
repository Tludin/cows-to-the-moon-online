// Loads and validates the data-driven card system (spec section 4).
// Cards are never hard-coded into game logic: this module is the only place
// that touches the JSON files.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CardDef, DeckEntry, GameConfig } from './types.ts';

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');

function loadJson<T>(file: string): T {
  return JSON.parse(readFileSync(join(dataDir, file), 'utf8')) as T;
}

export const cardDefs: CardDef[] = loadJson<CardDef[]>('cards.json');
export const deckManifest: DeckEntry[] = loadJson<DeckEntry[]>('deck.json');
export const defaultConfig: GameConfig = loadJson<GameConfig>('config.json');

/**
 * Card definitions by id. Exposed as a mutable map so tests (and later,
 * mods/expansions) can register extra card defs without editing the shipped
 * data files.
 */
export const cardsById: Map<string, CardDef> = new Map(cardDefs.map((c) => [c.id, c]));

export function getCardDef(cardId: string): CardDef {
  const def = cardsById.get(cardId);
  if (!def) throw new Error(`Unknown card id: ${cardId}`);
  return def;
}

/** Sanity-checks the data files against each other. Throws on inconsistency. */
export function validateData(): void {
  for (const entry of deckManifest) {
    if (!cardsById.has(entry.cardId)) {
      throw new Error(`deck.json references unknown card id: ${entry.cardId}`);
    }
    if (!Number.isInteger(entry.count) || entry.count < 1) {
      throw new Error(`deck.json has invalid count for ${entry.cardId}`);
    }
  }
  const ids = new Set<string>();
  for (const def of cardDefs) {
    if (ids.has(def.id)) throw new Error(`cards.json has duplicate id: ${def.id}`);
    ids.add(def.id);
  }
}

export function totalDeckSize(): number {
  return deckManifest.reduce((sum, e) => sum + e.count, 0);
}
