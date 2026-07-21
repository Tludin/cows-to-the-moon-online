// Minimal RFC 6455 WebSocket server — zero dependencies.
//
// Why hand-rolled: the sandboxed build environment has no npm registry access,
// and the spec (3.2) keeps the game engine decoupled from transport anyway.
// This module is deliberately tiny and swappable: rooms.ts only uses the
// WsConnection interface (send / close / on message / on close), so replacing
// it with Socket.IO or `ws` later touches nothing else.
//
// Scope: text frames, masking, 7/16/64-bit lengths, fragmentation, ping/pong,
// clean close. No extensions (permessage-deflate is declined by omission).

import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** Refuse messages larger than this (a full game state is ~10 KB). */
const MAX_MESSAGE_BYTES = 1024 * 1024;

const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

/**
 * One connected client. Emits:
 *   'message' (text: string)  — a complete text message arrived
 *   'close'                   — the connection is gone (any reason), fired once
 */
export class WsConnection extends EventEmitter {
  private socket: Duplex;
  private buffer: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentedOpcode: number | null = null;
  private closeSent = false;
  private closeEmitted = false;

  constructor(socket: Duplex) {
    super();
    this.socket = socket;
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('close', () => this.emitClose());
    socket.on('error', () => this.emitClose());
  }

  /** Sends one text message. Silently drops if the socket is gone. */
  send(text: string): void {
    if (this.closeSent || this.socket.destroyed) return;
    this.socket.write(encodeFrame(OP_TEXT, Buffer.from(text, 'utf8')));
  }

  /** Starts a clean close handshake. */
  close(code = 1000): void {
    if (this.closeSent || this.socket.destroyed) return;
    this.closeSent = true;
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code, 0);
    this.socket.write(encodeFrame(OP_CLOSE, payload));
    // Give the peer a moment to echo the close frame, then drop the TCP socket.
    setTimeout(() => this.socket.destroy(), 250).unref();
  }

  private emitClose(): void {
    if (this.closeEmitted) return;
    this.closeEmitted = true;
    this.emit('close');
  }

  private fail(): void {
    this.socket.destroy();
    this.emitClose();
  }

  private onData(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    while (this.tryParseFrame()) {
      /* keep consuming complete frames */
    }
  }

  /** Parses one complete frame off the buffer. Returns false if more bytes are needed. */
  private tryParseFrame(): boolean {
    const buf = this.buffer;
    if (buf.length < 2) return false;

    const fin = (buf[0]! & 0x80) !== 0;
    const opcode = buf[0]! & 0x0f;
    const masked = (buf[1]! & 0x80) !== 0;
    let payloadLen = buf[1]! & 0x7f;
    let offset = 2;

    if (payloadLen === 126) {
      if (buf.length < offset + 2) return false;
      payloadLen = buf.readUInt16BE(offset);
      offset += 2;
    } else if (payloadLen === 127) {
      if (buf.length < offset + 8) return false;
      const big = buf.readBigUInt64BE(offset);
      if (big > BigInt(MAX_MESSAGE_BYTES)) return this.fail(), false;
      payloadLen = Number(big);
      offset += 8;
    }
    if (payloadLen > MAX_MESSAGE_BYTES) return this.fail(), false;

    // Client-to-server frames must be masked (RFC 6455 §5.1).
    if (!masked) return this.fail(), false;
    if (buf.length < offset + 4 + payloadLen) return false;
    const maskKey = buf.subarray(offset, offset + 4);
    offset += 4;

    const payload = Buffer.allocUnsafe(payloadLen);
    for (let i = 0; i < payloadLen; i++) {
      payload[i] = buf[offset + i]! ^ maskKey[i % 4]!;
    }
    this.buffer = buf.subarray(offset + payloadLen);

    this.handleFrame(fin, opcode, payload);
    return this.buffer.length > 0;
  }

  private handleFrame(fin: boolean, opcode: number, payload: Buffer): void {
    switch (opcode) {
      case OP_TEXT:
      case OP_BINARY:
        if (!fin) {
          this.fragmentedOpcode = opcode;
          this.fragments = [payload];
        } else {
          this.emit('message', payload.toString('utf8'));
        }
        return;
      case OP_CONTINUATION: {
        if (this.fragmentedOpcode === null) return this.fail();
        this.fragments.push(payload);
        const total = this.fragments.reduce((n, f) => n + f.length, 0);
        if (total > MAX_MESSAGE_BYTES) return this.fail();
        if (fin) {
          const whole = Buffer.concat(this.fragments);
          this.fragments = [];
          this.fragmentedOpcode = null;
          this.emit('message', whole.toString('utf8'));
        }
        return;
      }
      case OP_PING:
        if (!this.socket.destroyed) this.socket.write(encodeFrame(OP_PONG, payload));
        return;
      case OP_PONG:
        return; // nothing to do
      case OP_CLOSE:
        if (!this.closeSent && !this.socket.destroyed) {
          this.closeSent = true;
          this.socket.write(encodeFrame(OP_CLOSE, payload.subarray(0, 2)));
        }
        this.socket.destroy();
        this.emitClose();
        return;
      default:
        this.fail();
    }
  }
}

/** Builds a server-to-client frame (never masked). */
function encodeFrame(opcode: number, payload: Buffer): Buffer {
  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, payload]);
}

/**
 * Answers an HTTP Upgrade request. Returns the connection, or null (with the
 * socket ended) if the request is not a valid WebSocket handshake.
 */
export function acceptUpgrade(req: IncomingMessage, socket: Duplex): WsConnection | null {
  const key = req.headers['sec-websocket-key'];
  const version = req.headers['sec-websocket-version'];
  if (req.method !== 'GET' || typeof key !== 'string' || version !== '13') {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return null;
  }
  const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n` +
      '\r\n',
  );
  return new WsConnection(socket);
}
