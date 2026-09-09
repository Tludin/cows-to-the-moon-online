// Phase 2 integration tests: real HTTP + WebSocket server, real client
// connections (Node's built-in WebSocket), full games played over the wire.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { startServer, type RunningServer } from '../server/server.ts';
import { TestClient } from './wsClient.ts';

let srv: RunningServer;

before(async () => {
  srv = await startServer({ port: 0 });
});
after(async () => {
  await srv.close();
});

/** Creates a room + joins `count - 1` more clients. Returns clients in seat order. */
async function makeRoom(count: number, seed?: number): Promise<TestClient[]> {
  const host = await TestClient.connect(srv.port, 'host');
  const m0 = host.mark();
  host.send({ type: 'createRoom', name: 'Player 1', ...(seed !== undefined ? { seed } : {}) });
  await host.waitForType(m0, 'roomCreated');

  const clients = [host];
  for (let i = 2; i <= count; i++) {
    const c = await TestClient.connect(srv.port, `p${i}`);
    const m = c.mark();
    c.send({ type: 'joinRoom', name: `Player ${i}`, code: host.roomCode });
    await c.waitForType(m, 'roomJoined');
    clients.push(c);
  }
  return clients;
}

async function startGame(clients: TestClient[]): Promise<void> {
  const marks = clients.map((c) => c.mark());
  clients[0]!.send({ type: 'startGame' });
  await Promise.all(clients.map((c, i) => c.waitForType(marks[i]!, 'gameStateUpdate')));
}

describe('http server', () => {
  it('serves the client and a health check', async () => {
    const health = await fetch(`http://127.0.0.1:${srv.port}/health`);
    assert.equal(health.status, 200);
    const index = await fetch(`http://127.0.0.1:${srv.port}/`);
    assert.match(await index.text(), /Cows To The Moon/);
    const app = await fetch(`http://127.0.0.1:${srv.port}/app.js`);
    assert.match(app.headers.get('content-type') ?? '', /javascript/);
    const missing = await fetch(`http://127.0.0.1:${srv.port}/nope.js`);
    assert.equal(missing.status, 404);
  });

  it('refuses paths that escape the client directory', async () => {
    // fetch() normalizes "..", so send the raw path with node:http.
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port: srv.port, path: '/../package.json' },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 403);
  });
});

describe('lobby flow', () => {
  it('creates a room with a well-formed code and joins by code', async () => {
    const [host, guest] = await makeRoom(2);
    assert.match(host.roomCode!, /^[A-HJ-NP-Z2-9]{5}$/); // no 0/O/1/I (spec 7.4)
    assert.equal(host.playerId, 'p1');
    assert.equal(guest!.playerId, 'p2');
    // Both got a roomUpdate listing both players.
    const update = await host.waitFor(0, (m) => m.type === 'roomUpdate' && (m.players as unknown[]).length === 2);
    assert.deepEqual(
      (update.players as { name: string }[]).map((p) => p.name),
      ['Player 1', 'Player 2'],
    );
    host.close();
    guest!.close();
  });

  it('rejects bad codes, non-host starts, and undersized games', async () => {
    const solo = await TestClient.connect(srv.port, 'solo');
    let m = solo.mark();
    solo.send({ type: 'joinRoom', name: 'X', code: 'ZZZZZ' });
    assert.equal((await solo.waitForType(m, 'errorMessage')).code, 'noSuchRoom');

    m = solo.mark();
    solo.send({ type: 'createRoom', name: 'Solo' });
    await solo.waitForType(m, 'roomCreated');
    m = solo.mark();
    solo.send({ type: 'startGame' });
    assert.equal((await solo.waitForType(m, 'errorMessage')).code, 'notEnoughPlayers');
    solo.close();

    const [host, guest] = await makeRoom(2);
    const gm = guest!.mark();
    guest!.send({ type: 'startGame' });
    assert.equal((await guest!.waitForType(gm, 'errorMessage')).code, 'notHost');
    host.close();
    guest!.close();
  });

  it('rejects joining a full or already-started room', async () => {
    const clients = await makeRoom(4);
    const extra = await TestClient.connect(srv.port, 'extra');
    let m = extra.mark();
    extra.send({ type: 'joinRoom', name: 'Late', code: clients[0]!.roomCode });
    assert.equal((await extra.waitForType(m, 'errorMessage')).code, 'roomFull');

    const [host2, guest2] = await makeRoom(2);
    await startGame([host2, guest2!]);
    m = extra.mark();
    extra.send({ type: 'joinRoom', name: 'Late', code: host2.roomCode });
    assert.equal((await extra.waitForType(m, 'errorMessage')).code, 'alreadyStarted');

    [...clients, extra, host2, guest2!].forEach((c) => c.close());
  });

  it('promotes a new host when the host leaves the lobby', async () => {
    const [host, guest] = await makeRoom(2);
    host.close();
    // Match on the post-disconnect shape (1 player), not just "the next
    // roomUpdate": the join broadcast that seated the guest can still be
    // in flight to the guest's socket at this point, and a plain "first
    // roomUpdate after now" wait can catch that stale 2-player one instead.
    const update = await guest!.waitFor(0, (msg) => msg.type === 'roomUpdate' && (msg.players as unknown[]).length === 1);
    assert.equal(update.hostId, 'p1'); // guest was re-seated as p1 and is now host
    guest!.close();
  });
});

describe('hidden information (spec 7.3)', () => {
  it('each player sees their own hand, only counts for others, and no RNG state', async () => {
    const clients = await makeRoom(3, 123);
    await startGame(clients);
    for (const c of clients) {
      const view = c.lastView as any;
      assert.equal(view.you, c.playerId);
      for (const p of view.players) {
        assert.equal(p.handCount, 5);
        if (p.id === c.playerId) {
          assert.equal(p.hand.length, 5);
          assert.ok(p.hand[0].name); // enriched with card defs
        } else {
          assert.equal(p.hand, undefined); // never leaked
        }
      }
      assert.equal(view.rngState, undefined);
      assert.equal(view.deck, undefined);
      assert.equal(view.deckCount, 44 - 15 - 4);
      assert.equal(view.rocketStore.length, 4);
    }
    clients.forEach((c) => c.close());
  });

  it('rejects out-of-turn actions over the wire', async () => {
    const clients = await makeRoom(2, 5);
    await startGame(clients);
    const res = await clients[1]!.action({ type: 'drawCards', picks: [{ source: 'deck' }, { source: 'deck' }] });
    assert.equal(res.type, 'errorMessage');
    assert.equal(res.code, 'invalidAction');
    clients.forEach((c) => c.close());
  });
});

// ------------------------------------------------------- full games (bots)

/** Plays one full game over the wire with simple bots. Returns the winner id. */
async function playFullGame(playerCount: number, seed: number): Promise<string> {
  const clients = await makeRoom(playerCount, seed);
  try {
    await startGame(clients);
    return await runBots(clients);
  } finally {
    clients.forEach((c) => c.close());
  }
}

async function runBots(clients: TestClient[]): Promise<string> {
  const byId = new Map(clients.map((c) => [c.playerId!, c]));

  // Sends one action from `actor` and, on success, waits for EVERY client to
  // have processed the resulting broadcast — not just the actor. `actor
  // .action()` alone only awaits the actor's own socket, so the loop's shared
  // reference point (clients[0]'s lastView, read every iteration below) could
  // still be one broadcast stale when the actor isn't clients[0]. That race
  // let the harness pick the wrong "current" player and misreport a real
  // player's turn as having no legal action.
  async function actAndSync(actor: TestClient, msg: Record<string, unknown>): Promise<ServerMsg> {
    const marks = clients.map((c) => c.mark());
    const res = await actor.action(msg);
    if (res.type === 'gameStateUpdate') {
      await Promise.all(clients.map((c, i) => c.waitForType(marks[i]!, 'gameStateUpdate')));
    }
    return res;
  }

  for (let step = 0; step < 6000; step++) {
    if (clients.every((c) => c.gameOver)) break;
    const view = clients[0]!.lastView as any;

    if (view.pending) {
      // Everyone always passes on Cownter opportunities.
      const responder = byId.get(view.pending.toRespond[0])!;
      const res = await actAndSync(responder, { type: 'respondToPending', response: 'pass' });
      assert.notEqual(res.type, 'errorMessage', `respond failed: ${res.text}`);
      continue;
    }

    if (view.status === 'ended') break;
    const actor = byId.get(view.turn.currentPlayerId)!;
    const me = (actor.lastView as any).players.find((p: any) => p.id === actor.playerId);

    if (view.turn.phase === 'draw') {
      const picks = me.hand.length === 0 ? [] : [{ source: 'deck' }, { source: 'deck' }];
      const res = await actAndSync(actor, { type: 'drawCards', picks });
      assert.notEqual(res.type, 'errorMessage', `draw failed: ${res.text}`);
      continue;
    }

    // Action phase: build -> launch -> herd -> speedy cows -> recycle -> pass.
    const candidates: Record<string, unknown>[] = [];
    for (const c of me.hand) {
      if (c.type === 'rocketPiece') candidates.push({ type: 'playCard', cardInstanceId: c.instanceId });
    }
    const launch = me.hand.find((c: any) => c.type === 'launch');
    if (launch) candidates.push({ type: 'playCard', cardInstanceId: launch.instanceId });
    candidates.push({ type: 'herd' });
    const ssc = me.hand.find((c: any) => c.cardId === 'super_speedy_cows');
    if (ssc) candidates.push({ type: 'playCard', cardInstanceId: ssc.instanceId });
    if (me.hand.length > 0) candidates.push({ type: 'recycle', cardInstanceId: me.hand[0].instanceId });
    candidates.push({ type: 'passAction' });
    candidates.push({ type: 'endTurn' }); // once actions run out

    let acted = false;
    for (const cand of candidates) {
      const res = await actAndSync(actor, cand);
      if (res.type === 'gameStateUpdate') {
        acted = true;
        break;
      }
    }
    assert.ok(acted, 'bot found no legal action');
  }

  // The broadcast may still be in flight for some clients: wait for it.
  await Promise.all(clients.map((c) => c.waitFor(0, (m) => m.type === 'gameOver')));

  // Every client saw the same winner, and the winner has all 10 cows up there.
  const winners = new Set(clients.map((c) => c.gameOver?.winnerId));
  assert.equal(winners.size, 1);
  const winnerId = [...winners][0] as string;
  assert.ok(winnerId, 'game never finished');
  const finalView = clients[0]!.lastView as any;
  assert.equal(finalView.players.find((p: any) => p.id === winnerId).moon, 10);
  return winnerId;
}

describe('full games over the wire (Phase 2 done-signal)', () => {
  it('2 players play to a win', async () => {
    await playFullGame(2, 2001);
  });
  it('3 players play to a win', async () => {
    await playFullGame(3, 3001);
  });
  it('4 players play to a win', async () => {
    await playFullGame(4, 4001);
  });
});
