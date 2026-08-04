// Observability tests: the metrics registry (unit) and the /health, /metrics,
// and counter wiring over a real server (integration). Metrics are a
// process-wide singleton, so integration assertions use BEFORE/AFTER deltas —
// never absolute values — to stay order-independent.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import * as metrics from '../server/metrics.ts';
import { startServer, type RunningServer } from '../server/server.ts';
import { TestClient } from './wsClient.ts';

// ------------------------------------------------------------------- unit

describe('metrics registry', () => {
  it('counters start at 0, increment by 1 or by N, and read back', () => {
    const name = 'test_unit_counter_total';
    assert.equal(metrics.counterValue(name), 0);
    metrics.inc(name);
    assert.equal(metrics.counterValue(name), 1);
    metrics.inc(name, 5);
    assert.equal(metrics.counterValue(name), 6);
  });

  it('gauges are evaluated fresh at snapshot time, not registration time', () => {
    let value = 1;
    metrics.gauge('test_unit_gauge', () => value);
    assert.equal(metrics.snapshot().test_unit_gauge, 1);
    value = 42; // registry stored the callback, not the number
    assert.equal(metrics.snapshot().test_unit_gauge, 42);
  });

  it('exports Prometheus text format with counter/gauge typing', () => {
    metrics.inc('test_prom_counter_total', 3);
    metrics.gauge('test_prom_gauge', () => 7);
    const text = metrics.toPrometheus();
    assert.match(text, /# TYPE test_prom_counter_total counter\ntest_prom_counter_total 3\n/);
    assert.match(text, /# TYPE test_prom_gauge gauge\ntest_prom_gauge 7\n/);
    assert.ok(text.endsWith('\n'), 'ends with a newline (exposition format)');
  });
});

// ------------------------------------------------------------ integration

let srv: RunningServer;

before(async () => {
  srv = await startServer({ port: 0 });
});
after(async () => {
  await srv.close();
});

/** Polls `pred` until true or timeout — for counters bumped by async close events. */
async function until(pred: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('health and metrics endpoints', () => {
  it('/health reports uptime, room count, and memory', async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/health`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.ok, true);
    assert.equal(typeof body.uptimeSeconds, 'number');
    assert.equal(body.rooms, srv.rooms.getRoomCount());
    assert.ok((body.memoryRssMb as number) > 0);
  });

  it('/metrics serves Prometheus text including live gauges', async () => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/metrics`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/plain/);
    const text = await res.text();
    assert.match(text, /# TYPE rooms_active gauge/);
    assert.match(text, /# TYPE players_connected gauge/);
  });
});

describe('counter and gauge wiring', () => {
  it('opening a connection and creating a room bump the counters and gauges', async () => {
    const opened = metrics.counterValue('ws_connections_opened_total');
    const created = metrics.counterValue('rooms_created_total');
    const roomsBefore = metrics.snapshot().rooms_active!;

    const host = await TestClient.connect(srv.port, 'host');
    const m = host.mark();
    host.send({ type: 'createRoom', name: 'Metrics Host' });
    await host.waitForType(m, 'roomCreated');

    assert.equal(metrics.counterValue('ws_connections_opened_total'), opened + 1);
    assert.equal(metrics.counterValue('rooms_created_total'), created + 1);
    assert.equal(metrics.snapshot().rooms_active, roomsBefore + 1);

    // The same numbers are visible over HTTP (what a scraper would see).
    const text = await (await fetch(`http://127.0.0.1:${srv.port}/metrics`)).text();
    assert.match(text, new RegExp(`^rooms_created_total ${created + 1}$`, 'm'));

    host.close();
    await until(() => metrics.snapshot().players_connected === 0);
  });

  it('closing a connection bumps the closed counter', async () => {
    const closed = metrics.counterValue('ws_connections_closed_total');
    const c = await TestClient.connect(srv.port, 'closer');
    c.close();
    await until(() => metrics.counterValue('ws_connections_closed_total') >= closed + 1);
  });

  it('a failed WebSocket handshake is counted and refused with 400', async () => {
    const failures = metrics.counterValue('ws_handshake_failures_total');
    // Upgrade request with no Sec-WebSocket-Key: acceptUpgrade must refuse it.
    const reply = await new Promise<string>((resolve, reject) => {
      const sock = connect(srv.port, '127.0.0.1', () => {
        sock.write(
          'GET / HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
        );
      });
      let data = '';
      sock.on('data', (b) => (data += b.toString()));
      sock.on('close', () => resolve(data));
      sock.on('error', reject);
      setTimeout(() => sock.destroy(), 2000).unref();
    });
    assert.match(reply, /400 Bad Request/);
    await until(() => metrics.counterValue('ws_handshake_failures_total') >= failures + 1);
  });

  it('a malformed frame (unmasked) is counted as a frame error', async () => {
    const frameErrors = metrics.counterValue('ws_frame_errors_total');
    // Complete a real handshake, then send an UNMASKED text frame — a
    // protocol violation (RFC 6455 §5.1) the server must reject.
    await new Promise<void>((resolve, reject) => {
      const sock = connect(srv.port, '127.0.0.1', () => {
        sock.write(
          'GET / HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n' +
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
        );
      });
      let shookHands = false;
      sock.on('data', (b) => {
        if (!shookHands && b.toString().includes('101 Switching Protocols')) {
          shookHands = true;
          // FIN + text opcode, mask bit CLEAR, 2-byte payload "hi".
          sock.write(Buffer.from([0x81, 0x02, 0x68, 0x69]));
        }
      });
      sock.on('close', () => resolve()); // server destroys the socket on the violation
      sock.on('error', reject);
      setTimeout(() => sock.destroy(), 2000).unref();
    });
    await until(() => metrics.counterValue('ws_frame_errors_total') >= frameErrors + 1);
  });
});
