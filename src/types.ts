// Core shared types for the Cows To The Moon engine.
// The engine is a pure state machine: (GameState, Action) -> GameState | error.
// No networking, no UI, no timers (spec section 3.2).

export type Part = 'top' | 'middle' | 'bottom';
export type CardType = 'rocketPiece' | 'event' | 'launch';

/** One entry in cards.json. Every card has the same shape (spec 4.1). */
export interface CardDef {
  id: string;
  name: string;
  type: CardType;
  text: string;
  effect: string | null;
  params: Record<string, unknown> | null;
  pieceType: string | null;
  part: Part | 'any' | null;
}

/** One entry in deck.json. */
export interface DeckEntry {
  cardId: string;
  count: number;
}

/** config.json (spec 4.3). Engine only reads the gameplay-relevant keys. */
export interface GameConfig {
  minPlayers: number;
  maxPlayers: number;
  startingHandSize: number;
  emptyHandDrawCount: number;
  drawsPerTurn: number;
  actionsPerTurn: number;
  rocketStoreSize: number;
  startingCowsPerPlayer: number;
  rocketBaseCapacity: number;
  rocketMatchingSetBonusCows: number;
  cownterResponseTimeoutSeconds: number;
  /** Seconds of no action on your own turn before the server skips it (Decision #14). */
  turnInactivityTimeoutSeconds: number;
  playerInactivityTurnLimit: number;
  roomInactivityWarningMinutes: number;
  roomInactivityGraceMinutes: number;
  /** Minutes after a game ends (or all players vanish) before the room is purged (spec 7.4). */
  roomCleanupMinutes: number;
  roomCodeLength: number;
  /** How many trailing log events each player's state view includes (spec 6.6). */
  logTailLength: number;
}

/** A physical copy of a card. instanceId is unique within a game. */
export interface CardInstance {
  instanceId: string;
  cardId: string;
}

export interface RocketState {
  /** Rocket piece card instances currently on the launch pad (max 3). */
  pieces: CardInstance[];
  /** Cows currently buckled in. */
  cows: number;
}

export interface PlayerState {
  id: string;
  name: string;
  hand: CardInstance[];
  /** Cows still on the farm. */
  farm: number;
  /** Cows landed on the moon. */
  moon: number;
  rocket: RocketState;
  /**
   * AFK handling (Decision #6): true once the player has had
   * playerInactivityTurnLimit consecutive turns skipped. Their turns are
   * passed over and cards can't target them, until reactivated (Decision #15).
   */
  inactive: boolean;
  /** Consecutive own-turns skipped by the server timer. Reset by any own-turn action. */
  consecutiveSkips: number;
}

/** Player-supplied targeting/choices when playing a card (spec 7.1). */
export interface PlayParams {
  /** Target player, where the card needs one. Omit to target no one (Decisions #2/#3). */
  targetPlayerId?: string;
  /** Mini Rocket: whether the cow comes from the target's farm or rocket. */
  from?: 'farm' | 'rocket';
  /** Rocket Thief: which piece in play to steal. */
  pieceInstanceId?: string;
}

export type DrawPick =
  | { source: 'deck' }
  | { source: 'rocketStore'; instanceId: string };

export type Action =
  | { type: 'draw'; playerId: string; picks: DrawPick[] }
  | { type: 'playCard'; playerId: string; instanceId: string; params?: PlayParams }
  | { type: 'recycle'; playerId: string; instanceId: string }
  | { type: 'herd'; playerId: string }
  | { type: 'pass'; playerId: string }
  | { type: 'endTurn'; playerId: string }
  | { type: 'respond'; playerId: string; response: 'pass' | 'cownter'; instanceId?: string }
  /**
   * Server-only actions (Phase 3): rooms.ts never maps a client message onto
   * these — they are fired by the server's timers and reconnect handling.
   * `reactivate` returns an AFK/inactive player to the rotation (Decision #15);
   * a player only ever BECOMES inactive via skipTurn strikes, so there is no
   * symmetric "deactivate" action.
   */
  | { type: 'skipTurn'; playerId: string }
  | { type: 'reactivate'; playerId: string };

/** One card on the response stack (spec 6.2/6.4). */
export interface PendingStackItem {
  card: CardInstance;
  playerId: string;
  params?: PlayParams;
}

export interface PendingResponse {
  /** LIFO stack: [0] is the original event card, later entries are Cownters. */
  stack: PendingStackItem[];
  /** Player ids still to respond to the top of the stack, in priority order. toRespond[0] acts next. */
  toRespond: string[];
}

export interface GameEvent {
  type: string;
  [key: string]: unknown;
}

export interface GameState {
  status: 'playing' | 'ended';
  config: GameConfig;
  players: PlayerState[];
  /** Face-down draw pile; the END of the array is the top of the deck. */
  deck: CardInstance[];
  discard: CardInstance[];
  rocketStore: CardInstance[];
  turn: {
    currentPlayerId: string;
    phase: 'draw' | 'action';
    actionsRemaining: number;
    /** Draws left in the Draw Phase. Drawing one at a time lets the client
     *  reveal each card before the next pick; the phase ends when this hits 0. */
    drawsRemaining: number;
  };
  /** Player ids whose Bad Weather is active. Cleared at the start of that player's next turn. */
  badWeather: string[];
  pending: PendingResponse | null;
  winnerId: string | null;
  /** Seeded RNG state, so games are deterministic given a seed. */
  rngState: number;
  /** Counter for generating unique card instance ids. */
  nextInstance: number;
  /** Append-only event log (spec 6.6 action visibility; also great for tests). */
  log: GameEvent[];
}

export interface EngineResult {
  state: GameState;
  error?: string;
}
