// Per-player scoped views of the game state (spec 7.3): each player sees
// their own hand in full; other hands collapse to a count. The deck collapses
// to a count. RNG internals are stripped so a client can never predict the
// shuffle. Everything else is public per the physical rules.
//
// Card instances are enriched with their definition (name/type/text) so the
// client needs no copy of cards.json — it renders whatever the server sends,
// which is exactly the data-driven goal of spec 4.

import { getCardDef, rocketCapacity, rocketComplete } from '../src/index.ts';
import type { CardInstance, GameState, PendingResponse, PlayParams } from '../src/index.ts';

export interface CardView {
  instanceId: string;
  cardId: string;
  name: string;
  type: string;
  text: string;
  /** Effect key + static params, so the client keys UI logic (target pickers,
   *  confirmations) off behavior rather than hard-coded card ids (spec 4.4). */
  effect: string | null;
  params: Record<string, unknown> | null;
  /** Rocket-piece identity (public: pieces sit face-up on the pad). null for
   *  non-pieces. Lets the client stack/label/colour the launch pad. */
  pieceType: string | null;
  part: string | null;
}

export interface PlayerView {
  id: string;
  name: string;
  connected: boolean;
  /** AFK (Decision #6): turns auto-skip and cards can't target them. */
  inactive: boolean;
  farm: number;
  moon: number;
  rocket: { pieces: CardView[]; cows: number; complete: boolean; capacity: number };
  /** Full hand for yourself... */
  hand?: CardView[];
  /** ...just a count for everyone else. */
  handCount: number;
}

export interface GameView {
  status: 'playing' | 'ended';
  you: string;
  players: PlayerView[];
  deckCount: number;
  discard: CardView[];
  rocketStore: CardView[];
  turn: GameState['turn'];
  badWeather: string[];
  pending: PendingView | null;
  winnerId: string | null;
  actionsPerTurn: number;
  drawsPerTurn: number;
  /** Tail of the event log for table awareness (spec 6.6). */
  log: GameState['log'];
}

export interface PendingView {
  /**
   * The event card being responded to plus any Cownters stacked on it.
   * Targeting params are public information at a physical table (everyone sees
   * whose rocket the Wrangler is aimed at), so they're included for the
   * responders' Cownter decision.
   */
  stack: { card: CardView; playerId: string; params: PlayParams | null }[];
  toRespond: string[];
}

export function cardView(c: CardInstance): CardView {
  const def = getCardDef(c.cardId);
  return {
    instanceId: c.instanceId,
    cardId: c.cardId,
    name: def.name,
    type: def.type,
    text: def.text,
    effect: def.effect,
    params: def.params,
    pieceType: def.pieceType,
    part: def.part,
  };
}

function pendingView(pending: PendingResponse | null): PendingView | null {
  if (!pending) return null;
  return {
    stack: pending.stack.map((item) => ({
      card: cardView(item.card),
      playerId: item.playerId,
      params: item.params ?? null,
    })),
    toRespond: [...pending.toRespond],
  };
}

/** Builds the state view for one player. `connectedIds` comes from the room. */
export function scopedView(s: GameState, forPlayerId: string, connectedIds: Set<string>): GameView {
  return {
    status: s.status,
    you: forPlayerId,
    players: s.players.map((p) => ({
      id: p.id,
      name: p.name,
      connected: connectedIds.has(p.id),
      inactive: p.inactive,
      farm: p.farm,
      moon: p.moon,
      rocket: {
        pieces: p.rocket.pieces.map(cardView),
        cows: p.rocket.cows,
        complete: rocketComplete(p.rocket),
        capacity: rocketCapacity(p.rocket, s.config),
      },
      ...(p.id === forPlayerId ? { hand: p.hand.map(cardView) } : {}),
      handCount: p.hand.length,
    })),
    deckCount: s.deck.length,
    discard: s.discard.map(cardView),
    rocketStore: s.rocketStore.map(cardView),
    turn: structuredClone(s.turn),
    badWeather: [...s.badWeather],
    pending: pendingView(s.pending),
    winnerId: s.winnerId,
    actionsPerTurn: s.config.actionsPerTurn,
    drawsPerTurn: s.config.drawsPerTurn,
    log: s.log.slice(-s.config.logTailLength),
  };
}
