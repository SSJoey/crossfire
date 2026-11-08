/**
 * Audit 1, F3 and F4 (medium). Frames that Colyseus handles below the message handlers
 * (PING, unknown request types, frames before the JOIN ack) never reached our rate limit, so
 * a client could flood them forever, and a half-joined socket could make the server queue
 * replies without bound. Colyseus' per-client frame cap now cuts such a client off.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ColyseusTestServer } from '@colyseus/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MSG } from '@crossfire/shared/types';
import { bootServer, input, joinPlayer, openLobby, TEST_PORT, until } from '../integration/helpers';
import { closedWithin, flood, frames, joined, rawJoin } from './raw';

/** Colyseus closes a client over its frame cap with this code (CloseCode.WITH_ERROR). */
const FORCED_CLOSE = 4002;

let colyseus: ColyseusTestServer;
let dir: string;
let prevDir: string | undefined;

beforeAll(async () => {
  prevDir = process.env.LOG_DIR;
  dir = mkdtempSync(join(tmpdir(), 'crossfire-frameflood-'));
  process.env.LOG_DIR = dir;
  colyseus = await bootServer();
});
afterAll(async () => {
  await colyseus.shutdown();
  if (prevDir === undefined) delete process.env.LOG_DIR;
  else process.env.LOG_DIR = prevDir;
});
beforeEach(async () => {
  await colyseus.cleanup();
});

function logLines(code: string): Record<string, unknown>[] {
  if (!existsSync(dir)) return [];
  const f = readdirSync(dir).find((n) => n.endsWith(`_${code}.jsonl`));
  if (!f) return [];
  return readFileSync(join(dir, f), 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('audit 1 F3: protocol frames count against the frame cap', () => {
  it('a joined player flooding PINGs is cut off within 1.5 s, logged as protocol; others play on', async () => {
    const { host, room, code } = await openLobby(colyseus);
    const raw = joined(await rawJoin(TEST_PORT, 'joinById', code, { name: 'Pinger' }));
    const other = await joinPlayer(colyseus, code, 'Ok');
    raw.ws.send(frames.data(MSG.ready, { ready: true }));
    other.send(MSG.ready, { ready: true });
    await until(() => [...room.state.players.values()].every((p) => p.ready), 3000, 'ready');
    host.send(MSG.start, {});
    await until(() => room.state.phase === 'running', 3000, 'run start');

    const stop = flood(raw.ws, frames.ping, 1000);
    try {
      expect(await closedWithin(raw, 1500)).toBe(FORCED_CLOSE);
    } finally {
      stop();
    }
    await until(() => !room.state.players.has(raw.sessionId), 3000, 'pinger removed');
    await until(() => logLines(code).some((l) => l.ev === 'left' && l.name === 'Pinger'), 3000, 'left line');
    expect(logLines(code).find((l) => l.ev === 'left' && l.name === 'Pinger')).toMatchObject({
      reason: 'protocol',
    });

    other.send(MSG.input, input(1, { moveX: 1 }));
    await until(() => room.world.heroes.get(other.sessionId)?.input.seq === 1, 3000, 'other served');
    expect(room.state.phase).toBe('running');
  });

  it('a flood of unknown request types is cut off the same way', async () => {
    const { code } = await openLobby(colyseus);
    const raw = joined(await rawJoin(TEST_PORT, 'joinById', code, { name: 'Asker' }));
    let id = 0;
    const stop = flood(raw.ws, () => frames.request(id++, 'nope'), 1000);
    try {
      expect(await closedWithin(raw, 1500)).toBe(FORCED_CLOSE);
    } finally {
      stop();
    }
  });
});

describe('audit 1 F4: a half-joined socket cannot make the server buffer without bound', () => {
  it('a socket that never acks JOIN and floods 16 KB request names is closed; memory stays flat', async () => {
    const { code } = await openLobby(colyseus);
    const raw = joined(await rawJoin(TEST_PORT, 'joinById', code, { name: 'Ghost' }, { ack: false }));
    const name = 'q'.repeat(16_000);
    global.gc?.();
    const before = process.memoryUsage().rss;
    let id = 0;
    const stop = flood(raw.ws, () => frames.request(id++, name), 1000);
    try {
      expect(await closedWithin(raw, 1500)).toBe(FORCED_CLOSE);
    } finally {
      stop();
    }
    expect(process.memoryUsage().rss - before).toBeLessThan(50 * 1024 * 1024);
  });
});
