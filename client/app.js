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

// ------------------------------------------------- card flight animation ---
// FLIP-style draw/play animation, native Web Animations API only (v2 §1.5).
// Source/destination DOM elements register themselves here via ref
// callbacks — plain bookkeeping outside React state, since it never needs to
// trigger a render. The actual draw/play is already authoritative by the
// time any of this runs; this is a purely cosmetic client-side overlay.
const flightEls = { deck: null, discard: null, store: new Map(), hand: new Map() };
const regFlightEl = (bucket, key) => (el) => {
  if (bucket === 'deck' || bucket === 'discard') {
    flightEls[bucket] = el || null;
  } else if (el) {
    flightEls[bucket].set(key, el);
  } else {
    flightEls[bucket].delete(key);
  }
};
// Queued flights: captured at the moment the player acts (so the ghost's
// starting look/position is right), consumed once the resulting state change
// actually lands in the next render.
let pendingDraws = []; // FIFO of { rect, clone } — one per individual draw pick
const pendingPlays = new Map(); // cardInstanceId -> { rect, clone }

function snapshotEl(el) {
  if (!el) return null;
  return { rect: el.getBoundingClientRect(), clone: el.cloneNode(true) };
}
/** Called from Table right before sending a drawCards pick. */
function queueDrawFlight(pick) {
  const src = pick?.source === 'rocketStore' ? flightEls.store.get(pick.instanceId) : flightEls.deck;
  const snap = snapshotEl(src);
  if (snap) pendingDraws.push(snap);
}
/** Called from Hand right before a drag-release or click sends a play. */
function queuePlayFlight(cardInstanceId) {
  const snap = snapshotEl(flightEls.hand.get(cardInstanceId));
  if (snap) pendingPlays.set(cardInstanceId, snap);
}

const prefersReducedMotion = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;

/**
 * Animate a snapshot clone from its captured position to `destEl`'s current
 * position, then remove it. `onSettled` fires when the flight is over (used
 * to un-hide the real element it stood in for). Reduced motion drops the
 * arc/translate for a short opacity crossfade instead (§8).
 */
function flyGhost(snap, destEl, { rotateEnd = 0, duration = 350 } = {}, onSettled) {
  if (!snap || !destEl) {
    onSettled?.();
    return;
  }
  const destRect = destEl.getBoundingClientRect();
  const ghost = snap.clone;
  ghost.className = `flight-ghost ${ghost.className || ''}`;
  // getBoundingClientRect already reflects whatever transform/margin the
  // source had at capture time (e.g. an in-progress drag offset, the hand
  // rail's overlapping negative margin) — reset both on the clone so the
  // animation's own transform is the only one in play, not stacked on top.
  ghost.style.transform = 'none';
  ghost.style.margin = '0';
  ghost.style.position = 'fixed';
  ghost.style.left = `${snap.rect.left}px`;
  ghost.style.top = `${snap.rect.top}px`;
  ghost.style.width = `${snap.rect.width}px`;
  ghost.style.height = `${snap.rect.height}px`;
  document.body.appendChild(ghost);

  const dx = destRect.left - snap.rect.left;
  const dy = destRect.top - snap.rect.top;
  const reduced = prefersReducedMotion();
  const keyframes = reduced
    ? [{ opacity: 1 }, { opacity: 0 }]
    : [
        { transform: 'translate(0,0) scale(1) rotate(0deg)' },
        { transform: `translate(${dx * 0.5}px, ${dy * 0.5 - 40}px) scale(1.06) rotate(0deg)`, offset: 0.5 },
        { transform: `translate(${dx}px, ${dy}px) scale(1) rotate(${rotateEnd}deg)` },
      ];
  const anim = ghost.animate(keyframes, {
    duration: reduced ? 120 : duration,
    easing: reduced ? 'ease' : 'cubic-bezier(0.33, 0, 0.2, 1)',
  });
  const finish = () => {
    ghost.remove();
    onSettled?.();
  };
  anim.onfinish = finish;
  anim.oncancel = finish;
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
    ${(state.screen === 'home' || state.screen === 'lobby') && html`<${MenuTable} />`}
    ${state.screen === 'home' && html`<${Home} connected=${state.connected} />`}
    ${state.screen === 'lobby' && html`<${Lobby} state=${state} />`}
    ${state.screen === 'game' && html`<${Game} state=${state} deadline=${state.deadline} />`}
  </div>`;
}

/**
 * The menu's idling table-in-space backdrop (v2 §1.4): the same starfield
 * (already on body) + a simplified, empty table disc that spins slowly and
 * passively behind the screen-anchored home/lobby panel. Purely decorative —
 * a plain CSS @keyframes loop, not JS-driven camera state — and not
 * interactive: dragging the visible table on the menu does nothing.
 */
function MenuTable() {
  return html`<div className="menu-table-viewport" aria-hidden="true">
    <div className="table-camera">
      <div className="table-disc">
        <div className="table-surface"></div>
      </div>
    </div>
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

/** Cards that pick a whole player via a popup. Empty as of the redesign
 *  (v2 §1.3 converts the last three to zone-clicks below) — kept as the
 *  documented extension point for any future card that genuinely needs a
 *  player-list popup rather than an on-table zone. */
const POPUP_EFFECTS = [];
/** Cards that pick a specific spot by clicking a highlighted zone on the
 *  table. Wind/Cow Wrangler/Space Cowboy join Mini Rocket/Rocket Thief here
 *  per v2 §1.3 — Cownter response is the only interaction left that still
 *  opens a blocking popup. */
const ZONE_EFFECTS = ['moveCowToMoon', 'stealRocketPiece', 'swapHands', 'moveCowMoonToFarm', 'returnRocketCowsToFarm'];

// ------------------------------------------------------- 3D table camera ---
// Redesign v2 §1.1–§1.2: free-orbiting yaw, clamped pitch/zoom. These mirror
// the documentation constants in styles.css's :root — this file is the
// authoritative source (styles.css just documents them for reference).
const CAMERA_PITCH_DEFAULT = 50; // deg from vertical
const CAMERA_PITCH_MIN = 38;
const CAMERA_PITCH_MAX = 62;
const CAMERA_ZOOM_MIN = 0.55;
const CAMERA_ZOOM_MAX = 1.6;
const CAMERA_ZOOM_STEP = 0.15; // per wheel notch / button press
const CAMERA_ROTATE_SENSITIVITY = 0.35; // deg of yaw per px of drag delta
const CAMERA_YAW_STEP = 6; // deg per arrow-key press
const CAMERA_BASE_DISTANCE = 2700; // px; --camera-z = -BASE / zoom (scaled up with --disc-radius, styles.css)
const PIECE_SNAP_RADIUS_PX = 28; // local px; matches --piece-snap-radius-px (v2 §1.6)

const wrapYaw = (deg) => ((deg % 360) + 360) % 360;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Follow-up fix (2026-08): seats no longer wrap the table's full 360°, which
// used to put roughly half the players on the disc's far side — a vertical
// standing panel rotated to face the center reads as upside-down/backwards
// from there, i.e. "on the opposite face" of the table. All seats now sit
// within one arc of the near face instead, fanned out either side of your
// own seat (always index 0 in `seated`, kept at yaw 0 / dead centre); the
// camera still orbits freely to bring any seat to the front, same as before.
const SEAT_ARC_DEGREES = 150; // degrees spread across the far side of the fan
function seatAngleFor(idx, n) {
  if (idx === 0 || n <= 1) return 0;
  const side = idx % 2 === 1 ? 1 : -1; // alternate right/left of your own seat
  const rank = Math.ceil(idx / 2); // 1st, 2nd... seat out from centre on that side
  const step = SEAT_ARC_DEGREES / n;
  return side * rank * step;
}

function Game({ state, deadline }) {
  // Hooks first (before any early return) so hook order is stable.
  const [confirm, setConfirm] = useState(null); // { card, message, blocking }
  const [picker, setPicker] = useState(null); // player-choice card (popup)
  const [zone, setZone] = useState(null); // zone-select card (click a spot on the table)
  const [zoom, setZoom] = useState(null); // a card being read big (rendered outside the hand rail)
  // Camera state (redesign v2 §1.1): disposable, presentation-only, never
  // sent to the server, reset on reload — same category as the existing
  // piece/cow drag offsets.
  const [camera, setCamera] = useState({ yaw: 0, pitch: CAMERA_PITCH_DEFAULT, zoom: 1 });
  // Card-flight bookkeeping (v2 §1.5): which hand-card ids are mid-flight-in
  // (hidden until their ghost lands) and whether the discard face is
  // mid-flight-in from a play — both disposable presentation state, owned
  // here since Hand triggers them but Table renders the discard pile.
  const [flyingIds, setFlyingIds] = useState(() => new Set());
  const [discardFlight, setDiscardFlight] = useState(false);

  const g = state.game;
  if (!g) return html`<p className="waiting">Waiting for game state…</p>`;
  const you = g.players.find((p) => p.id === g.you);
  const myTurn = g.turn.currentPlayerId === g.you && g.status === 'playing';
  const myActionPhase = !g.pending && myTurn && g.turn.phase === 'action' && !you.inactive;
  const canAct = myActionPhase && g.turn.actionsRemaining > 0; // actions still left this turn
  const winner = g.winnerId && g.players.find((p) => p.id === g.winnerId);

  const route = (card) => {
    if (POPUP_EFFECTS.includes(card.effect)) setPicker(card);
    else if (ZONE_EFFECTS.includes(card.effect)) setZone(card);
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
    <${Table}
      g=${g}
      you=${you}
      myTurn=${myTurn}
      myActionPhase=${myActionPhase}
      zone=${zone}
      onZonePick=${zonePick}
      camera=${camera}
      setCamera=${setCamera}
      discardFlight=${discardFlight}
    />
    <${Hand}
      you=${you}
      interactive=${myActionPhase}
      onPlay=${onPlay}
      onZoom=${setZoom}
      flyingIds=${flyingIds}
      setFlyingIds=${setFlyingIds}
      setDiscardFlight=${setDiscardFlight}
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
      <span>Playing <b>${zone.name}</b> — click a highlighted spot (drag the table or use ◀ ▶ arrow keys to look around).</span>
      <button onClick=${() => zonePick({})}>Target no one</button>
      <button className="subtle" onClick=${() => setZone(null)}>Cancel</button>
    </div>`}

    ${g.pending &&
    html`<div className="respond-bar">
      <${Respond} g=${g} you=${you} />
    </div>`}

    ${confirm &&
    html`<div className="overlay" onClick=${() => setConfirm(null)}>
      <div className="modal" onClick=${(e) => e.stopPropagation()}>
        <p>🤔 ${confirm.message}</p>
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

    ${picker &&
    html`<div className="overlay" onClick=${() => setPicker(null)}>
      <div className="modal" onClick=${(e) => e.stopPropagation()}>
        <${TargetPicker} g=${g} you=${you} card=${picker} done=${() => setPicker(null)} />
      </div>
    </div>`}

    <${LogTail} g=${g} />
  </div>`;
}

/**
 * Your hand as cards peeking up from the bottom edge of the table. They sit
 * mostly hidden (name + top visible); hovering the rail slides the whole thing
 * up to reveal full cards — as a fixed overlay, so it never shifts the table.
 * Click a card to play it (on your turn); right-click any card to read it big
 * with Play/Recycle. Everything is positioned, so nothing reflows the screen.
 */
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

function Hand({ you, interactive, onPlay, onZoom, flyingIds, setFlyingIds, setDiscardFlight }) {
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

  // Card flight (v2 §1.5): a card entering the hand (a draw pick queued in
  // Table via queueDrawFlight) or leaving it (a play queued below via
  // queuePlayFlight) gets a FLIP ghost flown between its captured source
  // position and its real destination, once that destination has actually
  // rendered. Purely cosmetic — the server state this reflects already
  // landed; this only decorates how it appears.
  const prevIdsRef = useRef(serverIds);
  useEffect(() => {
    const prev = prevIdsRef.current;
    const added = serverIds.filter((id) => !prev.includes(id));
    const removed = prev.filter((id) => !serverIds.includes(id));
    prevIdsRef.current = serverIds;

    added.forEach((id) => {
      const snap = pendingDraws.shift();
      if (!snap) return;
      setFlyingIds?.((s) => new Set(s).add(id));
      requestAnimationFrame(() => {
        flyGhost(snap, flightEls.hand.get(id), { duration: 350 }, () => {
          setFlyingIds?.((s) => {
            const next = new Set(s);
            next.delete(id);
            return next;
          });
        });
      });
    });

    removed.forEach((id) => {
      const snap = pendingPlays.get(id);
      if (!snap) return; // untracked removal (e.g. recycle) — no flight
      pendingPlays.delete(id);
      setDiscardFlight?.(true);
      requestAnimationFrame(() => {
        flyGhost(snap, flightEls.discard, { duration: 300, rotateEnd: 6 }, () => setDiscardFlight?.(false));
      });
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
        if (interactive && !isCownter(c)) {
          queuePlayFlight(c.instanceId);
          onPlay(c);
        }
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
      : html`<div className="hand-tab">Your hand · ${cards.length}${interactive ? ' — click to view, drag up to play' : ' — click to view'}</div>`}
    <div className="hand-fan" ref=${fanRef}>
      ${cards.length === 0
        ? html`<span className="empty-hand">no cards in hand</span>`
        : cards.map(
            (c, i) => html`<div
              className=${`rail-card card--${cardKind(c)} ${cardArt(c) ? 'has-art' : ''} ${drag?.id === c.instanceId ? `is-drag ${drag.mode}` : ''} ${
                shifts(c, i) ? 'shift' : ''
              } ${flyingIds?.has(c.instanceId) ? 'flight-hidden' : ''}`}
              key=${c.instanceId}
              ref=${regFlightEl('hand', c.instanceId)}
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
 * piece clickable; Mini Rocket and Cow Wrangler make the rocket's cows
 * clickable (v2 §1.3 — Cow Wrangler moved here from its old popup; the
 * payload it sends is unchanged, just sourced from a zone click now).
 */
function LaunchPad({ p, zone, onZonePick }) {
  const r = p.rocket;
  const order = { bottom: 0, middle: 1, top: 2 };
  const sorted = [...r.pieces].sort((a, b) => (order[pieceInfo(a).part] ?? 3) - (order[pieceInfo(b).part] ?? 3));
  const topFirst = [...sorted].reverse(); // rocket top sits highest on screen
  const steal = zone && zone.effect === 'stealRocketPiece' && !p.inactive && r.pieces.length > 0;
  const miniRocketCow = zone && zone.effect === 'moveCowToMoon' && !p.inactive && r.cows > 0;
  const wranglerCow = zone && zone.effect === 'returnRocketCowsToFarm' && !p.inactive && r.cows > 0;
  const rocketCow = miniRocketCow || wranglerCow;
  const rocketCowPick = () =>
    onZonePick(miniRocketCow ? { targetPlayerId: p.id, from: 'rocket' } : { targetPlayerId: p.id });

  // Pick up and move pieces freely for the tabletop feel — a little assemble-
  // the-rocket mini-game. Works any time (other players' turns, the draw
  // step). Disabled only while Rocket Thief targeting is active (there a
  // click steals the piece). `offsets` is keyed by piece instanceId, so it's
  // per-piece and per-player.
  //
  // Magnetic connector snapping (v2 §1.6), replacing the old fixed-slot snap:
  // a `bottom` part has only a top-connector, a `top` part only a
  // bottom-connector, a `middle` has both, and a wild piece exposes both and
  // mates with whichever compatible neighbor it's dropped near first.
  // `links[id] = { top, bottom }` tracks which neighbor (if any) occupies
  // each connector, so a connector already in use isn't offered twice. This
  // is 100% cosmetic (§0/§1.6) — it only ever touches `offsets`/`links`
  // local state, never anything the engine reads for rocketComplete/launch.
  const [offsets, setOffsets] = useState({});
  const [links, setLinks] = useState({}); // instanceId -> { top: id|null, bottom: id|null }
  const [dragId, setDragId] = useState(null);
  const padRef = useRef(null);
  const pieceElsRef = useRef(new Map()); // instanceId -> DOM el, for live snap measurement
  const regPieceEl = (id) => (el) => {
    if (el) pieceElsRef.current.set(id, el);
    else pieceElsRef.current.delete(id);
  };

  /** A piece's open connector sides, by rocket part. Wild ('any') exposes both. */
  const connectorsOf = (pc) => {
    const part = pieceInfo(pc).part;
    if (part === 'bottom') return { top: true, bottom: false };
    if (part === 'top') return { top: false, bottom: true };
    return { top: true, bottom: true }; // 'middle' and wild/'any' alike
  };

  /** Free `id` from whatever neighbor(s) it was linked to (both sides). */
  const unlink = (id, from) => {
    const mine = from[id];
    const next = { ...from, [id]: { top: null, bottom: null } };
    if (mine?.top && next[mine.top]) next[mine.top] = { ...next[mine.top], bottom: null };
    if (mine?.bottom && next[mine.bottom]) next[mine.bottom] = { ...next[mine.bottom], top: null };
    return next;
  };

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

      if (outsideArea(padRef, ev)) {
        setOffsets((o) => ({ ...o, [id]: { dx: 0, dy: 0 } })); // dropped outside the pad entirely: home
        setLinks((l) => unlink(id, l));
        return;
      }

      setLinks((prevLinks) => {
        const freed = unlink(id, prevLinks); // this piece's own old links don't block a re-snap to the same spot
        const el = pieceElsRef.current.get(id);
        const myConn = connectorsOf(pc);
        let best = null; // { neighborId, mySide, theirSide, dist, myRect, neighborRect, scale }

        if (el) {
          const myRect = el.getBoundingClientRect();
          const scale = el.offsetWidth > 0 ? myRect.width / el.offsetWidth : 1; // local→screen, self-calibrating (captures zoom + 3D foreshortening)
          const radiusScreen = PIECE_SNAP_RADIUS_PX * scale;
          const myCenterX = myRect.left + myRect.width / 2;

          for (const other of r.pieces) {
            if (other.instanceId === id) continue;
            const oEl = pieceElsRef.current.get(other.instanceId);
            if (!oEl) continue;
            const oRect = oEl.getBoundingClientRect();
            const oConn = connectorsOf(other);
            const oLinks = freed[other.instanceId] || { top: null, bottom: null };
            const oCenterX = oRect.left + oRect.width / 2;

            // my bottom-connector ↔ their top-connector: I sit just above them.
            if (myConn.bottom && oConn.top && !oLinks.top) {
              const dist = Math.hypot(myCenterX - oCenterX, myRect.top + myRect.height - oRect.top);
              if (dist < radiusScreen && (!best || dist < best.dist)) {
                best = { neighborId: other.instanceId, mySide: 'bottom', theirSide: 'top', dist, myRect, oRect, scale };
              }
            }
            // my top-connector ↔ their bottom-connector: I sit just below them.
            if (myConn.top && oConn.bottom && !oLinks.bottom) {
              const dist = Math.hypot(myCenterX - oCenterX, myRect.top - (oRect.top + oRect.height));
              if (dist < radiusScreen && (!best || dist < best.dist)) {
                best = { neighborId: other.instanceId, mySide: 'top', theirSide: 'bottom', dist, myRect, oRect, scale };
              }
            }
          }
        }

        if (!best) {
          return freed; // no compatible neighbor in range — stays exactly where released
        }

        // Snap flush against the neighbor's opposite edge, same horizontal
        // centre — computed in screen space, then converted back to local
        // offset units via the same self-calibrating scale.
        const targetCenterX = best.oRect.left + best.oRect.width / 2;
        const targetTop = best.mySide === 'bottom' ? best.oRect.top - best.myRect.height : best.oRect.top + best.oRect.height;
        const screenDx = targetCenterX - (best.myRect.left + best.myRect.width / 2);
        const screenDy = targetTop - best.myRect.top;
        setOffsets((o) => {
          const cur = o[id] || { dx: 0, dy: 0 };
          return { ...o, [id]: { dx: cur.dx + screenDx / best.scale, dy: cur.dy + screenDy / best.scale } };
        });

        const next = { ...freed };
        next[id] = { ...next[id], [best.mySide]: best.neighborId };
        next[best.neighborId] = { ...next[best.neighborId], [best.theirSide]: id };
        return next;
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
                ref=${regPieceEl(pc.instanceId)}
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
            onClick=${rocketCow ? rocketCowPick : undefined}
          >
            <${Tokens} key=${p.id} n=${r.cows} color=${playerColor(p.id)} cap=${r.capacity} draggable=${!rocketCow} areaRef=${padRef} />
          </div>
        </div>`}
    ${r.pieces.length > 0
      ? html`<div className="rocket-count">
          <small>${r.cows}/${r.capacity}${r.complete ? ' • ready' : ''}${
            miniRocketCow ? ' — click a cow to send' : wranglerCow ? ' — click to send these home' : ''
          }</small>
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
 * The moon: a disc with every landed cow as a coloured token, plus the count.
 * During a Space Cowboy play (v2 §1.3 — moved here from its old popup, same
 * payload), each player's own cluster of moon tokens becomes its own
 * clickable/targetable zone, since the moon is one shared hub component
 * rather than per-seat.
 */
function MoonDisc({ g, zone, onZonePick }) {
  const onMoon = g.players.filter((pp) => pp.moon > 0);
  const total = onMoon.reduce((s, pp) => s + pp.moon, 0);
  const moonImg = boardArt('moon');
  const moonTarget = zone && zone.effect === 'moveCowMoonToFarm';
  return html`<div className=${`moon-disc ${moonImg ? 'moon-art' : ''}`} style=${bgImage(moonImg)}>
    <span className="moon-label">Moon</span>
    <div className="moon-tokens">
      ${onMoon.map((pp) => {
        const targetable = moonTarget && !pp.inactive;
        return html`<span
          key=${pp.id}
          className=${`moon-group ${targetable ? 'targetable' : ''}`}
          onClick=${targetable ? () => onZonePick({ targetPlayerId: pp.id }) : undefined}
        >
          ${Array.from(
            { length: pp.moon },
            (_, i) => html`<span className="cow-token" key=${pp.id + i} style=${{ background: playerColor(pp.id) }}></span>`,
          )}
        </span>`;
      })}
    </div>
    <span className="moon-n">${total} cow${total === 1 ? '' : 's'}</span>
  </div>`;
}

/**
 * The 3D table scene (redesign v2 §1.1–§1.2): a viewport → camera → disc,
 * with the shared piles in a flat hub at the centre and one seat per
 * connected player arranged radially around the rim. Every seat renders that
 * player's EXISTING LaunchPad + Farm components, untouched — this is a new
 * outer positioning layer wrapped around unchanged inner components (§0),
 * not new game-view components. Seat 0 is always "you" (players list rotated
 * so your own seat lands at yaw 0 by default — you start facing your own
 * zone, matching the pre-redesign default "Your area" view).
 *
 * Camera controls: drag the disc's own rim/felt to rotate (never a card,
 * piece, or token — gesture ownership is enforced by only starting a rotate
 * when the pointerdown's real target is the disc element itself, which
 * survives event bubbling since `e.target` doesn't change as the event
 * bubbles up through seats/hub to the disc's listener); Left/Right arrow
 * keys rotate the same yaw state; wheel/pinch and the corner +/− buttons
 * zoom. Rotate and drag-zoom are instant (no transition, matching the
 * existing "no transition while dragging" rule); button zoom gets a very
 * short eased transition (§8).
 *
 * On your draw phase the deck and store cards in the hub are clickable to
 * draw; on your action phase your own seat's farm is clickable to herd.
 */
function Table({ g, you, myTurn, myActionPhase, zone, onZonePick, camera, setCamera, discardFlight }) {
  const players = g.players;
  const n = players.length;
  const selfIdx = Math.max(0, players.findIndex((pp) => pp.id === g.you));
  const seated = [...players.slice(selfIdx), ...players.slice(0, selfIdx)];

  const discRef = useRef(null);
  const cameraElRef = useRef(null);
  const rotateRef = useRef(null); // { startX, startYaw } while a rim-drag is live
  // Camera moves triggered WITHOUT a drag (button zoom, the auto-face-target
  // assist below, and the camera intro below) get an eased transition;
  // direct manipulation (rim-drag, arrow keys, wheel/pinch) stays instant —
  // §1.2's transition policy. easeMs=0 means "no transition" (CSS default).
  const [easeMs, setEaseMs] = useState(0);
  const easeTimer = useRef(null);
  const easedSetCamera = (updater, duration) => {
    setEaseMs(duration);
    setCamera(updater);
    clearTimeout(easeTimer.current);
    easeTimer.current = setTimeout(() => setEaseMs(0), duration);
  };

  // Rotate: pointerdown MUST land on the disc's own background — never a
  // seat's card/piece/token/farm — so a table-drag never steals a game-piece
  // drag, and vice versa (v2 §1.2, §11 acceptance #2).
  const onDiscPointerDown = (e) => {
    if (e.button !== 0 || e.target !== discRef.current) return;
    e.preventDefault();
    rotateRef.current = { startX: e.clientX, startYaw: camera.yaw };
    const move = (ev) => {
      const r = rotateRef.current;
      if (!r) return;
      setCamera((c) => ({ ...c, yaw: wrapYaw(r.startYaw - (ev.clientX - r.startX) * CAMERA_ROTATE_SENSITIVITY) }));
    };
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      rotateRef.current = null;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  };

  // Arrow-key rotate — replaces the old ◀▶ cycle buttons entirely (§1.7).
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return; // don't hijack typing
      e.preventDefault();
      const dir = e.key === 'ArrowLeft' ? -1 : 1;
      setCamera((c) => ({ ...c, yaw: wrapYaw(c.yaw + dir * CAMERA_YAW_STEP) }));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setCamera]);

  // Camera intro (v2 §1.4): the moment the in-game table scene mounts (a
  // game starting or being rejoined), swoop the camera in from a wider,
  // off-axis framing to the resolved default rather than cutting straight to
  // it — the one camera move here that isn't under the player's hand besides
  // the auto-face-target assist above. Interpretation note: the menu's own
  // idling disc (MenuTable) is a separate, simpler DOM element with no game
  // content, so this can't hand off from its exact live spin position
  // without keeping one persistent camera element mounted across screens; it
  // swoops in from a fixed wide/rotated starting framing instead, which reads
  // the same "arriving at the table" way without that added complexity —
  // flagged here for a live check, since camera feel can't be verified in
  // this sandbox (no browser).
  useEffect(() => {
    const el = cameraElRef.current;
    if (!el || typeof el.animate !== 'function') return;
    if (prefersReducedMotion()) return; // cut straight in, no intro (§8)
    const to = `translateZ(-${CAMERA_BASE_DISTANCE}px) rotateX(${camera.pitch}deg) rotateY(${camera.yaw}deg)`;
    const from = `translateZ(-${CAMERA_BASE_DISTANCE * 1.35}px) rotateX(${camera.pitch}deg) rotateY(${wrapYaw(camera.yaw - 55)}deg)`;
    el.animate([{ transform: from }, { transform: to }], { duration: 1000, easing: 'ease-in-out' });
    // Mount-only: this is a one-shot entrance, not something that should
    // replay on every camera.yaw/pitch change while already in-game.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Zoom: wheel/pinch (instant) — trackpad pinch reaches the browser as a
  // wheel event (often with ctrlKey set), so one handler covers both.
  const onWheelZoom = (e) => {
    e.preventDefault();
    setCamera((c) => ({ ...c, zoom: clamp(c.zoom - e.deltaY * 0.0015, CAMERA_ZOOM_MIN, CAMERA_ZOOM_MAX) }));
  };
  // Zoom buttons (touch/accessibility, since not every device has a wheel) —
  // these get a brief eased transition rather than an instant jump (§8).
  const zoomByButton = (delta) =>
    easedSetCamera((c) => ({ ...c, zoom: clamp(c.zoom + delta, CAMERA_ZOOM_MIN, CAMERA_ZOOM_MAX) }), 80);

  // Auto-face-target (v2 §1.3): the moment a zone-targeting mode opens, if
  // the FIRST legal target's seat isn't already facing the camera, ease-
  // rotate to it — reaching a target that lives at another yaw angle
  // shouldn't mean "guess which way to spin, blind." Targets beyond the
  // first are reached by the player's own drag/arrow-key rotation once
  // there, same as any other seat.
  useEffect(() => {
    if (!zone) return;
    const legal = (pp) => {
      if (pp.inactive) return false;
      switch (zone.effect) {
        case 'stealRocketPiece':
          return pp.rocket.pieces.length > 0;
        case 'moveCowToMoon':
          return pp.farm > 0 || pp.rocket.cows > 0;
        case 'returnRocketCowsToFarm':
          return pp.rocket.cows > 0;
        case 'moveCowMoonToFarm':
          return pp.moon > 0;
        case 'swapHands':
          return pp.id !== g.you; // trading with yourself isn't offered
        default:
          return false;
      }
    };
    const idx = seated.findIndex(legal);
    if (idx < 0) return;
    const seatAngle = seatAngleFor(idx, n);
    const needed = wrapYaw(-seatAngle);
    const delta = Math.min(wrapYaw(needed - camera.yaw), wrapYaw(camera.yaw - needed));
    if (delta < 1) return; // already on screen — no unnecessary camera move
    // Reduced motion: still move to face the target (the player still needs
    // to see it), just as an instant cut rather than an eased pan (§8).
    if (prefersReducedMotion()) setCamera((c) => ({ ...c, yaw: needed }));
    else easedSetCamera((c) => ({ ...c, yaw: needed }), 500);
    // Re-run only when the targeting card itself changes (opens/closes), not
    // on every render while it stays open — camera.yaw is deliberately
    // excluded so the player's own subsequent rotation isn't fought.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zone?.instanceId]);

  const myDrawPhase = myTurn && !g.pending && g.turn.phase === 'draw';
  const emptyHand = (you?.hand?.length ?? 0) === 0;
  const need = g.turn.drawsRemaining ?? g.drawsPerTurn; // draws left this phase (server-tracked)
  // Each pick is sent on its own, so the drawn card lands in your hand before
  // the next pick — the server reveals deck draws one at a time.
  const doPick = (pick) => {
    if (!myDrawPhase) return;
    if (!emptyHand) queueDrawFlight(pick); // fresh-hand draws don't land in the rail one at a time
    send({ type: 'drawCards', picks: emptyHand ? [] : [pick] });
  };
  const deckDisabled =
    !myDrawPhase ||
    (!emptyHand && g.deckCount === 0 && g.discard.length === 0 && g.rocketStore.length >= need);
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
    <div className="table-viewport" onWheel=${onWheelZoom}>
      <div
        className="table-camera"
        ref=${cameraElRef}
        style=${{
          '--camera-yaw': `${camera.yaw}deg`,
          '--camera-pitch': `${camera.pitch}deg`,
          '--camera-z': `calc(-${CAMERA_BASE_DISTANCE}px / ${camera.zoom})`,
          '--camera-ease-ms': `${easeMs}ms`,
        }}
      >
        <div className="table-disc" ref=${discRef} onPointerDown=${onDiscPointerDown}>
          <!-- felt/wood visual surface only — see the CSS rule for why this
               is a separate element from .table-disc itself (spin-axis fix). -->
          <div className="table-surface"></div>

          <!-- centre hub: moon, deck/discard, rocket store — shared by all seats -->
          <div className="table-hub">
            <${MoonDisc} g=${g} zone=${zone} onZonePick=${onZonePick} />
            <div className="piles">
              <button
                className=${`pile deck-pile ${myDrawPhase && !deckDisabled ? 'drawable' : ''}`}
                disabled=${deckDisabled}
                onClick=${() => doPick({ source: 'deck' })}
              >
                <span className="pile-visual" ref=${regFlightEl('deck')}>
                  <span className="pile-back" style=${bgImage(boardArt('back'))}></span>
                </span>
                <span className="pile-cap">Deck · ${g.deckCount}</span>
              </button>
              <div className="pile discard-pile">
                <span className="pile-visual" ref=${regFlightEl('discard')}>
                  ${topDiscard
                    ? html`<span
                        className=${`pile-face card--${cardKind(topDiscard)} ${discardFlight ? 'flight-hidden' : ''}`}
                        style=${cardArt(topDiscard)
                          ? { ...bgImage(cardArt(topDiscard)), color: 'transparent', borderTopColor: 'transparent' }
                          : undefined}
                      >${topDiscard.name}</span>`
                    : html`<span className="pile-empty">empty</span>`}
                </span>
                <span className="pile-cap">Discard · ${g.discard.length}</span>
              </div>
            </div>
            <div className="store">
              <div className="store-cards2">
                ${g.rocketStore.length
                  ? g.rocketStore.map(
                      (c) => html`<button
                        key=${c.instanceId}
                        ref=${regFlightEl('store', c.instanceId)}
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
          </div>

          <!-- one seat per player, fanned across one arc of the near face
               (seatAngleFor), with the players list rotated above so your own
               seat is always i=0 (yaw 0, dead centre). -->
          ${seated.map((p, i) => {
            const seatAngle = seatAngleFor(i, n);
            const isSelf = p.id === g.you;
            const canHerd =
              isSelf && myActionPhase && p.farm > 0 && p.rocket.pieces.length > 0 && p.rocket.cows < p.rocket.capacity;
            // Wind (swapHands) targets a whole player, not a specific farm/
            // rocket/moon spot — the zone for "this player" is their own
            // area-title header (v2 §1.3, same payload the old popup sent).
            const swapTarget = zone && zone.effect === 'swapHands' && !isSelf && !p.inactive;
            return html`<div
              className="seat"
              key=${p.id}
              data-seat=${i}
              style=${{ transform: `rotateY(${seatAngle}deg) translateZ(var(--disc-radius))` }}
            >
              <div className="seat-inner" style=${{ '--pcolor': playerColor(p.id) }}>
                <div className="pad-column">
                  <${LaunchPad} p=${p} zone=${zone} onZonePick=${onZonePick} />
                </div>
                <div className="play-row">
                  <div className="player-area">
                    <div
                      className=${`area-title ${swapTarget ? 'targetable' : ''}`}
                      onClick=${swapTarget ? () => onZonePick({ targetPlayerId: p.id }) : undefined}
                    >
                      ${isSelf ? 'Your area' : `${p.name}'s area`}${!p.connected ? ' · off' : ''}${p.inactive ? ' · idle' : ''}
                      <small> · ${p.handCount} in hand · ${p.moon}/10 on moon</small>
                      ${swapTarget ? html`<small className="farm-hint"> · click to trade hands</small>` : ''}
                    </div>
                    <${Farm} p=${p} canHerd=${canHerd} zone=${zone} onZonePick=${onZonePick} />
                  </div>
                </div>
              </div>
            </div>`;
          })}

        </div>
      </div>
      <!-- zoom controls: touch/accessibility fallback for wheel/pinch (§1.2) -->
      <div className="camera-zoom">
        <button className="subtle" onClick=${() => zoomByButton(-CAMERA_ZOOM_STEP)} aria-label="Zoom out">−</button>
        <button className="subtle" onClick=${() => zoomByButton(CAMERA_ZOOM_STEP)} aria-label="Zoom in">+</button>
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
        message: 'Your rocket needs a bottom, a middle and a top before it can launch. 🚀',
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

function TargetPicker({ g, you, card, done }) {
  const playWith = (params) => {
    send({ type: 'playCard', cardInstanceId: card.instanceId, params });
    done();
  };
  // Inactive players can't be targeted (Decision #6), so don't offer them.
  const targetable = g.players.filter((p) => !p.inactive);
  const others = targetable.filter((p) => p.id !== you.id);
  let options = null;

  if (card.effect === 'swapHands') {
    options = others.map(
      (p) => html`<button key=${p.id} onClick=${() => playWith({ targetPlayerId: p.id })}>Trade hands with ${p.name}</button>`,
    );
  } else if (card.effect === 'moveCowMoonToFarm') {
    options = targetable
      .filter((p) => p.moon > 0)
      .map((p) => html`<button key=${p.id} onClick=${() => playWith({ targetPlayerId: p.id })}>Return one of ${p.name}'s moon cows</button>`);
  } else if (card.effect === 'returnRocketCowsToFarm') {
    options = targetable
      .filter((p) => p.rocket.cows > 0)
      .map((p) => html`<button key=${p.id} onClick=${() => playWith({ targetPlayerId: p.id })}>Wrangle ${p.name}'s rocket cows</button>`);
  } else if (card.effect === 'moveCowToMoon') {
    options = targetable.flatMap((p) => [
      p.farm > 0 &&
        html`<button key=${p.id + 'f'} onClick=${() => playWith({ targetPlayerId: p.id, from: 'farm' })}>
          Send a cow from ${p.name}'s farm
        </button>`,
      p.rocket.cows > 0 &&
        html`<button key=${p.id + 'r'} onClick=${() => playWith({ targetPlayerId: p.id, from: 'rocket' })}>
          Send a cow from ${p.name}'s rocket
        </button>`,
    ]);
  } else if (card.effect === 'stealRocketPiece') {
    options = targetable.flatMap((p) =>
      p.rocket.pieces.map(
        (piece) => html`<button
          key=${piece.instanceId}
          onClick=${() => playWith({ targetPlayerId: p.id, pieceInstanceId: piece.instanceId })}
        >
          Steal ${p.name}'s ${piece.name}
        </button>`,
      ),
    );
  }

  return html`<div className="prompt">
    <p><b>${card.name}:</b> choose a target.</p>
    <div className="choices">
      ${options}
      <button onClick=${() => playWith({})}>Target no one</button>
      <button className="subtle" onClick=${done}>Cancel</button>
    </div>
  </div>`;
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
    case 'gameStarted': return '🎬 Game started.';
    case 'turnStarted': return `▶️ ${who(e.playerId)}'s turn.`;
    case 'drew': return `🃏 ${who(e.playerId)} drew ${e.picks?.length ?? ''} card(s).`;
    case 'drewEmptyHand': return `🃏 ${who(e.playerId)} drew a fresh ${e.drawn}.`;
    case 'herded': return `🐄 ${who(e.playerId)} herded a cow into their rocket.`;
    case 'cowsMovedToRocket': return `🐄💨 ${who(e.playerId)} moved ${e.moved} cow(s) into their rocket.`;
    case 'rocketPiecePlayed': return `🚀 ${who(e.playerId)} added a rocket piece.`;
    case 'rocketLaunched': return `🚀🌙 ${who(e.playerId)} launched with ${e.cows} cow(s)!`;
    case 'recycled': return `♻️ ${who(e.playerId)} recycled a card.`;
    case 'passedAction': return `😴 ${who(e.playerId)} did nothing.`;
    case 'turnEnded': return `⏹️ ${who(e.playerId)} ended their turn.`;
    case 'turnSkipped': return `⏭️ ${who(e.playerId)}'s turn was skipped (idle).`;
    case 'turnAutoEnded': return `⏹️ ${who(e.playerId)}'s turn auto-ended.`;
    case 'turnPassedOver': return `⤵️ ${who(e.playerId)} was passed over (inactive).`;
    case 'playerWentInactive': return `💤 ${who(e.playerId)} is now inactive.`;
    case 'playerReturned': return `👋 ${who(e.playerId)} is back.`;
    case 'eventPlayed': return `✨ ${who(e.playerId)} played an event card.`;
    case 'cownterPlayed': return `🛑 ${who(e.playerId)} played a Cownter!`;
    case 'respondedPass': return `➡️ ${who(e.playerId)} passed.`;
    case 'eventCancelled': return '❌ An event was Cowntered.';
    case 'eventResolved': return '✅ An event resolved.';
    case 'cardEffectNotDefined': return '⚠️ A card had no defined effect.';
    case 'cowReturnedFromMoon': return `🌙↩️ A cow came back from the moon (${who(e.targetPlayerId)}).`;
    case 'cowLandedByMiniRocket': return `🌙 A cow landed on the moon (${who(e.targetPlayerId)}).`;
    case 'cowsWrangled': return `🤠 ${who(e.targetPlayerId)}'s ${e.count} rocket cow(s) went home.`;
    case 'rocketPieceStolen': return `🕵️ ${who(e.playerId)} stole a rocket piece from ${who(e.targetPlayerId)}${e.cowsReturned ? ` (${e.cowsReturned} cow(s) returned)` : ''}.`;
    case 'badWeatherStarted': return `⛈ ${who(e.playerId)} brought Bad Weather.`;
    case 'handsSwapped': return `🔄 ${who(e.playerId)} swapped hands with ${who(e.targetPlayerId)}.`;
    case 'deckReshuffled': return `🔀 Deck reshuffled (${e.cards} cards).`;
    case 'gameOver': return `🏆 ${who(e.winnerId)} wins!`;
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
