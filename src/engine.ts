// The game engine: a pure state machine with no knowledge of networking or UI
// (spec 3.2). applyAction(state, action) returns a NEW state (the input is
// never mutated) or the original state plus an error message.

import { defaultConfig, deckManifest, getCardDef, validateData } from './data.ts';
import { effectRegistry, isCownter } from './effects.ts';
import { pieceAddError, rocketComplete } from './rocket.ts';
import { shuffle } from './rng.ts';
import {
  checkWin,
  drawOneFromDeck,
  herdError,
  othersInTurnOrder,
  requirePlayer,
  tryHerdOne,
} from './util.ts';
import type {
  Action,
  DrawPick,
  EngineResult,
  GameConfig,
  GameState,
  PlayParams,
  PlayerState,
} from './types.ts';

export interface CreateGameOptions {
  playerNames: string[];
  seed?: number;
  /** Index into playerNames of who goes first (the rules leave this social). Default 0. */
  firstPlayerIndex?: number;
  config?: Partial<GameConfig>;
}

export function createGame(opts: CreateGameOptions): GameState {
  validateData();
  const config: GameConfig = { ...defaultConfig, ...opts.config };
  const n = opts.playerNames.length;
  if (n < config.minPlayers || n > config.maxPlayers) {
    throw new Error(`Player count must be ${config.minPlayers}-${config.maxPlayers}, got ${n}`);
  }

  const players: PlayerState[] = opts.playerNames.map((name, i) => ({
    id: `p${i + 1}`,
    name,
    hand: [],
    farm: config.startingCowsPerPlayer,
    moon: 0,
    rocket: { pieces: [], cows: 0 },
    inactive: false,
    consecutiveSkips: 0,
  }));

  const s: GameState = {
    status: 'playing',
    config,
    players,
    deck: [],
    discard: [],
    rocketStore: [],
    turn: {
      currentPlayerId: players[(opts.firstPlayerIndex ?? 0) % n]!.id,
      phase: 'draw',
      actionsRemaining: 0,
      drawsRemaining: config.drawsPerTurn,
    },
    badWeather: [],
    pending: null,
    winnerId: null,
    rngState: (opts.seed ?? Date.now()) | 0,
    nextInstance: 1,
    log: [],
  };

  // Build and shuffle the deck from the manifest (spec 4.2).
  for (const entry of deckManifest) {
    for (let i = 0; i < entry.count; i++) {
      s.deck.push({ instanceId: `c${s.nextInstance++}`, cardId: entry.cardId });
    }
  }
  shuffle(s, s.deck);

  // Deal opening hands, then fill the Rocket Store.
  for (let i = 0; i < config.startingHandSize; i++) {
    for (const p of s.players) {
      const card = drawOneFromDeck(s);
      if (card) p.hand.push(card);
    }
  }
  refillRocketStore(s);
  s.log.push({ type: 'gameStarted', players: players.map((p) => p.id) });
  return s;
}

export function applyAction(prev: GameState, action: Action): EngineResult {
  const fail = (error: string): EngineResult => ({ state: prev, error });

  if (prev.status === 'ended') return fail('The game is over');

  // While a response window is open, only `respond` is legal (spec 6.2).
  // reactivate is exempt: a reconnecting player may be reactivated at any time
  // without touching the stack (Decision #15).
  if (prev.pending && action.type !== 'respond' && action.type !== 'reactivate') {
    return fail('Waiting for Cownter responses');
  }
  if (!prev.pending && action.type === 'respond') {
    return fail('There is nothing to respond to');
  }

  const s = structuredClone(prev);
  const error = dispatch(s, action);
  if (error) return fail(error);

  // Any real own-turn action proves the player is present: reset their strike
  // count (Decision #14). Server-fired skips/responds don't count as presence.
  if (
    action.type !== 'skipTurn' &&
    action.type !== 'reactivate' &&
    action.type !== 'respond' &&
    action.playerId === prev.turn.currentPlayerId
  ) {
    const actor = s.players.find((p) => p.id === action.playerId);
    if (actor) actor.consecutiveSkips = 0;
  }
  return { state: s };
}

function dispatch(s: GameState, action: Action): string | null {
  switch (action.type) {
    case 'draw':
      return doDraw(s, action.playerId, action.picks);
    case 'playCard':
      return doPlayCard(s, action.playerId, action.instanceId, action.params);
    case 'recycle':
      return doRecycle(s, action.playerId, action.instanceId);
    case 'herd':
      return doHerd(s, action.playerId);
    case 'pass':
      return doPass(s, action.playerId);
    case 'endTurn':
      return doEndTurn(s, action.playerId);
    case 'respond':
      return doRespond(s, action.playerId, action.response, action.instanceId);
    case 'skipTurn':
      return doSkipTurn(s, action.playerId);
    case 'reactivate':
      return doReactivate(s, action.playerId);
    default:
      return 'Unknown action type';
  }
}

// ---------------------------------------------------------------- Draw Phase

function doDraw(s: GameState, playerId: string, picks: DrawPick[]): string | null {
  const err = requireTurn(s, playerId, 'draw');
  if (err) return err;
  const p = requirePlayer(s, playerId);

  // Empty hand at the START of the Draw Phase: draw 5 from the deck in one shot
  // (rules doc, Draw Phase). "Start" = no draws taken yet this phase, so a
  // reshuffle that leaves you empty mid-phase can't re-trigger it.
  const untouched = s.turn.drawsRemaining === s.config.drawsPerTurn;
  if (p.hand.length === 0 && untouched) {
    let drawn = 0;
    for (let i = 0; i < s.config.emptyHandDrawCount; i++) {
      const card = drawOneFromDeck(s);
      if (!card) break;
      p.hand.push(card);
      drawn++;
    }
    s.turn.drawsRemaining = 0;
    s.log.push({ type: 'drewEmptyHand', playerId, drawn });
    beginActionPhase(s);
    return null;
  }

  // Normal draws are processed one pick at a time, so the client can reveal each
  // drawn card before the next pick. Sending several picks in one message is
  // still accepted (it just draws them together). A mid-loop error rolls the
  // whole action back — applyAction discards the working state on failure.
  if (picks.length === 0) return 'Pick a card to draw';
  if (picks.length > s.turn.drawsRemaining) {
    const left = s.turn.drawsRemaining;
    return `You have only ${left} draw${left === 1 ? '' : 's'} left`;
  }
  for (const pick of picks) {
    if (pick.source === 'deck') {
      // Best-effort by design: a deck pick when both piles are empty is a legal
      // no-op (drawing "what it can"), so a bot or a simple client can always
      // draw [deck, deck] without inspecting pile sizes, and the Draw Phase can
      // never soft-lock. The client separately disables the deck button when the
      // store could cover the draw instead, purely to avoid a wasted click.
      const card = drawOneFromDeck(s);
      if (card) p.hand.push(card);
    } else if (pick.source === 'rocketStore') {
      const idx = s.rocketStore.findIndex((c) => c.instanceId === pick.instanceId);
      if (idx === -1) return 'That card is not in the Rocket Store';
      p.hand.push(s.rocketStore.splice(idx, 1)[0]!);
      // Note: the store is NOT refilled until end of turn (spec 6.1 #5).
    } else {
      return 'Draw source must be "deck" or "rocketStore"';
    }
    s.turn.drawsRemaining -= 1;
  }
  s.log.push({ type: 'drew', playerId, picks });
  if (s.turn.drawsRemaining === 0) beginActionPhase(s);
  return null;
}

function beginActionPhase(s: GameState): void {
  s.turn.phase = 'action';
  s.turn.actionsRemaining = s.config.actionsPerTurn;
}

// -------------------------------------------------------------- Action Phase

function doPlayCard(
  s: GameState,
  playerId: string,
  instanceId: string,
  params?: PlayParams,
): string | null {
  const err = requireTurn(s, playerId, 'action');
  if (err) return err;
  const p = requirePlayer(s, playerId);
  const idx = p.hand.findIndex((c) => c.instanceId === instanceId);
  if (idx === -1) return 'That card is not in your hand';
  const card = p.hand[idx]!;
  const def = getCardDef(card.cardId);

  if (def.type === 'rocketPiece') {
    // Rocket pieces resolve instantly — not counterable (spec 6.5).
    const pieceErr = pieceAddError(p.rocket, def);
    if (pieceErr) return pieceErr;
    p.hand.splice(idx, 1);
    p.rocket.pieces.push(card);
    s.log.push({ type: 'rocketPiecePlayed', playerId, cardId: card.cardId });
    consumeAction(s);
    return null;
  }

  if (def.type === 'launch') {
    // Launch resolves instantly — not counterable (spec 6.5). It is dispatched
    // by `type`, not through the effect registry, so its `effect` in cards.json
    // is null. (Cownter's "cancelEvent" key, by contrast, IS meaningful: it's
    // how isCownter identifies the card, per spec 4.1.)
    if (!rocketComplete(p.rocket)) return 'Your rocket is not complete';
    if (s.badWeather.length > 0) return 'Bad Weather prevents all launches right now';
    p.hand.splice(idx, 1);
    s.discard.push(card);
    const cows = p.rocket.cows;
    p.moon += cows;
    s.discard.push(...p.rocket.pieces);
    p.rocket.pieces = [];
    p.rocket.cows = 0;
    s.log.push({ type: 'rocketLaunched', playerId, cows });
    checkWin(s, p);
    consumeAction(s);
    return null;
  }

  // Event card: validate now, open the response window, resolve later (spec 6.2).
  const handler = def.effect ? effectRegistry[def.effect] : undefined;
  if (handler?.validate) {
    const vErr = handler.validate({ s, playerId, params, cardParams: def.params });
    if (vErr) return vErr;
  }
  p.hand.splice(idx, 1);
  s.pending = {
    stack: [{ card, playerId, params }],
    toRespond: othersInTurnOrder(s, playerId),
  };
  s.log.push({ type: 'eventPlayed', playerId, cardId: card.cardId, params: params ?? null });
  consumeAction(s); // playing the card costs the action even if it gets Cownter-ed
  // With no active opponents left to respond (all inactive), resolve at once.
  if (s.pending.toRespond.length === 0) resolveStack(s);
  return null;
}

function doRecycle(s: GameState, playerId: string, instanceId: string): string | null {
  const err = requireTurn(s, playerId, 'action');
  if (err) return err;
  const p = requirePlayer(s, playerId);
  const idx = p.hand.findIndex((c) => c.instanceId === instanceId);
  if (idx === -1) return 'That card is not in your hand';
  const card = p.hand.splice(idx, 1)[0]!;
  s.discard.push(card);
  const drawn = drawOneFromDeck(s);
  if (drawn) p.hand.push(drawn);
  s.log.push({ type: 'recycled', playerId, cardId: card.cardId });
  consumeAction(s);
  return null;
}

function doHerd(s: GameState, playerId: string): string | null {
  const err = requireTurn(s, playerId, 'action');
  if (err) return err;
  const p = requirePlayer(s, playerId);
  const boardErr = herdError(s, p);
  if (boardErr) return boardErr;
  tryHerdOne(s, p);
  s.log.push({ type: 'herded', playerId });
  consumeAction(s);
  return null;
}

function doPass(s: GameState, playerId: string): string | null {
  const err = requireTurn(s, playerId, 'action');
  if (err) return err;
  s.log.push({ type: 'passedAction', playerId });
  consumeAction(s);
  return null;
}

/**
 * Explicit end of turn (Decision #13): the turn NEVER passes automatically.
 * Once all actions are spent this is the only legal move; pressed earlier, it
 * forfeits the remaining actions.
 */
function doEndTurn(s: GameState, playerId: string): string | null {
  if (s.turn.currentPlayerId !== playerId) return 'It is not your turn';
  if (s.turn.phase !== 'action') return 'You must draw before ending your turn';
  s.log.push({ type: 'turnEnded', playerId, forfeitedActions: s.turn.actionsRemaining });
  finishTurn(s);
  return null;
}

// -------------------------------------------- AFK handling (Decisions #14/#15)

/**
 * Server-fired when the current player's turn timer expires (Decision #14):
 * the turn is forfeited from any phase. An AFK strike only counts if the
 * player took NO action-phase action this turn (Decision #6's literal
 * wording) — a player who used their actions and then paused at End Turn is
 * clearly playing, so their turn just auto-ends with no strike.
 */
function doSkipTurn(s: GameState, playerId: string): string | null {
  if (s.turn.currentPlayerId !== playerId) return 'Not the current player';
  const p = requirePlayer(s, playerId);
  const tookNoActions =
    s.turn.phase === 'draw' || s.turn.actionsRemaining >= s.config.actionsPerTurn;
  if (tookNoActions) {
    p.consecutiveSkips += 1;
    s.log.push({ type: 'turnSkipped', playerId, strikes: p.consecutiveSkips });
    if (!p.inactive && p.consecutiveSkips >= s.config.playerInactivityTurnLimit) {
      p.inactive = true;
      s.log.push({ type: 'playerWentInactive', playerId });
    }
  } else {
    s.log.push({ type: 'turnAutoEnded', playerId });
  }
  finishTurn(s);
  return null;
}

/**
 * Server-fired on reconnect or an "I'm back" click (Decision #15): clears any
 * AFK strikes and returns an inactive player to the rotation. Marking a player
 * inactive is the sole job of skipTurn's strike counter, so there is no inverse
 * here.
 */
function doReactivate(s: GameState, playerId: string): string | null {
  const p = requirePlayer(s, playerId);
  p.consecutiveSkips = 0;
  if (p.inactive) {
    p.inactive = false;
    s.log.push({ type: 'playerReturned', playerId });
  }
  return null;
}

// ------------------------------------------------- Cownter Response Window

function doRespond(
  s: GameState,
  playerId: string,
  response: 'pass' | 'cownter',
  instanceId?: string,
): string | null {
  const pending = s.pending!;
  if (pending.toRespond[0] !== playerId) {
    return pending.toRespond.includes(playerId)
      ? 'Not your turn to respond yet'
      : 'You cannot respond to this';
  }

  if (response === 'pass') {
    pending.toRespond.shift();
    s.log.push({ type: 'respondedPass', playerId });
    if (pending.toRespond.length === 0) resolveStack(s);
    return null;
  }

  // Playing a Cownter (free — costs no action; rules doc Card Reference).
  const p = requirePlayer(s, playerId);
  const idx = instanceId
    ? p.hand.findIndex((c) => c.instanceId === instanceId)
    : p.hand.findIndex((c) => isCownter(c.cardId));
  if (idx === -1) return 'You have no Cownter to play';
  const card = p.hand[idx]!;
  if (!isCownter(card.cardId)) return 'That card is not a Cownter';
  p.hand.splice(idx, 1);

  // The Cownter goes on top of the stack and is itself counterable (spec 6.4).
  pending.stack.push({ card, playerId });
  pending.toRespond = othersInTurnOrder(s, playerId);
  s.log.push({ type: 'cownterPlayed', playerId });
  if (pending.toRespond.length === 0) resolveStack(s); // defensive: no active responders
  return null;
}

/** Everyone passed: resolve the stack by parity (each Cownter cancels the card below it). */
function resolveStack(s: GameState): void {
  const stack = s.pending!.stack;
  s.pending = null;
  const base = stack[0]!;
  const cancelled = (stack.length - 1) % 2 === 1;
  for (const item of stack) s.discard.push(item.card);

  if (cancelled) {
    s.log.push({ type: 'eventCancelled', cardId: base.card.cardId, playerId: base.playerId });
  } else {
    const def = getCardDef(base.card.cardId);
    const handler = def.effect ? effectRegistry[def.effect] : undefined;
    if (!handler) {
      // Fallback for half-built cards (spec 4.4): no-op, but say so loudly.
      s.log.push({ type: 'cardEffectNotDefined', cardId: base.card.cardId, effect: def.effect });
    } else {
      handler.apply({ s, playerId: base.playerId, params: base.params, cardParams: def.params });
      s.log.push({ type: 'eventResolved', cardId: base.card.cardId, playerId: base.playerId });
    }
  }
}

// ------------------------------------------------------------ Turn plumbing

function requireTurn(s: GameState, playerId: string, phase: 'draw' | 'action'): string | null {
  if (s.turn.currentPlayerId !== playerId) return 'It is not your turn';
  if (s.turn.phase !== phase) {
    return phase === 'draw' ? 'The Draw Phase is over' : 'You must draw first';
  }
  if (phase === 'action' && s.turn.actionsRemaining < 1) {
    return 'No actions remaining — end your turn';
  }
  return null;
}

function consumeAction(s: GameState): void {
  s.turn.actionsRemaining -= 1;
}

/**
 * Passes play to the left, skipping inactive players (Decision #6). Only ever
 * triggered by the endTurn or skipTurn actions (Decision #13).
 */
function finishTurn(s: GameState): void {
  // Refill the Rocket Store as the very last thing before the turn passes (spec 6.1 #5).
  refillRocketStore(s);

  const n = s.players.length;
  const idx = s.players.findIndex((p) => p.id === s.turn.currentPlayerId);
  let next: PlayerState | null = null;
  for (let hop = 1; hop <= n; hop++) {
    const cand = s.players[(idx + hop) % n]!;
    // Their turn is starting — or being passed over, which still counts as
    // "the start of your next turn" (Decision #16) — so Bad Weather clears.
    s.badWeather = s.badWeather.filter((id) => id !== cand.id);
    if (!cand.inactive) {
      next = cand;
      break;
    }
    s.log.push({ type: 'turnPassedOver', playerId: cand.id });
  }
  // Everyone inactive (degenerate): hand the turn left anyway; the room's
  // whole-table inactivity timeout will end the game shortly (spec section 5).
  next ??= s.players[(idx + 1) % n]!;

  s.turn.currentPlayerId = next.id;
  s.turn.phase = 'draw';
  s.turn.actionsRemaining = 0;
  s.turn.drawsRemaining = s.config.drawsPerTurn;
  s.log.push({ type: 'turnStarted', playerId: next.id });
}

function refillRocketStore(s: GameState): void {
  while (s.rocketStore.length < s.config.rocketStoreSize) {
    const card = drawOneFromDeck(s);
    if (!card) break;
    s.rocketStore.push(card);
  }
}

/** Convenience for tests/CLIs: apply a sequence of actions, throwing on any error. */
export function applyAll(state: GameState, actions: Action[]): GameState {
  let s = state;
  for (const a of actions) {
    const r = applyAction(s, a);
    if (r.error) throw new Error(`Action ${JSON.stringify(a)} failed: ${r.error}`);
    s = r.state;
  }
  return s;
}
