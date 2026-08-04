// Room manager: lobbies, join codes, and routing protocol messages onto the
// game engine (spec sections 5, 7). This module knows nothing about frame
// bytes (ws.ts) or HTTP (server.ts) — it deals only in parsed JSON messages
// and WsConnection-like objects, keeping the transport swappable (spec 3.2).

import { randomBytes, randomUUID } from 'node:crypto';
import { applyAction, createGame, defaultConfig } from '../src/index.ts';
import { log } from './log.ts';
import * as metrics from './metrics.ts';
import { scopedView } from './views.ts';
import type { Action, GameConfig, GameState } from '../src/index.ts';

/** The transport surface rooms.ts needs — WsConnection satisfies it. */
export interface ClientSocket {
  send(text: string): void;
  close(code?: number): void;
  on(event: 'message', fn: (text: string) => void): unknown;
  on(event: 'close', fn: () => void): unknown;
}

interface RoomPlayer {
  id: string; // engine player id: p1, p2, ...
  name: string;
  reconnectToken: string;
  socket: ClientSocket | null; // null = disconnected
}

/** What the current server timer is counting down to (sent with every state update). */
export interface Deadline {
  kind: 'turn' | 'respond';
  playerId: string;
  expiresAt: number; // epoch ms
}

interface Room {
  code: string;
  status: 'lobby' | 'playing' | 'ended';
  players: RoomPlayer[];
  hostId: string;
  state: GameState | null;
  seed?: number;
  // ---- Phase 3 robustness bookkeeping (all timers are server-side; the engine stays pure) ----
  /** One timer, two modes: Cownter auto-pass (spec 6.2 note) or turn auto-skip (Decision #14). */
  actionTimer: NodeJS.Timeout | null;
  deadline: Deadline | null;
  /** Whole-room inactivity: warning after N minutes, then a grace period (spec section 5). */
  inactivityTimer: NodeJS.Timeout | null;
  inactivityWarned: boolean;
  /** Set when the game ends / all sockets drop; the sweeper purges stale rooms (spec 7.4). */
  endedAt: number | null;
  emptySince: number | null;
}

interface ClientCtx {
  socket: ClientSocket;
  roomCode: string | null;
  playerId: string | null;
}

// Unambiguous alphabet for join codes (spec 7.4: no 0/O/1/I).
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export class RoomManager {
  private rooms = new Map<string, Room>();
  private config: GameConfig;
  private cfgOverride: Partial<GameConfig>;
  private sweeper: NodeJS.Timeout;

  /** `configOverride` lets tests shrink the timeouts; production passes nothing. */
  constructor(configOverride: Partial<GameConfig> = {}) {
    this.cfgOverride = configOverride;
    this.config = { ...defaultConfig, ...configOverride };
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref?.();
    // Gauges are callbacks: evaluated fresh at scrape time, not stored values.
    metrics.gauge('rooms_active', () => this.rooms.size);
    metrics.gauge('players_connected', () =>
      [...this.rooms.values()].reduce(
        (n, r) => n + r.players.filter((p) => p.socket !== null).length,
        0,
      ),
    );
  }

  /** Live room count — read by the /health endpoint (observation only). */
  getRoomCount(): number {
    return this.rooms.size;
  }

  /** Stops all timers so the process (or a test) can exit cleanly. */
  dispose(): void {
    clearInterval(this.sweeper);
    for (const room of this.rooms.values()) this.destroyRoom(room);
  }

  /** Wire up a fresh connection. */
  handleConnection(socket: ClientSocket): void {
    metrics.inc('ws_connections_opened_total');
    const ctx: ClientCtx = { socket, roomCode: null, playerId: null };
    socket.on('message', (text) => this.onMessage(ctx, text));
    socket.on('close', () => {
      metrics.inc('ws_connections_closed_total');
      this.onDisconnect(ctx);
    });
  }

  getRoom(code: string): Room | undefined {
    return this.rooms.get(code);
  }

  // ------------------------------------------------------------- messaging

  private onMessage(ctx: ClientCtx, text: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(text);
    } catch {
      return this.sendError(ctx, 'badMessage', 'Message was not valid JSON');
    }
    const type = typeof msg.type === 'string' ? msg.type : '';
    try {
      switch (type) {
        case 'createRoom':
          this.createRoom(ctx, msg);
          break;
        case 'joinRoom':
          this.joinRoom(ctx, msg);
          break;
        case 'startGame':
          this.startGame(ctx);
          break;
        case 'reconnect':
          this.reconnect(ctx, msg);
          break;
        case 'keepAlive':
          break; // pure activity ping; the reset below is the whole point
        case 'imBack':
          this.imBack(ctx);
          break;
        case 'drawCards':
        case 'playCard':
        case 'recycle':
        case 'herd':
        case 'passAction':
        case 'endTurn':
        case 'respondToPending':
          this.gameAction(ctx, type, msg);
          break;
        default:
          return this.sendError(ctx, 'badMessage', `Unknown message type: ${type}`);
      }
      // Any message from a seated player counts as human activity (spec section 5).
      const room = ctx.roomCode ? this.rooms.get(ctx.roomCode) : undefined;
      if (room) this.onActivity(room);
    } catch (e) {
      metrics.inc('server_errors_total');
      log.error('message_handler_error', {
        roomCode: ctx.roomCode,
        playerId: ctx.playerId,
        msgType: type,
        error: e instanceof Error ? e.message : String(e),
      });
      this.sendError(ctx, 'serverError', e instanceof Error ? e.message : 'Internal error');
    }
  }

  private send(socket: ClientSocket | null, payload: Record<string, unknown>): void {
    socket?.send(JSON.stringify(payload));
  }

  private sendError(ctx: ClientCtx, code: string, text: string): void {
    this.send(ctx.socket, { type: 'errorMessage', code, text });
  }

  // ----------------------------------------------------------------- lobby

  private createRoom(ctx: ClientCtx, msg: Record<string, unknown>): void {
    if (ctx.roomCode) return this.sendError(ctx, 'alreadyInRoom', 'You are already in a room');
    const name = cleanName(msg.name);
    if (!name) return this.sendError(ctx, 'badName', 'Please provide a name');

    const code = this.generateCode();
    const player: RoomPlayer = {
      id: 'p1',
      name,
      reconnectToken: randomUUID(),
      socket: ctx.socket,
    };
    const room: Room = {
      code,
      status: 'lobby',
      players: [player],
      hostId: player.id,
      state: null,
      ...(typeof msg.seed === 'number' ? { seed: msg.seed } : {}),
      actionTimer: null,
      deadline: null,
      inactivityTimer: null,
      inactivityWarned: false,
      endedAt: null,
      emptySince: null,
    };
    this.rooms.set(code, room);
    metrics.inc('rooms_created_total');
    ctx.roomCode = code;
    ctx.playerId = player.id;

    this.send(ctx.socket, {
      type: 'roomCreated',
      roomCode: code,
      playerId: player.id,
      reconnectToken: player.reconnectToken,
    });
    this.broadcastLobby(room);
  }

  private joinRoom(ctx: ClientCtx, msg: Record<string, unknown>): void {
    if (ctx.roomCode) return this.sendError(ctx, 'alreadyInRoom', 'You are already in a room');
    const name = cleanName(msg.name);
    if (!name) return this.sendError(ctx, 'badName', 'Please provide a name');
    const code = typeof msg.code === 'string' ? msg.code.trim().toUpperCase() : '';
    const room = this.rooms.get(code);
    if (!room) return this.sendError(ctx, 'noSuchRoom', 'No room with that code');
    if (room.status === 'playing') {
      // Decision #17: entering the code with the name of a DISCONNECTED seat
      // reclaims that seat (friends-scale trust). A connected seat can only
      // be taken over with the reconnect token.
      const seat = room.players.find(
        (p) => p.socket === null && p.name.toLowerCase() === name.toLowerCase(),
      );
      if (seat) return this.attachSeat(ctx, room, seat);
      return this.sendError(
        ctx,
        'alreadyStarted',
        'That game is in progress. To rejoin it, enter the exact name you were playing under.',
      );
    }
    if (room.status !== 'lobby') return this.sendError(ctx, 'alreadyStarted', 'That game has already ended');
    if (room.players.length >= this.config.maxPlayers) {
      return this.sendError(ctx, 'roomFull', 'That room is full');
    }
    // Names are unique per room — name-based rejoin (Decision #17) depends on
    // it, and two seats with one name confuses the whole table anyway.
    if (room.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      return this.sendError(ctx, 'nameTaken', 'Someone in that room already has that name — pick another');
    }

    const player: RoomPlayer = {
      id: `p${room.players.length + 1}`,
      name,
      reconnectToken: randomUUID(),
      socket: ctx.socket,
    };
    room.players.push(player);
    ctx.roomCode = code;
    ctx.playerId = player.id;

    this.send(ctx.socket, {
      type: 'roomJoined',
      roomCode: code,
      playerId: player.id,
      reconnectToken: player.reconnectToken,
    });
    this.broadcastLobby(room);
  }

  private startGame(ctx: ClientCtx): void {
    const room = this.roomOf(ctx);
    if (!room) return;
    if (ctx.playerId !== room.hostId) {
      return this.sendError(ctx, 'notHost', 'Only the host can start the game');
    }
    if (room.status !== 'lobby') return this.sendError(ctx, 'alreadyStarted', 'Game already started');
    if (room.players.length < this.config.minPlayers) {
      return this.sendError(ctx, 'notEnoughPlayers', `Need at least ${this.config.minPlayers} players`);
    }

    room.state = createGame({
      playerNames: room.players.map((p) => p.name),
      ...(room.seed !== undefined ? { seed: room.seed } : {}),
      config: this.cfgOverride,
    });
    room.status = 'playing';
    this.armActionTimer(room);
    this.broadcastGameState(room);
  }

  // -------------------------------------------------- reconnection (Phase 3)

  /** reconnect(roomCode, reconnectToken) — spec 7.1. Re-attaches the socket and resends state. */
  private reconnect(ctx: ClientCtx, msg: Record<string, unknown>): void {
    if (ctx.roomCode) return this.sendError(ctx, 'alreadyInRoom', 'You are already in a room');
    const code = typeof msg.roomCode === 'string' ? msg.roomCode.trim().toUpperCase() : '';
    const token = typeof msg.reconnectToken === 'string' ? msg.reconnectToken : '';
    const room = this.rooms.get(code);
    const player = room?.players.find((p) => p.reconnectToken === token);
    if (!room || !player || room.status === 'ended') {
      return this.sendError(ctx, 'reconnectFailed', 'That game is no longer available');
    }
    this.attachSeat(ctx, room, player);
  }

  /**
   * Puts a socket into a seat — shared by token reconnects (spec 7.1) and
   * name-based rejoins (Decision #17) — and rebroadcasts state.
   */
  private attachSeat(ctx: ClientCtx, room: Room, player: RoomPlayer): void {
    // A ghost of the old connection may still be around: tell it to stand
    // down (so its auto-reconnect loop stops), then replace it.
    if (player.socket) {
      this.send(player.socket, { type: 'seatTakenOver' });
      player.socket.close();
    }
    player.socket = ctx.socket;
    ctx.roomCode = room.code;
    ctx.playerId = player.id;
    room.emptySince = null;

    this.send(ctx.socket, {
      type: 'reconnected',
      roomCode: room.code,
      playerId: player.id,
      reconnectToken: player.reconnectToken,
      roomStatus: room.status,
    });
    if (room.status === 'lobby') {
      this.broadcastLobby(room);
    } else {
      // Coming back proves presence: reactivate if they'd gone AFK (Decision #15).
      const enginePlayer = room.state?.players.find((p) => p.id === player.id);
      if (enginePlayer?.inactive) {
        this.applyRoomAction(room, { type: 'reactivate', playerId: player.id });
      } else {
        this.broadcastGameState(room); // everyone sees them reconnect
      }
    }
  }

  /** "I'm back!" from a connected-but-inactive player (Decision #15). */
  private imBack(ctx: ClientCtx): void {
    const room = this.roomOf(ctx);
    if (!room) return;
    if (room.status !== 'playing' || !room.state) return;
    this.applyRoomAction(room, { type: 'reactivate', playerId: ctx.playerId! });
  }

  // ---------------------------------------------------------- game actions

  /** Maps a spec 7.1 protocol message onto an engine Action. */
  private toEngineAction(type: string, playerId: string, msg: Record<string, unknown>): Action {
    switch (type) {
      case 'drawCards':
        return {
          type: 'draw',
          playerId,
          picks: Array.isArray(msg.picks) ? msg.picks : [],
        };
      case 'playCard':
        return {
          type: 'playCard',
          playerId,
          instanceId: String(msg.cardInstanceId ?? ''),
          ...(msg.params && typeof msg.params === 'object' ? { params: msg.params as object } : {}),
        } as Action;
      case 'recycle':
        return { type: 'recycle', playerId, instanceId: String(msg.cardInstanceId ?? '') };
      case 'herd':
        return { type: 'herd', playerId };
      case 'passAction':
        return { type: 'pass', playerId };
      case 'endTurn':
        return { type: 'endTurn', playerId };
      case 'respondToPending':
        return {
          type: 'respond',
          playerId,
          response: msg.response === 'cownter' ? 'cownter' : 'pass',
          ...(msg.cardInstanceId ? { instanceId: String(msg.cardInstanceId) } : {}),
        };
      default:
        throw new Error(`Unmapped action type: ${type}`);
    }
  }

  private gameAction(ctx: ClientCtx, type: string, msg: Record<string, unknown>): void {
    const room = this.roomOf(ctx);
    if (!room) return;
    if (room.status !== 'playing' || !room.state) {
      return this.sendError(ctx, 'notPlaying', 'The game is not in progress');
    }
    const action = this.toEngineAction(type, ctx.playerId!, msg);
    const error = this.applyRoomAction(room, action);
    if (error) this.sendError(ctx, 'invalidAction', error);
  }

  /**
   * The one path through which the engine is ever driven — used by client
   * messages and server timers alike. Applies the action, re-arms the timer,
   * and broadcasts the results. Returns the engine's error, if any.
   */
  private applyRoomAction(room: Room, action: Action): string | null {
    if (!room.state) return 'No game in progress';
    const prevStackDepth = room.state.pending?.stack.length ?? 0;
    const result = applyAction(room.state, action);
    if (result.error) return result.error;

    room.state = result.state;
    this.armActionTimer(room);
    this.broadcastGameState(room);

    // pendingResponseOpened: fired when an event card opens the response
    // window, or a Cownter re-opens it (spec 7.2). The stack growing is
    // exactly those two cases — a plain pass never re-fires it.
    if (room.state.pending && room.state.pending.stack.length > prevStackDepth) {
      this.broadcast(room, {
        type: 'pendingResponseOpened',
        toRespond: [...room.state.pending.toRespond],
      });
    }

    if (room.state.status === 'ended') {
      room.status = 'ended';
      room.endedAt = Date.now();
      metrics.inc('rooms_ended_total');
      this.clearTimers(room);
      this.broadcast(room, { type: 'gameOver', winnerId: room.state.winnerId });
    }
    return null;
  }

  // ------------------------------------------- server timers (engine stays pure)

  /**
   * One timer, two modes (both config.json values):
   *  - a response window is open -> auto-pass toRespond[0] after
   *    cownterResponseTimeoutSeconds (spec 6.2 safety net);
   *  - otherwise -> auto-skip the current player's turn after
   *    turnInactivityTimeoutSeconds (Decision #14).
   */
  private armActionTimer(room: Room): void {
    if (room.actionTimer) clearTimeout(room.actionTimer);
    room.actionTimer = null;
    room.deadline = null;
    const s = room.state;
    if (room.status !== 'playing' || !s || s.status === 'ended') return;

    const [kind, playerId, seconds]: ['turn' | 'respond', string, number] = s.pending
      ? ['respond', s.pending.toRespond[0]!, this.config.cownterResponseTimeoutSeconds]
      : ['turn', s.turn.currentPlayerId, this.config.turnInactivityTimeoutSeconds];
    const ms = seconds * 1000;
    room.deadline = { kind, playerId, expiresAt: Date.now() + ms };
    room.actionTimer = setTimeout(() => this.onActionTimeout(room), ms);
    room.actionTimer.unref?.();
  }

  private onActionTimeout(room: Room): void {
    if (!this.rooms.has(room.code) || room.status !== 'playing' || !room.state) return;
    const s = room.state;
    // Same branch that picks the action picks the counter: auto-pass/auto-skip
    // rates are a proxy for players dropping or stalling mid-game.
    metrics.inc(s.pending ? 'cownter_auto_pass_total' : 'turn_auto_skip_total');
    const action: Action = s.pending
      ? { type: 'respond', playerId: s.pending.toRespond[0]!, response: 'pass' }
      : { type: 'skipTurn', playerId: s.turn.currentPlayerId };
    this.applyRoomAction(room, action); // re-arms the timer itself
  }

  /**
   * Whole-room inactivity (spec section 5): after roomInactivityWarningMinutes
   * with no human messages, warn everyone; if no one acts within
   * roomInactivityGraceMinutes, the room is ended.
   */
  private armInactivityTimer(room: Room): void {
    if (room.inactivityTimer) clearTimeout(room.inactivityTimer);
    room.inactivityTimer = null;
    if (room.status !== 'playing') return;
    room.inactivityTimer = setTimeout(() => {
      room.inactivityWarned = true;
      const graceSeconds = Math.round(this.config.roomInactivityGraceMinutes * 60);
      this.broadcast(room, { type: 'inactivityWarning', graceSeconds });
      room.inactivityTimer = setTimeout(
        () => this.endRoomForInactivity(room),
        this.config.roomInactivityGraceMinutes * 60_000,
      );
      room.inactivityTimer.unref?.();
    }, this.config.roomInactivityWarningMinutes * 60_000);
    room.inactivityTimer.unref?.();
  }

  /** Any human message from a seated player resets the room inactivity clock. */
  private onActivity(room: Room): void {
    if (room.status !== 'playing') return;
    if (room.inactivityWarned) {
      room.inactivityWarned = false;
      this.broadcast(room, { type: 'inactivityCleared' });
    }
    this.armInactivityTimer(room);
  }

  private endRoomForInactivity(room: Room): void {
    if (!this.rooms.has(room.code) || room.status !== 'playing') return;
    room.status = 'ended';
    room.endedAt = Date.now();
    metrics.inc('rooms_ended_total');
    log.info('room_timed_out', { roomCode: room.code });
    this.clearTimers(room);
    this.broadcast(room, { type: 'roomTimedOut' });
  }

  // -------------------------------------------------- room cleanup (spec 7.4)

  /** Purges rooms that ended, or sat with nobody connected, roomCleanupMinutes ago. */
  sweep(now = Date.now()): void {
    const maxAge = this.config.roomCleanupMinutes * 60_000;
    for (const room of [...this.rooms.values()]) {
      const stale =
        (room.endedAt !== null && now - room.endedAt >= maxAge) ||
        (room.emptySince !== null && now - room.emptySince >= maxAge);
      if (stale) {
        metrics.inc('rooms_cleaned_total');
        this.destroyRoom(room);
      }
    }
  }

  private destroyRoom(room: Room): void {
    this.clearTimers(room);
    for (const p of room.players) p.socket?.close();
    this.rooms.delete(room.code);
  }

  private clearTimers(room: Room): void {
    if (room.actionTimer) clearTimeout(room.actionTimer);
    if (room.inactivityTimer) clearTimeout(room.inactivityTimer);
    room.actionTimer = null;
    room.inactivityTimer = null;
    room.deadline = null;
  }

  // ------------------------------------------------------------ broadcasts

  private broadcastLobby(room: Room): void {
    this.broadcast(room, {
      type: 'roomUpdate',
      roomCode: room.code,
      status: room.status,
      hostId: room.hostId,
      players: room.players.map((p) => ({
        id: p.id,
        name: p.name,
        connected: p.socket !== null,
      })),
      minPlayers: this.config.minPlayers,
      maxPlayers: this.config.maxPlayers,
    });
  }

  /** Sends each player their own scoped view (spec 7.3). */
  private broadcastGameState(room: Room): void {
    if (!room.state) return;
    const connected = new Set(room.players.filter((p) => p.socket).map((p) => p.id));
    for (const p of room.players) {
      if (!p.socket) continue;
      this.send(p.socket, {
        type: 'gameStateUpdate',
        state: scopedView(room.state, p.id, connected),
        deadline: room.deadline,
      });
    }
  }

  private broadcast(room: Room, payload: Record<string, unknown>): void {
    for (const p of room.players) this.send(p.socket, payload);
  }

  // -------------------------------------------------------------- plumbing

  private roomOf(ctx: ClientCtx): Room | null {
    const room = ctx.roomCode ? this.rooms.get(ctx.roomCode) : undefined;
    if (!room || !ctx.playerId) {
      this.sendError(ctx, 'notInRoom', 'You are not in a room');
      return null;
    }
    return room;
  }

  private onDisconnect(ctx: ClientCtx): void {
    const room = ctx.roomCode ? this.rooms.get(ctx.roomCode) : undefined;
    if (!room || !ctx.playerId) return;
    const player = room.players.find((p) => p.id === ctx.playerId);
    // If the seat has already been taken over by a newer socket (reconnect
    // replaced a ghost connection), this close event is stale — ignore it.
    if (!player || player.socket !== ctx.socket) return;
    player.socket = null;

    if (room.status === 'lobby') {
      // In the lobby, a leaver is simply removed; ids are reassigned so the
      // engine still sees p1..pn in seat order when the game starts.
      room.players = room.players.filter((p) => p.id !== ctx.playerId);
      if (room.players.length === 0) {
        this.rooms.delete(room.code);
        return;
      }
      room.players.forEach((p, i) => (p.id = `p${i + 1}`));
      room.hostId = room.players[0]!.id;
      this.broadcastLobby(room);
    } else {
      // Mid-game: mark disconnected and tell everyone; they can come back via
      // the reconnect message. If the room is now empty, start the purge clock.
      if (room.players.every((p) => p.socket === null)) room.emptySince = Date.now();
      this.broadcastGameState(room);
    }
  }

  private generateCode(): string {
    for (;;) {
      let code = '';
      const bytes = randomBytes(this.config.roomCodeLength);
      for (let i = 0; i < this.config.roomCodeLength; i++) {
        code += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
      }
      if (!this.rooms.has(code)) return code;
    }
  }
}

function cleanName(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().slice(0, 24) : '';
}
