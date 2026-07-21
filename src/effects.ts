// Effect handler registry (spec 4.4). A card's `effect` field is a string key
// into this registry. `validate` runs when the card is *played* (so illegal
// plays are rejected before an action is spent); `apply` runs when the card
// *resolves* (after the Cownter response window).
//
// Board state can't change between play and resolve (Cownters only move cards
// out of hands), so validating at play time is safe.

import { getCardDef } from './data.ts';
import { rocketCapacity } from './rocket.ts';
import { checkWin, requirePlayer, tryHerdOne, untargetableError } from './util.ts';
import type { GameState, PlayParams } from './types.ts';

export interface EffectContext {
  s: GameState;
  /** The player who played the card. */
  playerId: string;
  /** Player-supplied targeting choices. */
  params?: PlayParams;
  /** Static params from the card definition (e.g. { count: 3 }). */
  cardParams: Record<string, unknown> | null;
}

export interface EffectHandler {
  /** Returns an error message if the play is illegal right now, else null. */
  validate?: (ctx: EffectContext) => string | null;
  apply: (ctx: EffectContext) => void;
}

export const effectRegistry: Record<string, EffectHandler> = {
  /**
   * Super Speedy Cows — move up to `count` cows farm -> rocket (Appendix A
   * clarification). `count` comes from the card's params in cards.json and is
   * required: a card entry without it is half-built data, rejected at play
   * time (spec 4.4 spirit) rather than silently defaulted here.
   */
  moveCowsFarmToRocket: {
    validate({ cardParams }) {
      const count = cardParams?.count;
      return typeof count === 'number' && Number.isInteger(count) && count > 0
        ? null
        : 'Card data error: moveCowsFarmToRocket needs a positive integer `count` param';
    },
    apply({ s, playerId, cardParams }) {
      const p = requirePlayer(s, playerId);
      // `validate` (run at play time) already guarantees a positive integer;
      // the `?? 0` is an unreachable safety net that keeps the loop bounded
      // even if apply were ever reached on unvalidated data.
      const count = typeof cardParams?.count === 'number' ? cardParams.count : 0;
      let moved = 0;
      for (let i = 0; i < count; i++) {
        if (!tryHerdOne(s, p)) break;
        moved++;
      }
      s.log.push({ type: 'cowsMovedToRocket', playerId, moved });
    },
  },

  /** Space Cowboy — return a cow from the moon to its owner's farm (Decision #3: any player, or no one). */
  moveCowMoonToFarm: {
    validate({ s, params }) {
      if (!params?.targetPlayerId) return null; // targeting no one is a legal, do-nothing play
      const tErr = untargetableError(s, params.targetPlayerId);
      if (tErr) return tErr;
      const t = requirePlayer(s, params.targetPlayerId);
      if (t.moon < 1) return `${t.name} has no cows on the moon`;
      return null;
    },
    apply({ s, params }) {
      if (!params?.targetPlayerId) return;
      const t = requirePlayer(s, params.targetPlayerId);
      if (t.moon < 1) return;
      t.moon -= 1;
      t.farm += 1;
      s.log.push({ type: 'cowReturnedFromMoon', targetPlayerId: t.id });
    },
  },

  /** Mini Rocket — put any one cow (any player's; Decision #10) on the moon. */
  moveCowToMoon: {
    validate({ s, params }) {
      if (!params?.targetPlayerId) return null; // allowed to fizzle, consistent with other targeted events
      const tErr = untargetableError(s, params.targetPlayerId);
      if (tErr) return tErr;
      const t = requirePlayer(s, params.targetPlayerId);
      if (params.from !== 'farm' && params.from !== 'rocket') {
        return "Mini Rocket needs `from`: 'farm' or 'rocket'";
      }
      const available = params.from === 'farm' ? t.farm : t.rocket.cows;
      if (available < 1) return `${t.name} has no cow in their ${params.from}`;
      return null;
    },
    apply({ s, params }) {
      if (!params?.targetPlayerId) return;
      const t = requirePlayer(s, params.targetPlayerId);
      if (params.from === 'farm' && t.farm > 0) t.farm -= 1;
      else if (params.from === 'rocket' && t.rocket.cows > 0) t.rocket.cows -= 1;
      else return;
      t.moon += 1;
      s.log.push({ type: 'cowLandedByMiniRocket', targetPlayerId: t.id, from: params.from });
      checkWin(s, t);
    },
  },

  /** Cow Wrangler — all cows in a player's rocket go home (Decision #2: any player, or no one). */
  returnRocketCowsToFarm: {
    validate({ s, params }) {
      if (!params?.targetPlayerId) return null;
      const tErr = untargetableError(s, params.targetPlayerId);
      if (tErr) return tErr;
      const t = requirePlayer(s, params.targetPlayerId);
      if (t.rocket.cows < 1) return `${t.name} has no cows in their rocket`;
      return null;
    },
    apply({ s, params }) {
      if (!params?.targetPlayerId) return;
      const t = requirePlayer(s, params.targetPlayerId);
      const wrangled = t.rocket.cows;
      t.farm += wrangled;
      t.rocket.cows = 0;
      s.log.push({ type: 'cowsWrangled', targetPlayerId: t.id, count: wrangled });
    },
  },

  /**
   * Rocket Thief — take any rocket piece in play into your hand.
   * Decision #12: cows over the new capacity return to the farm; if the last
   * piece is taken, all cows return to the farm.
   */
  stealRocketPiece: {
    validate({ s, params }) {
      if (!params?.targetPlayerId) return null;
      const tErr = untargetableError(s, params.targetPlayerId);
      if (tErr) return tErr;
      const t = requirePlayer(s, params.targetPlayerId);
      if (!params.pieceInstanceId) return 'Rocket Thief needs `pieceInstanceId`';
      if (!t.rocket.pieces.some((p) => p.instanceId === params.pieceInstanceId)) {
        return `${t.name}'s rocket has no such piece`;
      }
      return null;
    },
    apply({ s, playerId, params }) {
      if (!params?.targetPlayerId || !params.pieceInstanceId) return;
      const thief = requirePlayer(s, playerId);
      const t = requirePlayer(s, params.targetPlayerId);
      const idx = t.rocket.pieces.findIndex((p) => p.instanceId === params.pieceInstanceId);
      if (idx === -1) return;
      const piece = t.rocket.pieces.splice(idx, 1)[0]!;
      thief.hand.push(piece);
      let returned = 0;
      if (t.rocket.pieces.length === 0) {
        returned = t.rocket.cows;
      } else {
        const cap = rocketCapacity(t.rocket, s.config);
        if (t.rocket.cows > cap) returned = t.rocket.cows - cap;
      }
      t.rocket.cows -= returned;
      t.farm += returned;
      s.log.push({
        type: 'rocketPieceStolen',
        playerId,
        targetPlayerId: t.id,
        cardId: piece.cardId,
        cowsReturned: returned,
      });
    },
  },

  /** Bad Weather — nobody may launch until the start of this player's next turn. */
  preventLaunches: {
    apply({ s, playerId }) {
      if (!s.badWeather.includes(playerId)) s.badWeather.push(playerId);
      s.log.push({ type: 'badWeatherStarted', playerId });
    },
  },

  /** Wind — trade hands with any other player. */
  swapHands: {
    validate({ s, playerId, params }) {
      if (!params?.targetPlayerId) return 'Wind needs a target player';
      if (params.targetPlayerId === playerId) return 'Wind must target another player';
      return untargetableError(s, params.targetPlayerId);
    },
    apply({ s, playerId, params }) {
      if (!params?.targetPlayerId) return;
      const p = requirePlayer(s, playerId);
      const t = requirePlayer(s, params.targetPlayerId);
      const tmp = p.hand;
      p.hand = t.hand;
      t.hand = tmp;
      s.log.push({ type: 'handsSwapped', playerId, targetPlayerId: t.id });
    },
  },

  /**
   * Cownter — cancels an event card. Never applied through the registry: the
   * response stack handles cancellation by parity (engine.resolveStack). It
   * can't be played proactively as a normal action.
   */
  cancelEvent: {
    validate() {
      return 'A Cownter is played in response to an event card, not as its own action';
    },
    apply() {
      /* handled by the response stack, never invoked */
    },
  },
};

/** True if this card def is a Cownter-style card (identified by effect, per spec 4.1). */
export function isCownter(cardId: string): boolean {
  return getCardDef(cardId).effect === 'cancelEvent';
}
