/**
 * Raw-protocol helpers for the audit-1 regression tests: they speak to the server the way a
 * hostile LAN client would, with hand-made Colyseus frames and arbitrary HTTP headers.
 */
import WebSocket from 'ws';

export interface Reply {
  status: number;
  json: Record<string, unknown> | undefined;
}

/** POST /matchmake/<method>/<room>. `body` as a string is sent verbatim. */
export async function matchmake(
  port: number,
  method: string,
  room: string,
  body: unknown = {},
  headers: Record<string, string> = {},
): Promise<Reply> {
  const r = await fetch(`http://127.0.0.1:${port}/matchmake/${method}/${room}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await r.text();
  let json: Record<string, unknown> | undefined;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = undefined;
  }
  return { status: r.status, json };
}

// ---- frames (Colyseus protocol codes) ----

const JOIN_ROOM = 10;
const ERROR = 11;
const ROOM_DATA = 13;
const PING = 0x12;
const ROOM_REQUEST = 21;

/** msgpack string. */
function str(s: string): Buffer {
  const b = Buffer.from(s, 'utf8');
  if (b.length < 32) return Buffer.concat([Buffer.from([0xa0 | b.length]), b]);
  if (b.length < 256) return Buffer.concat([Buffer.from([0xd9, b.length]), b]);
  return Buffer.concat([Buffer.from([0xda, b.length >> 8, b.length & 255]), b]);
}

/** msgpack map of string keys to strings or booleans (all the tests need). */
function map(o: Record<string, string | boolean>): Buffer {
  const entries = Object.entries(o);
  const parts: Buffer[] = [Buffer.from([0x80 | entries.length])];
  for (const [k, v] of entries) {
    parts.push(str(k));
    parts.push(typeof v === 'boolean' ? Buffer.from([v ? 0xc3 : 0xc2]) : str(v));
  }
  return Buffer.concat(parts);
}

export const frames = {
  joinAck: (): Buffer => Buffer.from([JOIN_ROOM]),
  ping: (): Buffer => Buffer.from([PING]),
  data: (type: string, payload: Record<string, string | boolean> = {}): Buffer =>
    Buffer.concat([Buffer.from([ROOM_DATA]), str(type), map(payload)]),
  request: (id: number, type: string): Buffer =>
    Buffer.concat([Buffer.from([ROOM_REQUEST, id & 0x7f]), str(type)]),
};

export interface RawClient {
  ws: WebSocket;
  sessionId: string;
  /** Resolves with the close code. */
  closed: Promise<number>;
}

export type RawJoin = RawClient | { refused: number | 'ws'; error: string };

/**
 * Reserves a seat over HTTP, then opens the socket with the given upgrade headers.
 * With `ack`, answers the server's JOIN_ROOM like the SDK does; without, the client stays
 * half-joined. Resolves once JOIN_ROOM arrives, or with the refusal.
 */
export async function rawJoin(
  port: number,
  method: string,
  room: string,
  options: Record<string, unknown>,
  { headers = {}, ack = true }: { headers?: Record<string, string>; ack?: boolean } = {},
): Promise<RawJoin> {
  const res = await matchmake(port, method, room, options);
  if (res.status !== 200 || !res.json) return { refused: res.status, error: String(res.json?.error) };
  const { sessionId, roomId, processId } = res.json as Record<string, string>;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/${processId}/${roomId}?sessionId=${sessionId}`, {
    headers,
  });
  const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
  ws.on('error', () => {});
  return new Promise((resolve) => {
    let joined = false;
    let lastError = '';
    void closed.then(() => {
      if (!joined) resolve({ refused: 'ws', error: lastError });
    });
    ws.on('message', (d: Buffer) => {
      if (d[0] === ERROR) lastError = d.subarray(2).toString('utf8');
      if (d[0] === JOIN_ROOM && !joined) {
        joined = true;
        if (ack) ws.send(frames.joinAck());
        resolve({ ws, sessionId: sessionId!, closed });
      }
    });
  });
}

export function joined(r: RawJoin): RawClient {
  if ('refused' in r) throw new Error(`join refused: ${r.refused} ${r.error}`);
  return r;
}

/** Sends `frame()` `perSec` times a second (in 10 ms batches) until stopped. */
export function flood(ws: WebSocket, frame: () => Buffer, perSec: number): () => void {
  const perBatch = Math.max(1, Math.round(perSec / 100));
  const timer = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    for (let i = 0; i < perBatch; i++) ws.send(frame());
  }, 10);
  return () => clearInterval(timer);
}

/** Resolves with the close code, or -1 if the socket is still open after `ms`. */
export function closedWithin(c: RawClient, ms: number): Promise<number> {
  return Promise.race([c.closed, new Promise<number>((r) => setTimeout(() => r(-1), ms))]);
}
