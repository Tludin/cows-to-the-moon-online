// Test helper: a WebSocket client with message history and waitFor(), built
// on Node 22's built-in WebSocket. Used by the integration tests to act as a
// real browser would.

export interface ServerMsg {
  type: string;
  [k: string]: unknown;
}

export class TestClient {
  ws: WebSocket;
  name: string;
  msgs: ServerMsg[] = [];
  lastView: Record<string, unknown> | null = null;
  gameOver: ServerMsg | null = null;
  playerId: string | null = null;
  roomCode: string | null = null;
  private notify: (() => void)[] = [];

  private constructor(ws: WebSocket, name: string) {
    this.ws = ws;
    this.name = name;
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(String(ev.data)) as ServerMsg;
      if (m.type === 'gameStateUpdate') this.lastView = m.state as Record<string, unknown>;
      if (m.type === 'gameOver') this.gameOver = m;
      if (m.type === 'roomCreated' || m.type === 'roomJoined') {
        this.playerId = m.playerId as string;
        this.roomCode = m.roomCode as string;
      }
      this.msgs.push(m);
      const waiting = this.notify;
      this.notify = [];
      for (const fn of waiting) fn();
    });
  }

  static connect(port: number, name = 'client'): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      const client = new TestClient(ws, name);
      ws.addEventListener('open', () => resolve(client));
      ws.addEventListener('error', () => reject(new Error(`${name}: connect failed`)));
    });
  }

  send(msg: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(msg));
  }

  /** Snapshot the message cursor before sending, to await only later messages. */
  mark(): number {
    return this.msgs.length;
  }

  /** Resolves with the first message at/after `from` matching `pred`. */
  waitFor(from: number, pred: (m: ServerMsg) => boolean, timeoutMs = 4000): Promise<ServerMsg> {
    return new Promise((resolve, reject) => {
      let cursor = from;
      const timer = setTimeout(
        () => reject(new Error(`${this.name}: timed out waiting (have ${this.msgs.length - from} msgs since mark)`)),
        timeoutMs,
      );
      const check = () => {
        while (cursor < this.msgs.length) {
          const m = this.msgs[cursor++]!;
          if (pred(m)) {
            clearTimeout(timer);
            resolve(m);
            return;
          }
        }
        this.notify.push(check);
      };
      check();
    });
  }

  waitForType(from: number, type: string, timeoutMs = 4000): Promise<ServerMsg> {
    return this.waitFor(from, (m) => m.type === type, timeoutMs);
  }

  /** Sends a game action and resolves with the resulting update or error. */
  async action(msg: Record<string, unknown>): Promise<ServerMsg> {
    const from = this.mark();
    this.send(msg);
    return this.waitFor(from, (m) => m.type === 'gameStateUpdate' || m.type === 'errorMessage');
  }

  close(): void {
    this.ws.close();
  }
}
