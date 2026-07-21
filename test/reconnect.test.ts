// Phase 3 integration tests over real WebSockets: reconnection, the server
// timers (Cownter auto-pass, turn auto-skip), the whole-room inactivity
// timeout, and room cleanup. Timeouts are shrunk via the config override that
// startServer/RoomManager accept, so these run in milliseconds.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, type RunningServer } from '../server/server.ts';
import { TestClient, type ServerMsg } from './wsClient.ts';

/** Creates a room + joins a second client. Returns [host, guest]. */
async function makeStartedPair(srv: RunningServer, seed: number): Promise<[TestClient, TestClient]> {
  const host = await TestClient.connect(srv.port, 'host');
  let m = host.mark();
  host.send({ type: 'createRoom', name: 'Alice', seed });
  await host.waitForType(m, 'roomCreated');

  const guest = await TestClient.connect(srv.port, 'guest');
  m = guest.mark();
  guest.send({ type: 'joinRoom', name: 'Bob', code: host.roomCode });
  await guest.waitForType(m, 'roomJoined');

  const marks = [host.mark(), guest.mark()];
  host.send({ type: 'startGame' });
  await Promise.all([host, guest].map((c, i) => c.waitForType(marks[i]!, 'gameStateUpdate')));
  return [host, guest];
}

const playersOf = (m: ServerMsg) =>
  (m.state as { players: { id: string; connected: boolean; inactive: boolean }[] }).players;

describe('reconnection (spec 7.1 reconnect)', () => {
  let srv: RunningServer;
  before(async () => {
    srv = await startServer({ port: 0 }); // production timeouts: timers can't interfere
  });
  after(async () => {
    await srv.close();
  });

  it('a dropped player rejoins with their token and play continues', async () => {
    const [host, guest] = await makeStartedPair(srv, 28);
    const token = (guest.msgs.find((m) => m.type === 'roomJoined') as ServerMsg).reconnectToken;

    // Guest vanishes; host sees them disconnected.
    let m = host.mark();
    guest.close();
    const drop = await host.waitFor(m, (x) => x.type === 'gameStateUpdate' && !playersOf(x)[1]!.connected);
    assert.equal(playersOf(drop)[1]!.connected, false);

    // A fresh socket (same browser after a refresh) reconnects with the token.
    const back = await TestClient.connect(srv.port, 'guest-again');
    m = back.mark();
    const mHost = host.mark();
    back.send({ type: 'reconnect', roomCode: host.roomCode, reconnectToken: token });
    const rec = await back.waitForType(m, 'reconnected');
    assert.equal(rec.playerId, 'p2');
    assert.equal(rec.roomStatus, 'playing');

    // Both sides converge: guest has a scoped view again, host sees p2 connected.
    const view = await back.waitForType(m, 'gameStateUpdate');
    assert.equal((view.state as { you: string }).you, 'p2');
    await host.waitFor(mHost, (x) => x.type === 'gameStateUpdate' && playersOf(x)[1]!.connected);

    // The game is still playable: the current player acts without error.
    const turn = (view.state as { turn: { currentPlayerId: string } }).turn;
    const actor = turn.currentPlayerId === 'p1' ? host : back;
    const res = await actor.action({ type: 'drawCards', picks: [{ source: 'deck' }, { source: 'deck' }] });
    assert.equal(res.type, 'gameStateUpdate');

    host.close();
    back.close();
  });

  it('lobby names must be unique (name-based rejoin depends on it)', async () => {
    const host = await TestClient.connect(srv.port, 'host');
    let m = host.mark();
    host.send({ type: 'createRoom', name: 'Alice' });
    await host.waitForType(m, 'roomCreated');

    const dupe = await TestClient.connect(srv.port, 'dupe');
    m = dupe.mark();
    dupe.send({ type: 'joinRoom', name: 'alice', code: host.roomCode }); // case-insensitive
    assert.equal((await dupe.waitForType(m, 'errorMessage')).code, 'nameTaken');

    host.close();
    dupe.close();
  });

  it('a disconnected seat can be reclaimed by joining with the same name (Decision #17)', async () => {
    const [host, guest] = await makeStartedPair(srv, 30);
    let m = host.mark();
    guest.close();
    await host.waitFor(m, (x) => x.type === 'gameStateUpdate' && !playersOf(x)[1]!.connected);

    // Same code + same name (case-insensitive), no token: seat reclaimed.
    const back = await TestClient.connect(srv.port, 'guest-by-name');
    m = back.mark();
    back.send({ type: 'joinRoom', name: 'bob', code: host.roomCode });
    const rec = await back.waitForType(m, 'reconnected');
    assert.equal(rec.playerId, 'p2');
    const view = await back.waitForType(m, 'gameStateUpdate');
    assert.equal((view.state as { you: string }).you, 'p2');

    host.close();
    back.close();
  });

  it('a connected seat cannot be claimed by name, and wrong names are refused', async () => {
    const [host, guest] = await makeStartedPair(srv, 31);

    // Bob is still connected: joining as "Bob" must not hijack the seat.
    const imp = await TestClient.connect(srv.port, 'impostor');
    let m = imp.mark();
    imp.send({ type: 'joinRoom', name: 'Bob', code: host.roomCode });
    assert.equal((await imp.waitForType(m, 'errorMessage')).code, 'alreadyStarted');

    // And a name matching no seat is refused even after a disconnect.
    guest.close();
    const hm = host.mark();
    await host.waitFor(hm, (x) => x.type === 'gameStateUpdate' && !playersOf(x)[1]!.connected);
    m = imp.mark();
    imp.send({ type: 'joinRoom', name: 'Zed', code: host.roomCode });
    assert.equal((await imp.waitForType(m, 'errorMessage')).code, 'alreadyStarted');

    host.close();
    imp.close();
  });

  it('a replaced connection is told its seat was taken over', async () => {
    const [host, guest] = await makeStartedPair(srv, 32);
    const token = (guest.msgs.find((m) => m.type === 'roomJoined') as ServerMsg).reconnectToken;

    // Guest's tab is still open when the same person reconnects elsewhere.
    const elsewhere = await TestClient.connect(srv.port, 'guest-elsewhere');
    const gm = guest.mark();
    const em = elsewhere.mark();
    elsewhere.send({ type: 'reconnect', roomCode: host.roomCode, reconnectToken: token });
    await elsewhere.waitForType(em, 'reconnected');
    await guest.waitForType(gm, 'seatTakenOver'); // old tab stands down

    host.close();
    guest.close();
    elsewhere.close();
  });

  it('a bad token is rejected', async () => {
    const [host, guest] = await makeStartedPair(srv, 29);
    const stranger = await TestClient.connect(srv.port, 'stranger');
    const m = stranger.mark();
    stranger.send({ type: 'reconnect', roomCode: host.roomCode, reconnectToken: 'nope' });
    const err = await stranger.waitForType(m, 'errorMessage');
    assert.equal(err.code, 'reconnectFailed');
    host.close();
    guest.close();
    stranger.close();
  });
});

describe('turn auto-skip and AFK marking (Decisions #14/#15)', () => {
  let srv: RunningServer;
  before(async () => {
    srv = await startServer({
      port: 0,
      config: { turnInactivityTimeoutSeconds: 0.08, roomInactivityWarningMinutes: 10 },
    });
  });
  after(async () => {
    await srv.close();
  });

  it('idle turns are skipped until the player is marked inactive; imBack recovers', async () => {
    const [host, guest] = await makeStartedPair(srv, 28);

    // Nobody acts: p1's turns get skipped twice -> inactive (2-strike limit).
    const m = host.mark();
    await host.waitFor(
      m,
      (x) => x.type === 'gameStateUpdate' && playersOf(x)[0]!.inactive,
      6000,
    );

    // "I'm back!" reactivates them.
    const m2 = host.mark();
    host.send({ type: 'imBack' });
    const rec = await host.waitFor(m2, (x) => x.type === 'gameStateUpdate' && !playersOf(x)[0]!.inactive);
    assert.equal(playersOf(rec)[0]!.inactive, false);

    host.close();
    guest.close();
  });
});

describe('Cownter response auto-pass (spec 6.2 safety net)', () => {
  let srv: RunningServer;
  before(async () => {
    srv = await startServer({
      port: 0,
      config: {
        cownterResponseTimeoutSeconds: 0.08,
        turnInactivityTimeoutSeconds: 30,
        roomInactivityWarningMinutes: 10,
      },
    });
  });
  after(async () => {
    await srv.close();
  });

  it('an unanswered event card resolves after the timeout', async () => {
    // Seed 28: p1's opening hand holds Super Speedy Cows (verified in-game).
    const [host, guest] = await makeStartedPair(srv, 28);
    await host.action({ type: 'drawCards', picks: [{ source: 'deck' }, { source: 'deck' }] });

    const hand = (host.lastView as { players: { hand?: { cardId: string; instanceId: string }[] }[] })
      .players[0]!.hand!;
    const ssc = hand.find((c) => c.cardId === 'super_speedy_cows');
    assert.ok(ssc, 'seed 28 should give p1 Super Speedy Cows');

    const m = host.mark();
    host.send({ type: 'playCard', cardInstanceId: ssc.instanceId });
    await host.waitForType(m, 'pendingResponseOpened');
    // Guest never responds; the server passes for them and the event resolves.
    const resolved = await host.waitFor(
      m,
      (x) =>
        x.type === 'gameStateUpdate' &&
        (x.state as { pending: unknown }).pending === null &&
        (x.state as { log: { type: string }[] }).log.some((e) => e.type === 'eventResolved'),
      6000,
    );
    assert.ok(resolved);

    host.close();
    guest.close();
  });
});

describe('whole-room inactivity timeout (spec section 5)', () => {
  it('warns, then ends the room; reconnects are then refused; the sweeper purges it', async () => {
    const srv = await startServer({
      port: 0,
      config: {
        roomInactivityWarningMinutes: 0.003, // 180 ms
        roomInactivityGraceMinutes: 0.003,
        turnInactivityTimeoutSeconds: 30, // keep the turn timer out of the way
      },
    });
    try {
      const [host, guest] = await makeStartedPair(srv, 28);
      const token = (host.msgs.find((m) => m.type === 'roomCreated') as ServerMsg).reconnectToken;
      const code = host.roomCode!;

      const m = host.mark();
      await host.waitForType(m, 'inactivityWarning', 6000);
      await host.waitForType(m, 'roomTimedOut', 6000);

      // The dead room refuses reconnects…
      const late = await TestClient.connect(srv.port, 'late');
      const lm = late.mark();
      late.send({ type: 'reconnect', roomCode: code, reconnectToken: token });
      assert.equal((await late.waitForType(lm, 'errorMessage')).code, 'reconnectFailed');

      // …and the sweeper purges it once roomCleanupMinutes have passed.
      assert.ok(srv.rooms.getRoom(code));
      srv.rooms.sweep(Date.now() + 31 * 60_000);
      assert.equal(srv.rooms.getRoom(code), undefined);

      host.close();
      guest.close();
      late.close();
    } finally {
      await srv.close();
    }
  });

  it('the keep-alive button clears the warning', async () => {
    const srv = await startServer({
      port: 0,
      config: {
        roomInactivityWarningMinutes: 0.003,
        roomInactivityGraceMinutes: 10, // long grace: the warning must be cleared, not raced
        turnInactivityTimeoutSeconds: 30,
      },
    });
    try {
      const [host, guest] = await makeStartedPair(srv, 28);
      const m = host.mark();
      await host.waitForType(m, 'inactivityWarning', 6000);
      host.send({ type: 'keepAlive' });
      await host.waitForType(m, 'inactivityCleared', 6000);
      host.close();
      guest.close();
    } finally {
      await srv.close();
    }
  });
});
