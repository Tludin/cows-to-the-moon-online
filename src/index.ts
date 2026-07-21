// Public API of the engine module. Later phases (networking, UI) import from
// here and nowhere else.

export { createGame, applyAction, applyAll } from './engine.ts';
export type { CreateGameOptions } from './engine.ts';
export { cardsById, cardDefs, deckManifest, defaultConfig, getCardDef, totalDeckSize, validateData } from './data.ts';
export { rocketCapacity, rocketComplete, pieceAddError } from './rocket.ts';
export { effectRegistry, isCownter } from './effects.ts';
export type * from './types.ts';
