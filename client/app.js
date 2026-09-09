// Cows To The Moon — Phase 2 client.
//
// React via CDN (no build step yet; Vite/JSX arrives with the polish phases).
// Structure follows spec 3.3: ONE store at the top of the app, fed exclusively
// by server messages; components render whatever the server says is true and
// send intent back over the socket. Local useState is only used for disposable
// UI state (draw picks, an open target picker).
//
// Phase 2 is deliberately unstyled: bare lists and default buttons only.

import { createElement, useEffect, useReducer, useRef, useState } from 'https://esm.sh/react@18.3.1';
import { createRoot } from 'https://esm.sh/react-dom@18.3.1/client';
import htm from 'https://esm.sh/htm@3.1.1';

const html = htm.bind(createElement);

// ------------------------------------------------------------------- socket

let ws = null;
let dispatchRef = () => {};

// Reconnect credentials survive a refresh (sessionStorage is per-tab, so
// multiple playtest tabs in one browser don't clobber each other).
const CREDS_KEY = 'cttm-reconnect';
const saveCreds = (c) => sessionStorage.setItem(CREDS_KEY, JSON.stringify(c));
const clearCreds = () => sessionStorage.removeItem(CREDS_KEY);
function loadCreds() {
  try {
    return JSON.parse(sessionStorage.getItem(CREDS_KEY));
  } catch {
    return null;
  }
}

// Seats also go to localStorage (keyed per room+player, so playtest tabs
// coexist), surviving a CLOSED tab: the home screen offers "Rejoin" buttons
// for any seat less than a day old (Decision #17).
const SEATS_KEY = 'cttm-seats';
const SEAT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
function loadSeats() {
  try {
    const seats = JSON.parse(localStorage.getItem(SEATS_KEY)) ?? {};
    let changed = false;
    for (const k of Object.keys(seats)) {
      if (Date.now() - (seats[k].savedAt ?? 0) > SEAT_MAX_AGE_MS) {
        delete seats[k];
        changed = true;
      }
    }
    if (changed) localStorage.setItem(SEATS_KEY, JSON.stringify(seats));
    return seats;
  } catch {
    return {};
  }
}
function saveSeat(seat) {
  const seats = loadSeats();
  const key = `${seat.roomCode}:${seat.playerId}`;
  seats[key] = { ...seats[key], ...seat, savedAt: Date.now() };
  localStorage.setItem(SEATS_KEY, JSON.stringify(seats));
}
function removeSeats(pred) {
  const seats = loadSeats();
  for (const k of Object.keys(seats)) if (pred(seats[k])) delete seats[k];
  localStorage.setItem(SEATS_KEY, JSON.stringify(seats));
}

let lastEnteredName = ''; // what the user typed on the home screen
let lastTriedToken = null; // which token the latest reconnect attempt used
let currentRoomCode = null;

function sendReconnect(creds) {
  lastTriedToken = creds.reconnectToken;
  send({ type: 'reconnect', roomCode: creds.roomCode, reconnectToken: creds.reconnectToken });
}

// While this tab holds a seat, it heartbeats into localStorage so OTHER tabs
// in the same browser neither offer a Rejoin button for it nor auto-grab it —
// without this, two tabs play tug-of-war over one seat. A refresh or closed
// tab clears the heartbeat (pagehide), so legitimate rejoins are unaffected;
// a crashed tab's heartbeat simply goes stale after a few seconds.
const heartKey = (roomCode, playerId) => `cttm-held:${roomCode}:${playerId}`;
const HEARTBEAT_MS = 3000;
const HEARTBEAT_FRESH_MS = 8000;
let heartbeatTimer = null;
let heartbeatKey = null;

function startHeartbeat(roomCode, playerId) {
  stopHeartbeat();
  heartbeatKey = heartKey(roomCode, playerId);
  const beat = () => localStorage.setItem(heartbeatKey, String(Date.now()));
  beat();
  heartbeatTimer = setInterval(beat, HEARTBEAT_MS);
}
function stopHeartbeat() {
  if (heartbeatKey) localStorage.removeItem(heartbeatKey);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  heartbeatKey = null;
}
function seatHeldElsewhere(seat) {
  const key = heartKey(seat.roomCode, seat.playerId);
  if (key === heartbeatKey) return false; // held by THIS tab
  const at = Number(localStorage.getItem(key) ?? 0);
  return Date.now() - at < HEARTBEAT_FRESH_MS;
}
window.addEventListener('pagehide', stopHeartbeat);

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}`);
  ws.onopen = () => {
    dispatchRef({ kind: 'socketOpen' });
    // A refresh or dropped connection: pick the old seat back up (spec 7.1) —
    // unless another tab in this browser is actively holding the seat.
    const creds = loadCreds();
    if (creds && !seatHeldElsewhere(creds)) sendReconnect(creds);
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    // Credential bookkeeping lives here so the reducer stays pure.
    if (msg.type === 'roomCreated' || msg.type === 'roomJoined' || msg.type === 'reconnected') {
      saveCreds({ roomCode: msg.roomCode, playerId: msg.playerId, reconnectToken: msg.reconnectToken });
      saveSeat({
        roomCode: msg.roomCode,
        playerId: msg.playerId,
        reconnectToken: msg.reconnectToken,
        ...(lastEnteredName ? { name: lastEnteredName } : {}),
      });
      currentRoomCode = msg.roomCode;
      startHeartbeat(msg.roomCode, msg.playerId);
    }
    if (msg.type === 'roomTimedOut' || msg.type === 'gameOver') {
      clearCreds();
      stopHeartbeat();
      removeSeats((s) => s.roomCode === currentRoomCode); // this game is over
    }
    if (msg.type === 'seatTakenOver') {
      clearCreds(); // another window owns this seat now: stop auto-reconnecting
      stopHeartbeat();
    }
    if (msg.type === 'errorMessage' && msg.code === 'reconnectFailed') {
      clearCreds();
      stopHeartbeat();
      removeSeats((s) => s.reconnectToken === lastTriedToken); // stale seat
    }
    dispatchRef({ kind: 'server', msg });
  };
  // Unintentional drop: tell the user, then quietly retry until the server is back.
  ws.onclose = () => {
    dispatchRef({ kind: 'socketClosed' });
    setTimeout(connect, 2000);
  };
}

/** Back to the main menu on a fresh connection (the old room is left behind). */
function resetToMenu() {
  clearCreds();
  stopHeartbeat();
  if (ws) {
    ws.onclose = null; // intentional close: don't show "connection lost"
    ws.onmessage = null;
    ws.close();
  }
  dispatchRef({ kind: 'reset' });
  connect();
}

function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// -------------------------------------------------------------------- store

const initial = {
  screen: 'home', // home | lobby | game
  connected: false,
  you: null,
  roomCode: null,
  reconnectToken: null,
  lobby: null, // roomUpdate payload
  game: null, // scoped GameView from gameStateUpdate
  deadline: null, // { kind: 'turn'|'respond', playerId, expiresAt } from the server
  inactivityWarning: null, // { graceSeconds } while the room timeout warning is up
  winnerId: null,
  error: null,
};

function reducer(state, action) {
  if (action.kind === 'reset') return { ...initial };
  if (action.kind === 'socketOpen') return { ...state, connected: true };
  if (action.kind === 'socketClosed') return { ...state, connected: false, error: 'Connection lost — reconnecting…' };
  if (action.kind === 'dismissError') return { ...state, error: null };
  if (action.kind !== 'server') return state;

  const m = action.msg;
  switch (m.type) {
    case 'roomCreated':
    case 'roomJoined':
      return {
        ...state,
        screen: 'lobby',
        you: m.playerId,
        roomCode: m.roomCode,
        reconnectToken: m.reconnectToken,
        error: null,
      };
    case 'reconnected':
      // The server follows up with roomUpdate / gameStateUpdate carrying the details.
      return {
        ...state,
        screen: m.roomStatus === 'lobby' ? 'lobby' : 'game',
        you: m.playerId,
        roomCode: m.roomCode,
        reconnectToken: m.reconnectToken,
        error: null,
      };
    case 'roomUpdate':
      return { ...state, lobby: m, screen: state.screen === 'game' ? 'game' : 'lobby' };
    case 'gameStateUpdate':
      return { ...state, game: m.state, deadline: m.deadline ?? null, screen: 'game', error: null };
    case 'pendingResponseOpened':
      return state; // the pending window is already inside game.pending
    case 'gameOver':
      return { ...state, winnerId: m.winnerId };
    case 'inactivityWarning':
      return { ...state, inactivityWarning: { graceSeconds: m.graceSeconds } };
    case 'inactivityCleared':
      return { ...state, inactivityWarning: null };
    case 'roomTimedOut':
      return { ...initial, connected: state.connected, error: 'The game timed out from inactivity.' };
    case 'seatTakenOver':
      return { ...initial, connected: state.connected, error: 'This seat was picked up in another window.' };
    case 'errorMessage':
      if (m.code === 'reconnectFailed') {
        return { ...initial, connected: state.connected, error: 'That game is no longer available.' };
      }
      return { ...state, error: m.text };
    default:
      return state;
  }
}

// --------------------------------------------------------------- components
//
// Phase 4 note: everything below is PRESENTATION. Handlers, hooks, the socket
// layer and the reducer are unchanged from Phase 2 — only markup, classes, and
// human-readable log formatting were added to lay the component tree out.

// ---------------------------------------------------------------------- art
// Card + board art is loaded from art.json (spec 4.2): a cardId -> asset map,
// plus board art (deck back / moon / farm). Anything without an entry falls
// back to the plain-text card, so the game stays fully playable without art.
let ART = { cards: {}, board: {} };
const cardArt = (card) => (card && ART.cards[card.cardId]) || null;
const boardArt = (key) => ART.board[key] || null;
/** style object that paints an image as a cover background (or undefined). */
const bgImage = (url, position = 'center') =>
  url ? { backgroundImage: `url("${url}")`, backgroundSize: 'cover', backgroundPosition: position } : undefined;

/** True if a pointer event landed outside the given area element's box. Used to
 *  snap a dragged piece/token back home when it's dropped out of its area. */
function outsideArea(areaRef, ev) {
  const rect = areaRef?.current?.getBoundingClientRect?.();
  if (!rect || !ev || !Number.isFinite(ev.clientX)) return false;
  return (
    ev.clientX < rect.left || ev.clientX > rect.right || ev.clientY < rect.top || ev.clientY > rect.bottom
  );
}

/** A Cownter is identified by its effect, not a separate type (spec 4.1). */
const isCownter = (card) => card.effect === 'cancelEvent';

/** Card flavor for styling/labels — Cownter is identified by effect, per spec 4.1. */
function cardKind(card) {
  if (isCownter(card)) return 'cownter';
  if (card.type === 'rocketPiece') return 'piece';
  if (card.type === 'launch') return 'launch';
  return 'event';
}

function App() {
  const [state, dispatch] = useReducer(reducer, initial);
  useEffect(() => {
    dispatchRef = dispatch;
    connect();
  }, []);

  return html`<div className=${`app app--${state.screen}`}>
    <h1>Cows To The Mooooooooon!</h1>
    ${state.error &&
    html`<p role="alert">
      <b>${state.error}</b>
      <button onClick=${() => dispatch({ kind: 'dismissError' })}>ok</button>
    </p>`}
    ${state.inactivityWarning &&
    html`<p role="alert">
      <b>Anyone there? The game times out in ${state.inactivityWarning.graceSeconds}s of inactivity.</b>
      <button onClick=${() => send({ type: 'keepAlive' })}>We're still here!</button>
    </p>`}
    ${state.screen === 'home' && html`<${Home} connected=${state.connected} />`}
    ${state.screen === 'lobby' && html`<${Lobby} state=${state} />`}
    ${state.screen === 'game' && html`<${Game} state=${state} deadline=${state.deadline} />`}
  </div>`;
}

function Home({ connected }) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  // Hide seats being actively played in another tab of this browser.
  const seats = Object.values(loadSeats()).filter((s) => !seatHeldElsewhere(s));
  const create = () => {
    lastEnteredName = name;
    send({ type: 'createRoom', name });
  };
  const join = () => {
    lastEnteredName = name;
    send({ type: 'joinRoom', name, code });
  };
  return html`<div className="home">
    <p className="status-line">${connected ? 'Connected' : 'Connecting…'}</p>
    ${seats.length > 0 &&
    html`<div className="rejoin-box">
      <b>Rejoin a game</b>
      ${seats.map(
        (s) => html`<button key=${`${s.roomCode}:${s.playerId}`} onClick=${() => sendReconnect(s)}>
          Rejoin ${s.roomCode}${s.name ? ` as ${s.name}` : ''}
        </button>`,
      )}
    </div>`}
    <label>Your name<input value=${name} onInput=${(e) => setName(e.target.value)} placeholder="e.g. Bessie" /></label>
    <button className="primary-cta" disabled=${!name} onClick=${create}>Create a game</button>
    <div className="divider"></div>
    <label>Join code<input value=${code} onInput=${(e) => setCode(e.target.value.toUpperCase())} placeholder="e.g. 7FQK2" /></label>
    <button className="primary-cta" disabled=${!name || !code} onClick=${join}>Join game</button>
    <p><small>Rejoining a running game? Enter the code with the same name you played under, or use a Rejoin button above.</small></p>
  </div>`;
}

function Lobby({ state }) {
  const lobby = state.lobby;
  if (!lobby) return html`<p className="waiting">Waiting for room info…</p>`;
  const isHost = state.you === lobby.hostId;
  const canStart = lobby.players.length >= lobby.minPlayers;
  return html`<div className="lobby">
    <h2 className="code-chip">
      Lobby — <code>${lobby.roomCode}</code>
      <button onClick=${() => navigator.clipboard?.writeText(lobby.roomCode)}>copy</button>
    </h2>
    <ul className="player-list">
      ${lobby.players.map(
        (p) => html`<li key=${p.id}>
          ${p.name}
          ${p.id === lobby.hostId ? html`<span className="tag tag-host">host</span>` : ''}
          ${p.id === state.you ? html`<span className="tag tag-you">you</span>` : ''}
        </li>`,
      )}
    </ul>
    ${isHost
      ? html`<button className="primary-cta" disabled=${!canStart} onClick=${() => send({ type: 'startGame' })}>
          Start game (${lobby.players.length}/${lobby.maxPlayers})
        </button>`
      : html`<p className="waiting">Waiting for the host to start…</p>`}
  </div>`;
}

// ------------------------------------------------------------------ in-game

/** Ticking "auto-skip / auto-pass in Ns" line for the server's action timer. */
function Countdown({ deadline, g }) {
  const [, forceTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [deadline?.expiresAt]);
  if (!deadline || g.status !== 'playing') return null;
  const secs = Math.max(0, Math.ceil((deadline.expiresAt - Date.now()) / 1000));
  const what = deadline.kind === 'respond' ? 'auto-passes' : 'turn auto-skips';
  return html`<span className="countdown">${nameOf(g, deadline.playerId)} ${what} in ${secs}s</span>`;
}

/** Cards that pick a specific spot by clicking a highlighted zone on the table
 *  — a farm/rocket cow or piece (moveCowToMoon, stealRocketPiece), or a whole
 *  player via their floating hand (swapHands, moveCowMoonToFarm,
 *  returnRocketCowsToFarm — see FloatingHand and PLAYER_TARGET_EFFECTS). */
const ZONE_EFFECTS = ['moveCowToMoon', 'stealRocketPiece', 'swapHands', 'moveCowMoonToFarm', 'returnRocketCowsToFarm'];
/** The subset of ZONE_EFFECTS that target a whole PLAYER (via their floating
 *  hand or, for yourself, your own hand-rail tab) rather than a farm/rocket
 *  spot. `eligible` mirrors each effect's server-side validate() in
 *  effects.ts, so an ineligible player never lights up as clickable. */
const PLAYER_TARGET_EFFECTS = {
  swapHands: { eligible: () => true, selfEligible: false }, // "must target another player"
  moveCowMoonToFarm: { eligible: (p) => p.moon > 0, selfEligible: true },
  returnRocketCowsToFarm: { eligible: (p) => p.rocket.cows > 0, selfEligible: true },
};
function playerTargetEligible(effect, p, isSelf) {
  const rule = PLAYER_TARGET_EFFECTS[effect];
  if (!rule || p.inactive) return false;
  if (isSelf && !rule.selfEligible) return false;
  return rule.eligible(p);
}

// ------------------------------------------------------- 3D table camera ---
// Presentation-only camera state for the round table (see the Table component
// and the scene block in styles.css). These mirror --camera-* / --disc-* in
// styles.css's :root; CAMERA_DIST in particular MUST match --camera-dist or
// the zoom maths below lands at the wrong scale.
const CAMERA_PITCH_DEFAULT = 48; // deg of tilt: "sitting at the table"
// Per-frame fraction of the remaining distance the camera closes. Higher is
// snappier; this lands a little under a fifth of a second to settle at 60fps.
const CAMERA_SMOOTHING = 0.18;
// Zoom past this and the table settles onto the nearest player's seat.
const SNAP_ZOOM = 0.8;
// The hand rail peeks 100px up from the bottom of the window, and slides up to
// roughly 200px when hovered (see .hand-rail). Zoomed in on a play area the
// scene is lifted by this fraction of the viewport height so the area sits
// clear of the rail even when it is open. Focused on the middle of the table
// there is nothing to clear, so it does not apply there.
const PLAY_AREA_LIFT_FRACTION = 0.05;
const ZOOM_MIN = 0.3;
const ZOOM_MAX = 1.6;
const ZOOM_STEP = 0.12;
const ZOOM_DEFAULT = 0.5; // frames the whole table at a typical window size
const CAMERA_DIST = 1500; // px; must equal --camera-dist in styles.css
const SEAT_RADIUS = 620; // px; must equal --seat-radius in styles.css
// Zoomed in on the shared hub, the look-at point is nudged this many px
// toward the rocket store (up from the moon's centre, in the hub's own
// upright layout) so zooming closes in on the gap BETWEEN the store and the
// moon rather than on the moon alone — landing on the moon cut the top of
// the store off the top of the screen. Derived from styles.css's layout
// constants (~half the distance between the store's centre and the moon's
// centre: --moon-size 190px, a store card at --card-w 104px tall ~146px
// plus its label and the column gaps); re-tune if those change a lot.
const HUB_FOCUS_LIFT = 100;
// A press that moves less than this before release is a CLICK (pick a zoom
// target), not a table-spin drag.
const ZOOM_TARGET_CLICK_THRESHOLD = 6;
// Anything here handles its own pointer input, so a press on it must NOT also
// start turning the table. A press on anything else the table contains — bare
// felt, the empty part of a play area, a launch pad with no rocket on it yet —
// turns the table. This replaces an earlier "the press must land on the disc
// itself" rule, which made the play areas dead space you could not grab.
const NOT_A_TABLE_GRAB = 'button, a, input, .farm, .pad-card, .cow-token, .rocket-cows, .targetable';
// Zooming in closes in on the PLAY AREA at the near edge rather than the
// middle of the table: past the default zoom, the table is progressively
// shifted so the near seat sits under the camera instead of the moon.
// 0 at the default zoom (whole table framed) -> 1 at full zoom.
const FOCUS_AT_FULL_ZOOM = 1; // land the play area dead centre, not near it
// The focus deliberately ramps in FASTER than the zoom: reaching the play area
// only at maximum zoom would leave it drifting off the edge of the frame
// through the whole middle of the range. At this rate the camera is fully on
// the play area by roughly half zoom, and the rest of the range just closes in
// on it — which is what keeps the play area visible at every zoom level.
const FOCUS_RAMP = 1.9;
// Zoomed out, the whole disc is framed and gets nudged up in SCREEN space so
// the near rim clears the hand rail; zoomed in, the focus point is already the
// play area so the nudge relaxes to nothing. A fraction of the viewport's
// height, so it holds at any window size.
const FRAME_LIFT_FRACTION = 0.06;
const zoomProgress = (zoom) => clamp((zoom - ZOOM_DEFAULT) / (ZOOM_MAX - ZOOM_DEFAULT), 0, 1);
const focusAmount = (zoom) => clamp(zoomProgress(zoom) * FOCUS_RAMP, 0, 1);

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
// An element at translateZ(d) under perspective P renders at scale P/(P-d),
// so to hit a target scale (zoom) we push the camera to d = P(1 - 1/zoom).
const zoomToZ = (zoom) => CAMERA_DIST * (1 - 1 / zoom);

function Game({ state, deadline }) {
  // Hooks first (before any early return) so hook order is stable.
  const [confirm, setConfirm] = useState(null); // { card, message, blocking }
  const [zone, setZone] = useState(null); // zone-select card (click a spot on the table)
  const [zoom, setZoom] = useState(null); // a card being read big (rendered outside the hand rail)

  const g = state.game;
  if (!g) return html`<p className="waiting">Waiting for game state…</p>`;
  const you = g.players.find((p) => p.id === g.you);
  const myTurn = g.turn.currentPlayerId === g.you && g.status === 'playing';
  const myActionPhase = !g.pending && myTurn && g.turn.phase === 'action' && !you.inactive;
  const canAct = myActionPhase && g.turn.actionsRemaining > 0; // actions still left this turn
  const winner = g.winnerId && g.players.find((p) => p.id === g.winnerId);

  const route = (card) => {
    if (ZONE_EFFECTS.includes(card.effect)) setZone(card);
    else send({ type: 'playCard', cardInstanceId: card.instanceId });
  };
  const onPlay = (card) => {
    if (!myActionPhase || g.turn.actionsRemaining < 1) return;
    const chk = playCheck(you, card);
    if (chk) setConfirm({ card, ...chk });
    else route(card);
  };
  const zonePick = (params) => {
    if (zone) send({ type: 'playCard', cardInstanceId: zone.instanceId, params });
    setZone(null);
  };
  // A player-targeting card (Wind/Space Cowboy/Cow Wrangler) is aimed at an
  // opponent by clicking their floating hand (see FloatingHand); the two of
  // those that allow targeting YOURSELF (Decisions #2/#3) instead target your
  // own hand-rail tab, since you don't have a floating hand of your own.
  const selfTargetable = zone ? playerTargetEligible(zone.effect, you, true) : false;
  const onSelfTarget = () => zonePick({ targetPlayerId: you.id });

  return html`<div className="game">
    ${winner &&
    html`<div className="overlay">
      <div className="modal">
        <h2>${winner.name} wins!</h2>
        <p>All ten cows are grazing on the moon.</p>
        <button onClick=${resetToMenu}>Back to main menu</button>
      </div>
    </div>`}
    ${you.inactive &&
    html`<p role="alert">
      <b>You've been marked inactive — your turns are being skipped.</b>
      <button onClick=${() => send({ type: 'imBack' })}>I'm back!</button>
    </p>`}

    <${Hud} g=${g} deadline=${deadline} myActionPhase=${myActionPhase} />
    <${Table} g=${g} you=${you} myTurn=${myTurn} myActionPhase=${myActionPhase} zone=${zone} onZonePick=${zonePick} />
    <${Hand}
      you=${you}
      interactive=${myActionPhase}
      onPlay=${onPlay}
      onZoom=${setZoom}
      selfTargetable=${selfTargetable}
      onSelfTarget=${onSelfTarget}
    />

    ${zoom &&
    html`<div className="overlay" onClick=${() => setZoom(null)}>
      <div className=${`zoom-card card--${cardKind(zoom)} ${cardArt(zoom) ? 'has-art' : ''}`} onClick=${(e) => e.stopPropagation()}>
        ${cardArt(zoom) ? html`<div className="card-art" style=${bgImage(cardArt(zoom))}></div>` : ''}
        <div className="card-name">${zoom.name}</div>
        <div className="card-text">${zoom.text}</div>
        <div className="zoom-actions">
          ${canAct && !isCownter(zoom)
            ? html`<button onClick=${() => {
                const c = zoom;
                setZoom(null);
                onPlay(c);
              }}>Play</button>`
            : ''}
          ${canAct
            ? html`<button className="recycle" onClick=${() => {
                send({ type: 'recycle', cardInstanceId: zoom.instanceId });
                setZoom(null);
              }}>Recycle</button>`
            : ''}
          <button className="subtle" onClick=${() => setZoom(null)}>Close</button>
        </div>
      </div>
    </div>`}

    ${!myTurn && !g.pending && g.status === 'playing'
      ? html`<div className="turn-banner">Waiting for ${nameOf(g, g.turn.currentPlayerId)}'s turn…</div>`
      : ''}

    ${zone &&
    html`<div className="target-bar">
      <span>Playing <b>${zone.name}</b> — click a highlighted spot: a farm, a rocket, or (for a player) their floating hand.</span>
      ${zone.effect !== 'swapHands' ? html`<button onClick=${() => zonePick({})}>Target no one</button>` : ''}
      <button className="subtle" onClick=${() => setZone(null)}>Cancel</button>
    </div>`}

    ${g.pending &&
    html`<div className="respond-bar">
      <${Respond} g=${g} you=${you} />
    </div>`}

    ${confirm &&
    html`<div className="overlay" onClick=${() => setConfirm(null)}>
      <div className="modal" onClick=${(e) => e.stopPropagation()}>
        <p>${confirm.message}</p>
        <div className="choices">
          ${confirm.blocking
            ? html`<button onClick=${() => setConfirm(null)}>Got it</button>`
            : html`<span className="choices">
                <button onClick=${() => {
                  const c = confirm.card;
                  setConfirm(null);
                  route(c);
                }}>Yes, play it</button>
                <button className="subtle" onClick=${() => setConfirm(null)}>Never mind</button>
              </span>`}
        </div>
      </div>
    </div>`}

    <${LogTail} g=${g} />
  </div>`;
}

/**
 * Your hand, with physical-feeling drag:
 *  - drag a card UP out of the hand → play it (release back down cancels);
 *  - drag a card sideways within the hand → reorder it (purely cosmetic, kept
 *    client-side; the server doesn't track hand order);
 *  - a plain click still plays it, and right-click still reads it big.
 * Reorder lives in a local `order` list of instanceIds, reconciled whenever the
 * server hand changes (cards drawn/played/recycled).
 */
const DRAG_THRESHOLD = 6; // px before a press counts as a drag, not a click
const PLAY_LIFT = 110; // px dragged up before it's a "play", not a "reorder"

function Hand({ you, interactive, onPlay, onZoom, selfTargetable, onSelfTarget }) {
  const serverCards = you?.hand || [];
  const serverIds = serverCards.map((c) => c.instanceId);
  const [order, setOrder] = useState(serverIds);
  const [drag, setDrag] = useState(null); // { id, dx, dy, mode, dropIndex }
  const fanRef = useRef(null);

  // Keep the local order in sync with the server hand (append new, drop gone).
  const idsKey = serverIds.join(',');
  useEffect(() => {
    setOrder((prev) => {
      const kept = prev.filter((id) => serverIds.includes(id));
      const added = serverIds.filter((id) => !kept.includes(id));
      const next = [...kept, ...added];
      return next.length === prev.length && next.every((v, i) => v === prev[i]) ? prev : next;
    });
  }, [idsKey]);

  const byId = Object.fromEntries(serverCards.map((c) => [c.instanceId, c]));
  const cards = order.map((id) => byId[id]).filter(Boolean);

  // One press = one drag. Everything runs off window listeners so the release
  // is never missed, and the DOM is NOT reordered until drop (smooth motion).
  const onDown = (e, c) => {
    if (e.button !== 0) return; // left only; right-click is handled by onContextMenu
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const id = c.instanceId;
    let moved = false;
    let mode = 'reorder';

    // Snapshot each other card's centre X ONCE, before any gap-shifting, so the
    // drop index is measured against fixed positions (no feedback / no jitter).
    const centers = [...(fanRef.current?.children || [])]
      .map((k, i) => ({ id: cards[i]?.instanceId, cx: k.getBoundingClientRect().left + k.getBoundingClientRect().width / 2 }))
      .filter((o) => o.id && o.id !== id);
    const idxAt = (x) => centers.filter((o) => o.cx < x).length;

    const move = (ev) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      moved = true;
      mode = interactive && dy < -PLAY_LIFT ? 'play' : 'reorder';
      setDrag({ id, dx, dy, mode, dropIndex: mode === 'reorder' ? idxAt(ev.clientX) : null });
    };
    const finish = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      setDrag(null);
      if (!moved) {
        // A plain click always opens the large view; play via drag-up or the
        // Play button inside the zoom. (This keeps click from firing off a play
        // — e.g. Super Speedy Cows — when you just wanted to read the card.)
        onZoom(c);
        return;
      }
      if (mode === 'play') {
        if (interactive && !isCownter(c)) onPlay(c);
        return; // released too low / not playable → just drops back, no reorder
      }
      const idx = idxAt(ev.clientX);
      setOrder((prev) => {
        const without = prev.filter((x) => x !== id);
        without.splice(Math.max(0, Math.min(idx, without.length)), 0, id);
        return without;
      });
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  };

  const playing = drag && drag.mode === 'play' ? byId[drag.id] : null;
  const dragPos = drag ? cards.findIndex((c) => c.instanceId === drag.id) : -1;
  // A non-dragged card opens a gap (shifts right) when its rank among the
  // non-dragged cards is at or past where the dragged card will drop.
  const shifts = (c, i) =>
    drag &&
    drag.mode === 'reorder' &&
    drag.id !== c.instanceId &&
    (i < dragPos ? i : i - 1) >= drag.dropIndex;

  return html`<div className=${`hand-rail ${interactive ? 'is-turn' : ''} ${drag ? 'dragging' : ''}`}>
    ${playing
      ? html`<div className="play-hint">release to play <b>${playing.name}</b></div>`
      : html`<div
          className=${`hand-tab ${selfTargetable ? 'targetable' : ''}`}
          onClick=${selfTargetable ? onSelfTarget : undefined}
        >
          ${selfTargetable
            ? 'Click to target yourself'
            : html`Your hand · ${cards.length}${interactive ? ' — click to view, drag up to play' : ' — click to view'}`}
        </div>`}
    <div className="hand-fan" ref=${fanRef}>
      ${cards.length === 0
        ? html`<span className="empty-hand">no cards in hand</span>`
        : cards.map(
            (c, i) => html`<div
              className=${`rail-card card--${cardKind(c)} ${cardArt(c) ? 'has-art' : ''} ${drag?.id === c.instanceId ? `is-drag ${drag.mode}` : ''} ${
                shifts(c, i) ? 'shift' : ''
              }`}
              key=${c.instanceId}
              title=${`${c.name} — ${c.text}`}
              style=${drag?.id === c.instanceId ? { transform: `translate(${drag.dx}px, ${drag.dy}px)` } : undefined}
              onPointerDown=${(e) => onDown(e, c)}
              onContextMenu=${(e) => {
                e.preventDefault();
                onZoom(c);
              }}
            >
              ${cardArt(c) ? html`<div className="card-art" style=${bgImage(cardArt(c))}></div>` : ''}
              <div className="card-name">${c.name}</div>
              <div className="card-text">${c.text}</div>
              ${interactive && isCownter(c)
                ? html`<span className="locked">response only</span>`
                : ''}
            </div>`,
          )}
    </div>
  </div>`;
}

function nameOf(g, id) {
  return g.players.find((p) => p.id === id)?.name ?? id;
}

/** Slim heads-up bar: whose turn, phase, weather, countdown, and — on your
 *  action phase — Do nothing / End turn (herd is a farm click, play is a hand click). */
function Hud({ g, deadline, myActionPhase }) {
  const spent = g.turn.actionsRemaining < 1;
  return html`<div className="hud">
    <div className="hud-turn">
      <span className="hud-who" style=${{ background: playerColor(g.turn.currentPlayerId) }}>
        ${nameOf(g, g.turn.currentPlayerId)}
      </span>
      <span className="hud-phase">
        ${g.turn.phase === 'action'
          ? `${g.turn.actionsRemaining} action${g.turn.actionsRemaining === 1 ? '' : 's'} left`
          : 'drawing'}
      </span>
      ${g.badWeather.length > 0 ? html`<span className="weather-flag">no launches</span>` : ''}
      <${Countdown} deadline=${deadline} g=${g} />
    </div>
    ${myActionPhase
      ? html`<div className="hud-actions">
          <button disabled=${spent} onClick=${() => send({ type: 'passAction' })}>Do nothing</button>
          <button onClick=${() => send({ type: 'endTurn' })}>
            ${spent ? 'End turn ➜' : `End turn (skip ${g.turn.actionsRemaining})`}
          </button>
        </div>`
      : ''}
  </div>`;
}

/** Stable per-seat colour for cow tokens and area accents. */
const PLAYER_COLORS = { p1: '#e24b4a', p2: '#3789dd', p3: '#57b85b', p4: '#e0a92e' };
function playerColor(id) {
  return PLAYER_COLORS[id] ?? '#8b8aa0';
}

/**
 * A cluster of little coloured cow tokens. With `cap`, empty seats are drawn
 * as hollow tokens (used for the rocket, which has a capacity).
 */
function Tokens({ n, color, cap, draggable, areaRef }) {
  // With `draggable`, each cow token can be picked up and moved (tabletop
  // fidget, same feel as the rocket pieces): it keeps a persistent offset and
  // snaps back into the cluster when released close to home OR dropped outside
  // its area (areaRef). A tap (no drag) bubbles through, so clicking the farm
  // still herds.
  const [offsets, setOffsets] = useState({});
  const [dragIdx, setDragIdx] = useState(null);
  const SNAP = 22;

  const startDrag = (e, idx) => {
    if (!draggable || e.button !== 0) return;
    const sx = e.clientX;
    const sy = e.clientY;
    const base = offsets[idx] || { dx: 0, dy: 0 };
    let moved = false;
    const move = (ev) => {
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      if (!moved) {
        if (Math.hypot(dx, dy) < 5) return; // small movement = a tap, not a drag
        moved = true;
        setDragIdx(idx);
      }
      setOffsets((o) => ({ ...o, [idx]: { dx: base.dx + dx, dy: base.dy + dy } }));
    };
    const end = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      setDragIdx(null);
      if (!moved) return; // a tap: let it bubble (e.g. farm herd)
      setOffsets((o) => {
        const cur = o[idx] || { dx: 0, dy: 0 };
        // snap home if released close to the cluster OR dropped outside the area
        return Math.hypot(cur.dx, cur.dy) < SNAP || outsideArea(areaRef, ev)
          ? { ...o, [idx]: { dx: 0, dy: 0 } }
          : o;
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  };

  const dots = [];
  const filled = cap ? Math.min(n, cap) : n;
  for (let i = 0; i < filled; i++) {
    const off = offsets[i] || { dx: 0, dy: 0 };
    dots.push(html`<span
      className=${`cow-token ${draggable ? 'grabbable' : ''} ${dragIdx === i ? 'is-dragging' : ''}`}
      key=${'f' + i}
      style=${{ background: color, transform: `translate(${off.dx}px, ${off.dy}px)`, zIndex: dragIdx === i ? 6 : 1 }}
      onPointerDown=${draggable ? (e) => startDrag(e, i) : undefined}
    ></span>`);
  }
  if (cap) {
    for (let i = filled; i < cap; i++) dots.push(html`<span className="cow-token empty" key=${'e' + i}></span>`);
  }
  return html`<span className="tokens">${dots}</span>`;
}

/**
 * A rocket piece's type/part. The server always sends these (views.ts enriches
 * every card from its def); the `|| 'wild'/'any'` are graceful defaults, not a
 * parsing fallback.
 */
function pieceInfo(card) {
  return { type: card.pieceType || 'wild', part: card.part || 'any' };
}

/**
 * The launch pad: rocket pieces stacked bottom→top, cows shown as tokens.
 * During a zone-target play it becomes interactive: Rocket Thief makes each
 * piece clickable; Mini Rocket makes the rocket's cows clickable.
 */
function LaunchPad({ p, zone, onZonePick }) {
  const r = p.rocket;
  const order = { bottom: 0, middle: 1, top: 2 };
  const sorted = [...r.pieces].sort((a, b) => (order[pieceInfo(a).part] ?? 3) - (order[pieceInfo(b).part] ?? 3));
  const topFirst = [...sorted].reverse(); // rocket top sits highest on screen
  const steal = zone && zone.effect === 'stealRocketPiece' && !p.inactive && r.pieces.length > 0;
  const rocketCow = zone && zone.effect === 'moveCowToMoon' && !p.inactive && r.cows > 0;

  // Pick up and move pieces freely for the tabletop feel — a little assemble-
  // the-rocket mini-game. Each piece keeps a persistent offset from its home
  // slot in the stack; released close to home it snaps into place (the home
  // slots ARE the top-over-middle-over-bottom stack), otherwise it stays put.
  // Works any time (other players' turns, the draw step). Disabled only while
  // Rocket Thief targeting is active (there a click steals the piece).
  // `offsets` is keyed by piece instanceId, so it's per-piece and per-player.
  const [offsets, setOffsets] = useState({});
  const [dragId, setDragId] = useState(null);
  const padRef = useRef(null);
  const SNAP_DIST = 48; // release this close to home and the piece clicks in

  const startDrag = (e, pc) => {
    if (steal || e.button !== 0) return;
    e.preventDefault();
    const id = pc.instanceId;
    const sx = e.clientX;
    const sy = e.clientY;
    const base = offsets[id] || { dx: 0, dy: 0 };
    setDragId(id);
    const move = (ev) =>
      setOffsets((o) => ({ ...o, [id]: { dx: base.dx + (ev.clientX - sx), dy: base.dy + (ev.clientY - sy) } }));
    const end = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      setDragId(null);
      setOffsets((o) => {
        const cur = o[id] || { dx: 0, dy: 0 };
        // snap into the assembled stack if released close to home, or back home
        // if dropped outside the launch pad entirely.
        if (Math.hypot(cur.dx, cur.dy) < SNAP_DIST || outsideArea(padRef, ev)) {
          return { ...o, [id]: { dx: 0, dy: 0 } };
        }
        return o;
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  };

  return html`<div className="launchpad" ref=${padRef}>
    <div className="area-h">Launch pad</div>
    ${r.pieces.length === 0
      ? html`<div className="pad-empty">no rocket yet</div>`
      : html`<div className="rocket-zone">
          <div className="rocket-stack">
            ${topFirst.map((pc) => {
              const rank = order[pieceInfo(pc).part] ?? 0; // bottom 0, middle 1, top 2
              const dragging = dragId === pc.instanceId;
              const off = offsets[pc.instanceId] || { dx: 0, dy: 0 };
              return html`<div
                className=${`pad-card piece--${pieceInfo(pc).type} ${cardArt(pc) ? 'has-art' : ''} ${steal ? 'targetable' : ''} ${dragging ? 'is-dragging' : ''}`}
                key=${pc.instanceId}
                title=${pc.name}
                style=${{ transform: `translate(${off.dx}px, ${off.dy}px)`, zIndex: dragging ? 30 : 10 + rank }}
                onPointerDown=${steal ? undefined : (e) => startDrag(e, pc)}
                onClick=${steal ? () => onZonePick({ targetPlayerId: p.id, pieceInstanceId: pc.instanceId }) : undefined}
              >
                ${cardArt(pc) ? html`<div className="card-art" style=${bgImage(cardArt(pc))}></div>` : ''}
                <div className="card-name">${pc.name}</div>
              </div>`;
            })}
          </div>
          <!-- cows ride ON the rocket: overlaid above the pieces -->
          <div
            className=${`rocket-cows ${rocketCow ? 'targetable' : ''}`}
            onClick=${rocketCow ? () => onZonePick({ targetPlayerId: p.id, from: 'rocket' }) : undefined}
          >
            <${Tokens} key=${p.id} n=${r.cows} color=${playerColor(p.id)} cap=${r.capacity} draggable=${!rocketCow} areaRef=${padRef} />
          </div>
        </div>`}
    ${r.pieces.length > 0
      ? html`<div className="rocket-count">
          <small>${r.cows}/${r.capacity}${r.complete ? ' • ready' : ''}${rocketCow ? ' — click a cow to send' : ''}</small>
        </div>`
      : ''}
  </div>`;
}

/**
 * A player's farm. Click to herd (your turn), or — during a Mini Rocket play —
 * click to send one of this farm's cows to the moon.
 */
function Farm({ p, canHerd, zone, onZonePick }) {
  const zoneFarm = zone && zone.effect === 'moveCowToMoon' && !p.inactive && p.farm > 0;
  const clickable = canHerd || zoneFarm;
  const farmImg = boardArt('farm');
  const farmRef = useRef(null);
  const onClick = () => {
    if (zoneFarm) onZonePick({ targetPlayerId: p.id, from: 'farm' });
    else if (canHerd) send({ type: 'herd' });
  };
  return html`<div
    ref=${farmRef}
    className=${`farm ${farmImg ? 'farm-art' : ''} ${canHerd ? 'herdable' : ''} ${zoneFarm ? 'targetable' : ''}`}
    style=${bgImage(farmImg, 'center top')}
    onClick=${clickable ? onClick : undefined}
  >
    <div className="area-h">Farm</div>
    <${Tokens} key=${p.id} n=${p.farm} color=${playerColor(p.id)} draggable=${!zoneFarm} areaRef=${farmRef} />
    <div className="area-n">${p.farm}</div>
    ${canHerd ? html`<small className="farm-hint">click to herd</small>` : ''}
    ${zoneFarm ? html`<small className="farm-hint">click to send to moon</small>` : ''}
  </div>`;
}

/**
 * An opponent's hand, shown always, as a full-size fan of face-down cards
 * floating off the table's edge behind their play area — as if they were
 * physically holding it just past their own section — so the table feels
 * like other people are actually sitting there, and you can see how many
 * cards they're holding without a number buried in a title bar. Real card-
 * back art (the same `boardArt('back')` the deck uses), not a placeholder —
 * only their COUNT is ever known (spec 7.3 — hands are hidden) so this can
 * never render anything but backs.
 *
 * When a card that targets a whole player is being played (Wind/Space
 * Cowboy/Cow Wrangler — see PLAYER_TARGET_EFFECTS), an eligible opponent's
 * hand becomes clickable, same as any other `.targetable` zone on the table.
 */
function FloatingHand({ p, zone, onZonePick }) {
  const targetable = !!zone && playerTargetEligible(zone.effect, p, false);
  const n = p.handCount;
  const back = bgImage(boardArt('back'));
  const onClick = () => onZonePick({ targetPlayerId: p.id });
  return html`<div
    className=${`floating-hand-wrap ${targetable ? 'targetable' : ''}`}
    onClick=${targetable ? onClick : undefined}
  >
    <div className="floating-hand" style=${{ '--n': n }}>
      ${Array.from(
        { length: n },
        (_, i) => html`<span className="fh-card" key=${i} style=${{ '--i': i, ...back }}></span>`,
      )}
    </div>
    <div className="floating-hand-label">${p.name} · ${n} card${n === 1 ? '' : 's'}</div>
  </div>`;
}

/** The moon: a disc with every landed cow as a coloured token, plus the count. */
function MoonDisc({ g }) {
  const onMoon = g.players.filter((pp) => pp.moon > 0);
  const total = onMoon.reduce((s, pp) => s + pp.moon, 0);
  const moonImg = boardArt('moon');
  return html`<div className=${`moon-disc ${moonImg ? 'moon-art' : ''}`} style=${bgImage(moonImg)}>
    <span className="moon-label">Moon</span>
    <div className="moon-tokens">
      ${onMoon.flatMap((pp) =>
        Array.from(
          { length: pp.moon },
          (_, i) => html`<span className="cow-token" key=${pp.id + i} style=${{ background: playerColor(pp.id) }}></span>`,
        ),
      )}
    </div>
    <span className="moon-n">${total} cow${total === 1 ? '' : 's'}</span>
  </div>`;
}

/**
 * The tabletop: one big round table, seen from a player's chair.
 *
 * Geometry (mirrored by the ".table-viewport / .table-camera / .table-disc"
 * block in styles.css, which carries the long-form explanation):
 *   - `.table-camera` applies the TILT only (rotateX). It is the scene's one
 *     and only 3D rotation.
 *   - `.table-disc` applies the SPIN as a plain 2D rotate(), i.e. rotation
 *     about the axis perpendicular to the table's own surface — a lazy susan.
 *   - `.table-disc` deliberately does NOT set preserve-3d, so everything on
 *     the table is flattened into the table's plane and lies flat on it like
 *     real cards, rather than standing up facing the camera.
 *
 * Seat 0 is always YOU (the player list is rotated below), and seat 0 sits at
 * angle 0 — the near edge, upright. Spinning the table by -angle brings any
 * other player's section to that same upright near position, which is what
 * the old ◀ ▶ "view another player" buttons used to do by swapping content.
 */
function Table({ g, you, myTurn, myActionPhase, zone, onZonePick }) {
  const players = g.players;
  const n = players.length;
  const selfIdx = Math.max(
    0,
    players.findIndex((pp) => pp.id === g.you),
  );
  const seated = [...players.slice(selfIdx), ...players.slice(0, selfIdx)];

  // ---- camera ------------------------------------------------------------
  // One smoothed "target follow" model drives everything: spin and zoom each
  // have a TARGET, and the rendered value eases toward it on requestAnimation-
  // Frame. Dragging writes the rendered value directly so the felt tracks the
  // pointer 1:1; every other input (wheel, buttons, keys, snapping) only moves
  // the target and lets the easing do the work. That is what makes zooming
  // smooth regardless of how bursty the wheel events are, and it gives snapping
  // and "face me" the same motion for free — no CSS transitions involved.
  //
  // Spin is kept UNWRAPPED (it may run past 360 or below 0) on purpose: it
  // makes easing monotonic, so turning never jumps the long way round at the
  // 359->0 seam. Only the snap helpers normalise it, and they pick the nearest
  // equivalent angle so the table always takes the short way.
  const seatStep = 360 / n; // degrees between adjacent seats
  // `centre` blends the zoom's focus between the near play area (0) and the
  // middle of the table (1), so jumping to the shared piles and back is a
  // smooth move rather than a cut.
  const camRef = useRef({ spin: 0, zoom: ZOOM_DEFAULT, centre: 0 });
  const targetRef = useRef({ spin: 0, zoom: ZOOM_DEFAULT, centre: 0 });
  const rafRef = useRef(0);
  const [, bumpFrame] = useReducer((x) => x + 1, 0);
  const [spinning, setSpinning] = useState(false);
  const discRef = useRef(null);
  const viewportRef = useRef(null);

  const runCamera = () => {
    const c = camRef.current;
    const t = targetRef.current;
    const ds = t.spin - c.spin;
    const dz = t.zoom - c.zoom;
    const dc = t.centre - c.centre;
    if (Math.abs(ds) < 0.03 && Math.abs(dz) < 0.0005 && Math.abs(dc) < 0.002) {
      camRef.current = { spin: t.spin, zoom: t.zoom, centre: t.centre };
      rafRef.current = 0;
    } else {
      camRef.current = {
        spin: c.spin + ds * CAMERA_SMOOTHING,
        zoom: c.zoom + dz * CAMERA_SMOOTHING,
        centre: c.centre + dc * CAMERA_SMOOTHING,
      };
      rafRef.current = requestAnimationFrame(runCamera);
    }
    bumpFrame();
  };
  const startCamera = () => {
    if (!rafRef.current) rafRef.current = requestAnimationFrame(runCamera);
  };
  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  const setTarget = (patch) => {
    targetRef.current = { ...targetRef.current, ...patch };
    startCamera();
  };
  const cam = camRef.current;
  // Tilt is DERIVED from zoom, not steered separately: framed-out it sits at
  // the default lean, and it flattens toward 0deg (looking straight down at
  // the table) as you close in on a play area.
  const pitch = CAMERA_PITCH_DEFAULT * (1 - zoomProgress(cam.zoom));

  // Snapping: seat i is at angle seatStep*i, and is brought to the near edge by
  // spin = -seatStep*i — so every "player is square-on to me" position is an
  // exact multiple of seatStep, and snapping is just rounding.
  const snapOf = (spin) => Math.round(spin / seatStep) * seatStep;
  const stepSnap = (dir) =>
    setTarget({ spin: (Math.round(targetRef.current.spin / seatStep) + dir) * seatStep, centre: 0 });
  // The nearest spin equivalent to `angle` (which may be any multiple of 360
  // away from it, since spin is kept unwrapped) — i.e. "turn the table to
  // face `angle` the short way," used to square up to your own seat without
  // a long spin-around when it's currently off to the side.
  const nearestSpinFor = (angle) => angle + Math.round((targetRef.current.spin - angle) / 360) * 360;

  // ---- spin the table by dragging the felt, or click a play area to pick it
  // as the zoom target -------------------------------------------------------
  // Gesture ownership: a press starts a turn unless it landed on something
  // that handles its own input (see NOT_A_TABLE_GRAB), so dragging a card,
  // piece or token never also turns the table and vice versa. e.target is used
  // rather than currentTarget precisely because it does not change as the
  // event bubbles, so .closest() sees the real element under the pointer.
  //
  // A press on your own launch pad or the shared hub (deck/discard/store/
  // moon) that releases WITHOUT dragging is a click, not a spin: it just
  // picks that area as the zoom focus (`centre`) — actually zooming in is a
  // separate step, done by scrolling or the up/down arrow keys.
  const onDiscPointerDown = (e) => {
    if (e.button !== 0) return;
    if (e.target.closest && e.target.closest(NOT_A_TABLE_GRAB)) return;
    e.preventDefault();
    const selfPad = e.target.closest && e.target.closest('.seat--self .launchpad');
    const hub = e.target.closest && e.target.closest('.table-hub');
    const rect = discRef.current.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    // The tilt squashes the table's Y axis on screen by cos(pitch); undoing it
    // makes the felt stay under the cursor instead of lagging near the far rim.
    // At full zoom the tilt is 0 and this correction correctly becomes 1.
    const ky = 1 / Math.max(0.25, Math.cos((pitch * Math.PI) / 180));
    const angleAt = (px, py) => (Math.atan2((py - cy) * ky, px - cx) * 180) / Math.PI;
    const startAngle = angleAt(e.clientX, e.clientY);
    const startSpin = camRef.current.spin;
    const startX = e.clientX;
    const startY = e.clientY;
    let dragged = false;
    setSpinning(true);
    const move = (ev) => {
      if (!dragged && Math.hypot(ev.clientX - startX, ev.clientY - startY) >= ZOOM_TARGET_CLICK_THRESHOLD) {
        dragged = true;
      }
      // Written straight to the rendered value: a drag should track the finger
      // exactly, not trail it through the smoother.
      const spin = startSpin + angleAt(ev.clientX, ev.clientY) - startAngle;
      camRef.current = { ...camRef.current, spin };
      targetRef.current = { ...targetRef.current, spin };
      bumpFrame();
    };
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      setSpinning(false);
      if (!dragged) {
        // A plain click: pick the zoom target, leave the zoom level alone.
        if (selfPad) setTarget({ centre: 0, spin: nearestSpinFor(0) });
        else if (hub) setTarget({ centre: 1 });
        return;
      }
      // Close in, and the table settles onto whichever player you let go
      // nearest — so you land square-on to their area rather than half-way
      // between two seats. Only when focused on a play area: settling onto a
      // seat makes no sense while zoomed on the shared hub in the middle.
      if (targetRef.current.centre < 1 && targetRef.current.zoom >= SNAP_ZOOM) {
        setTarget({ spin: snapOf(targetRef.current.spin) });
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  };

  // ---- keyboard: left/right step between players, up/down zoom ------------
  useEffect(() => {
    const onKey = (e) => {
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return; // don't hijack typing
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        stepSnap(e.key === 'ArrowLeft' ? -1 : 1);
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        nudgeZoom(e.key === 'ArrowUp' ? ZOOM_STEP : -ZOOM_STEP);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seatStep]);

  // ---- zoom ---------------------------------------------------------------
  // A trackpad pinch reaches the browser as a wheel event, so one path covers
  // both. Passive listeners can't preventDefault, hence the explicit effect.
  // The wheel only moves the TARGET; the smoother above turns a burst of
  // events into one continuous glide.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e) => {
      e.preventDefault();
      applyZoom(targetRef.current.zoom - e.deltaY * 0.0016);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seatStep]);

  // Track the viewport height so the framing offset below stays proportional.
  const [viewH, setViewH] = useState(0);
  useEffect(() => {
    const el = viewportRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const update = () => setViewH(el.clientHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  function applyZoom(next) {
    const zoom = clamp(next, ZOOM_MIN, ZOOM_MAX);
    const patch = { zoom };
    // Zooming in past the snap point settles onto the nearest player too, so
    // closing in always leaves you square-on to somebody's area. Only when
    // focused on a play area — there's no "nearest seat" to settle onto while
    // zoomed on the shared hub in the middle.
    if (targetRef.current.centre < 1 && zoom >= SNAP_ZOOM && targetRef.current.zoom < SNAP_ZOOM) {
      patch.spin = snapOf(targetRef.current.spin);
    }
    setTarget(patch);
  }
  const nudgeZoom = (d) => applyZoom(targetRef.current.zoom + d);
  // "Face me": back to your own seat (angle 0) and the framed-out view.
  const faceMe = () => setTarget({ spin: 0, zoom: ZOOM_DEFAULT, centre: 0 });

  // Focus point for the zoom, in the table's own (unrotated) coordinates.
  // The seat currently at the near edge is the one whose angle is -spin, and a
  // seat at angle a sits at (-R sin a, R cos a) — so the near seat is at
  // (R sin spin, R cos spin). The CSS applies this as `rotate() translate()`,
  // i.e. in the table's unrotated frame, so no extra conversion is needed.
  // Negated because we shift the TABLE to bring that point under the camera.
  const focusT = focusAmount(cam.zoom) * FOCUS_AT_FULL_ZOOM;
  // `centre` = 1 pulls the focus point toward the table's middle, which is
  // where the moon, deck, discard and store live — so zooming closes in on
  // the shared piles instead of a play area.
  const seatFocus = focusT * (1 - cam.centre);
  const hubFocus = focusT * cam.centre;
  const spinRad = (cam.spin * Math.PI) / 180;
  // The hub's own content stays upright on screen regardless of spin (it
  // counter-rotates against the table's spin — see .table-hub in
  // styles.css), so its "toward the store" direction is a FIXED screen
  // vector (0, HUB_FOCUS_LIFT), combined here with the seat term (opposite
  // sign — see the comment above) before the same rotate(-spin) compensation
  // is applied to both, so that fixed direction survives the disc's own
  // rotate(spin) and doesn't swing around as the table turns.
  const radius = hubFocus * HUB_FOCUS_LIFT - seatFocus * SEAT_RADIUS;
  const focus = {
    x: radius * Math.sin(spinRad),
    y: radius * Math.cos(spinRad),
  };
  // Framing offset. Zoomed out the whole disc is in view and is nudged up so
  // the near rim (and your own area on it) clears the hand rail; zoomed in the
  // focus point is already the play area, so the nudge relaxes to nothing.
  // Two separate reasons to nudge the scene up, blended by how far in we are:
  // framed out, so the near rim clears the hand rail; zoomed in on a play
  // area, so that area sits above the rail rather than under it. Focused on
  // the middle of the table only the first applies.
  const focusLift = -((1 - focusT) * FRAME_LIFT_FRACTION + seatFocus * PLAY_AREA_LIFT_FRACTION) * viewH;

  const myDrawPhase = myTurn && !g.pending && g.turn.phase === 'draw';
  const emptyHand = (you?.hand?.length ?? 0) === 0;
  const need = g.turn.drawsRemaining ?? g.drawsPerTurn; // draws left this phase (server-tracked)
  // Each pick is sent on its own, so the drawn card lands in your hand before
  // the next pick — the server reveals deck draws one at a time.
  const doPick = (pick) => {
    if (!myDrawPhase) return;
    send({ type: 'drawCards', picks: emptyHand ? [] : [pick] });
  };
  const deckDisabled =
    !myDrawPhase || (!emptyHand && g.deckCount === 0 && g.discard.length === 0 && g.rocketStore.length >= need);
  const topDiscard = g.discard.length ? g.discard[g.discard.length - 1] : null;
  // The hint bar is always rendered (it reserves its space via CSS) so the
  // table never shifts when it changes; its text follows the phase.
  const phaseHint =
    !myTurn || g.pending || g.status !== 'playing'
      ? ''
      : g.turn.phase === 'draw'
        ? emptyHand
          ? 'Draw phase — click the deck to draw 5'
          : `Draw phase — click ${need} card${need === 1 ? '' : 's'} from the deck or store`
        : 'Action phase — take three actions';

  return html`<div className="table">
    <div className="draw-hint">${phaseHint}</div>
    <div className="table-viewport" ref=${viewportRef}>
      <div
        className="table-camera"
        style=${{
          '--camera-pitch': `${pitch}deg`,
          '--camera-z': `${zoomToZ(cam.zoom)}px`,
          '--focus-lift': `${focusLift}px`,
        }}
      >
        <div
          className=${`table-disc ${spinning ? 'is-spinning' : ''}`}
          ref=${discRef}
          onPointerDown=${onDiscPointerDown}
          style=${{ '--table-spin': `${cam.spin}deg`, '--focus-x': `${focus.x}px`, '--focus-y': `${focus.y}px` }}
        >
          <!-- centre of the table: the moon, with the shared piles beside it -->
          <div className="table-hub">
            <div className="table-hub-inner">
            <div className="store">
              <div className="store-cards2">
                ${g.rocketStore.length
                  ? g.rocketStore.map(
                      (c) => html`<button
                        key=${c.instanceId}
                        className=${`store-card card--${cardKind(c)} ${cardArt(c) ? 'has-art' : ''} ${myDrawPhase ? 'drawable' : ''}`}
                        disabled=${!myDrawPhase}
                        onClick=${() => doPick({ source: 'rocketStore', instanceId: c.instanceId })}
                        onContextMenu=${(e) => e.preventDefault()}
                        title=${`${c.name} — ${c.text}`}
                      >
                        ${cardArt(c) ? html`<div className="card-art" style=${bgImage(cardArt(c))}></div>` : ''}
                        <span className="sc-name">${c.name}</span>
                      </button>`,
                    )
                  : html`<span className="pile-empty">(store empty)</span>`}
              </div>
              <span className="pile-cap">Rocket store</span>
            </div>
            <div className="hub-row">
              <button
                className=${`pile deck-pile ${myDrawPhase && !deckDisabled ? 'drawable' : ''}`}
                disabled=${deckDisabled}
                onClick=${() => doPick({ source: 'deck' })}
              >
                <span className="pile-visual">
                  <span className="pile-back" style=${bgImage(boardArt('back'))}></span>
                </span>
                <span className="pile-cap">Deck · ${g.deckCount}</span>
              </button>
              <${MoonDisc} g=${g} />
              <div className="pile discard-pile">
                <span className="pile-visual">
                  ${topDiscard
                    ? html`<span
                        className=${`pile-face card--${cardKind(topDiscard)}`}
                        style=${cardArt(topDiscard)
                          ? { ...bgImage(cardArt(topDiscard)), color: 'transparent', borderTopColor: 'transparent' }
                          : undefined}
                      >${topDiscard.name}</span>`
                    : html`<span className="pile-empty">empty</span>`}
                </span>
                <span className="pile-cap">Discard · ${g.discard.length}</span>
              </div>
            </div>
            </div>
          </div>

          <!-- one flat section per player, fanned evenly around the table -->
          ${seated.map((p, i) => {
            const seatAngle = (360 / n) * i;
            const isSelf = p.id === g.you;
            const canHerd =
              isSelf && myActionPhase && p.farm > 0 && p.rocket.pieces.length > 0 && p.rocket.cows < p.rocket.capacity;
            return html`<div
              className=${`seat ${isSelf ? 'seat--self' : ''}`}
              key=${p.id}
              style=${{ '--seat-angle': `${seatAngle}deg`, '--pcolor': playerColor(p.id) }}
            >
              <div className="seat-inner">
                <div className="pad-column">
                  <${LaunchPad} p=${p} zone=${zone} onZonePick=${onZonePick} />
                </div>
                <div className="player-area">
                  <div className="area-title">
                    ${isSelf ? 'Your area' : `${p.name}'s area`}${!p.connected ? ' · off' : ''}${p.inactive
                      ? ' · idle'
                      : ''}
                    <small> · ${p.handCount} in hand · ${p.moon}/10 on moon</small>
                  </div>
                  <${Farm} p=${p} canHerd=${canHerd} zone=${zone} onZonePick=${onZonePick} />
                </div>
              </div>
            </div>`;
          })}
        </div>

        <!--
          Opponent floating hands live in their OWN sibling layer, not inside
          .table-disc/.seat with everything else. .table-disc is deliberately
          transform-style:flat so cards/pieces/farms all lie FLAT on the felt
          (see its comment) — and per the CSS spec, a preserve-3d descendant
          is forced back to flat by ANY flat ancestor, all the way up the
          chain. A card that's actually meant to stand up in 3D therefore
          can't live inside .table-disc at all; it needs its own branch,
          rooted directly off .table-camera (which IS preserve-3d), so the
          rotateX below actually renders as a standing card instead of being
          silently flattened away to nothing. This layer replicates
          .table-disc's own spin/pan transform so it stays visually locked to
          the table, and each .fh-anchor replicates .seat's own
          rotate(seat-angle) translateY(seat-radius) placement, just pushed
          further out.
        -->
        <div
          className="floating-hands-layer"
          style=${{ '--table-spin': `${cam.spin}deg`, '--focus-x': `${focus.x}px`, '--focus-y': `${focus.y}px` }}
        >
          ${seated.map((p, i) => {
            if (p.id === g.you) return '';
            const seatAngle = (360 / n) * i;
            return html`<div className="fh-anchor" key=${p.id} style=${{ '--seat-angle': `${seatAngle}deg` }}>
              <${FloatingHand} p=${p} zone=${zone} onZonePick=${onZonePick} />
            </div>`;
          })}
        </div>
      </div>

      <div className="camera-hud">
        <button className="subtle" onClick=${() => stepSnap(-1)} aria-label="Turn to the previous player">↺</button>
        <button className="subtle" onClick=${() => stepSnap(1)} aria-label="Turn to the next player">↻</button>
        <button className="subtle" onClick=${faceMe} aria-label="Face my own seat">⌂</button>
      </div>
      <div className="camera-hint">
        drag the felt to turn · ← → next player · click your pad or the shared piles, then ↑ ↓ or scroll to zoom · ⌂ back to you
      </div>
    </div>
  </div>`;
}

/**
 * Pre-send sanity checks for plays that look like mistakes. Returns null when
 * the play is fine, or { message, blocking } to show an in-page panel —
 * blocking means the play can't happen at all, otherwise it's a friendly
 * "are you sure?" with a Play-anyway option. (No native alert/confirm popups:
 * those read like browser errors.)
 */
function playCheck(you, card) {
  const r = you.rocket;
  if (card.type === 'launch') {
    if (!r.complete) {
      return {
        blocking: true,
        message: 'Your rocket needs a bottom, a middle and a top before it can launch.',
      };
    }
    if (r.cows < r.capacity) {
      return { message: `Your rocket has ${r.cows} of ${r.capacity} cow seats filled. Launch anyway?` };
    }
  }
  if (card.effect === 'moveCowsFarmToRocket') {
    const count = typeof card.params?.count === 'number' ? card.params.count : 0;
    const room = r.pieces.length === 0 ? 0 : r.capacity - r.cows;
    const wouldMove = Math.max(0, Math.min(count, you.farm, room));
    if (wouldMove === 0) {
      return {
        message:
          r.pieces.length === 0
            ? `There's no rocket on your launch pad, so ${card.name} wouldn't move any cows. Play it anyway?`
            : `${card.name} wouldn't move any cows right now (rocket full, or no cows on the farm). Play it anyway?`,
      };
    }
    if (wouldMove < count) {
      return {
        message: `${card.name} would only move ${wouldMove} cow${wouldMove === 1 ? '' : 's'} right now. Play it anyway?`,
      };
    }
  }
  return null;
}

/**
 * "targeting Bob (from their rocket)" — who/what the pending event is aimed
 * at. Public at a physical table and material to the Cownter decision.
 */
function describeTarget(g, item) {
  const p = item.params;
  if (!p?.targetPlayerId) return '';
  const target = g.players.find((x) => x.id === p.targetPlayerId);
  if (!target) return '';
  let detail = '';
  if (p.from) detail = ` (from their ${p.from})`;
  if (p.pieceInstanceId) {
    const piece = target.rocket.pieces.find((x) => x.instanceId === p.pieceInstanceId);
    if (piece) detail = ` (${piece.name})`;
  }
  return ` targeting ${target.name}${detail}`;
}

function Respond({ g, you }) {
  const pending = g.pending;
  const base = pending.stack[0];
  const top = pending.stack[pending.stack.length - 1];
  const myTurnToRespond = pending.toRespond[0] === you.id;
  const myCownter = you.hand?.find(isCownter);

  return html`<div className="respond-panel">
    <p className="headline">
      ${nameOf(g, base.playerId)} played ${base.card.name}${describeTarget(g, base)}
    </p>
    ${pending.stack.length > 1
      ? html`<p className="chain">Cownter chain: ${pending.stack.slice(1).map((i) => nameOf(g, i.playerId)).join(' → ')}</p>`
      : ''}
    ${myTurnToRespond
      ? html`<div className="choices">
          <span>Respond to ${top === base ? 'it' : `${nameOf(g, top.playerId)}'s Cownter`}:</span>
          ${myCownter &&
          html`<button className="cownter-btn" onClick=${() => send({ type: 'respondToPending', response: 'cownter', cardInstanceId: myCownter.instanceId })}>
            Play Cownter! (free)
          </button>`}
          <button onClick=${() => send({ type: 'respondToPending', response: 'pass' })}>Pass</button>
        </div>`
      : html`<p className="waiting">Waiting for ${nameOf(g, pending.toRespond[0])} to respond…</p>`}
  </div>`;
}

/** Turns a raw engine log event into a friendly one-liner (presentation only). */
function formatLogEvent(g, e) {
  const who = (id) => nameOf(g, id);
  switch (e.type) {
    case 'gameStarted': return 'Game started.';
    case 'turnStarted': return `${who(e.playerId)}'s turn.`;
    case 'drew': return `${who(e.playerId)} drew ${e.picks?.length ?? ''} card(s).`;
    case 'drewEmptyHand': return `${who(e.playerId)} drew a fresh ${e.drawn}.`;
    case 'herded': return `${who(e.playerId)} herded a cow into their rocket.`;
    case 'cowsMovedToRocket': return `${who(e.playerId)} moved ${e.moved} cow(s) into their rocket.`;
    case 'rocketPiecePlayed': return `${who(e.playerId)} added a rocket piece.`;
    case 'rocketLaunched': return `${who(e.playerId)} launched with ${e.cows} cow(s)!`;
    case 'recycled': return `${who(e.playerId)} recycled a card.`;
    case 'passedAction': return `${who(e.playerId)} did nothing.`;
    case 'turnEnded': return `${who(e.playerId)} ended their turn.`;
    case 'turnSkipped': return `${who(e.playerId)}'s turn was skipped (idle).`;
    case 'turnAutoEnded': return `${who(e.playerId)}'s turn auto-ended.`;
    case 'turnPassedOver': return `${who(e.playerId)} was passed over (inactive).`;
    case 'playerWentInactive': return `${who(e.playerId)} is now inactive.`;
    case 'playerReturned': return `${who(e.playerId)} is back.`;
    case 'eventPlayed': return `${who(e.playerId)} played an event card.`;
    case 'cownterPlayed': return `${who(e.playerId)} played a Cownter!`;
    case 'respondedPass': return `${who(e.playerId)} passed.`;
    case 'eventCancelled': return 'An event was Cowntered.';
    case 'eventResolved': return 'An event resolved.';
    case 'cardEffectNotDefined': return 'A card had no defined effect.';
    case 'cowReturnedFromMoon': return `A cow came back from the moon (${who(e.targetPlayerId)}).`;
    case 'cowLandedByMiniRocket': return `A cow landed on the moon (${who(e.targetPlayerId)}).`;
    case 'cowsWrangled': return `${who(e.targetPlayerId)}'s ${e.count} rocket cow(s) went home.`;
    case 'rocketPieceStolen': return `${who(e.playerId)} stole a rocket piece from ${who(e.targetPlayerId)}${e.cowsReturned ? ` (${e.cowsReturned} cow(s) returned)` : ''}.`;
    case 'badWeatherStarted': return `${who(e.playerId)} brought Bad Weather.`;
    case 'handsSwapped': return `${who(e.playerId)} swapped hands with ${who(e.targetPlayerId)}.`;
    case 'deckReshuffled': return `Deck reshuffled (${e.cards} cards).`;
    case 'gameOver': return `${who(e.winnerId)} wins!`;
    default: return e.type;
  }
}

function LogTail({ g }) {
  return html`<details className="log">
    <summary>Activity log</summary>
    <ul className="log-feed">
      ${g.log.slice().reverse().map((e, i) => html`<li key=${i}>${formatLogEvent(g, e)}</li>`)}
    </ul>
  </details>`;
}

// Load the art map first (falls back to text if it's missing), then render.
fetch('art.json')
  .then((r) => (r.ok ? r.json() : null))
  .then((a) => {
    if (a) ART = { cards: a.cards ?? {}, board: a.board ?? {} };
  })
  .catch(() => {})
  .finally(() => createRoot(document.getElementById('root')).render(html`<${App} />`));
