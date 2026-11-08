/**
 * Audit 1 re-audit, R1 (high). The round-1 frame cap (240/s) only stopped fast floods:
 * - a half-joined client (never acks JOIN) sending 200 request frames/s with a 15 KB type made
 *   the server queue every error reply, without bound;
 * - PING and request frames never reached our token bucket.
 * Every frame now passes our own gate first: the bucket, and only the frame types our clients
 * actually send. A client that never acks JOIN is dropped after TUNING.lobby.joinAckSec.
 * Each flood here runs UNDER the 240/s cap on purpose.
 */
import type { ColyseusTestServer } from '@colyseus/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TUNING } from '@crossfire/shared/tuning';
import { MSG } from '@crossfire/shared/types';
import { bootServer, joinPlayer, openLobby, sleep, TEST_PORT, until } from '../integration/helpers';
import { closedWithin, flood, frames, joined, rawJoin } from './raw';

const FORCED_CLOSE = 4002;
const UNDER_CAP = 200;

let colyseus: ColyseusTestServer;

beforeAll(async () => {
  colyseus = await bootServer();
});
afterAll(async () => {
  await colyseus.shutdown();
});
beforeEach(async () => {
  await colyseus.cleanup();
});

describe('R1: a half-joined client', () => {
  it(`sending ${UNDER_CAP}/s 15 KB request frames is closed at once; memory stays flat`, async () => {
    expect(UNDER_CAP).toBeLessThan(TUNING.net.maxFramesPerSec);
    const { code } = await openLobby(colyseus);
    const ghost = joined(await rawJoin(TEST_PORT, 'joinById', code, { name: 'Ghost' }, { ack: false }));
    const name = 'q'.repeat(15_000);
    const before = process.memoryUsage().rss;
    let id = 0;
    const stop = flood(ghost.ws, () => frames.request(id++, name), UNDER_CAP);
    try {
      expect(await closedWithin(ghost, 1000)).toBe(FORCED_CLOSE);
    } finally {
      stop();
    }
    expect(process.memoryUsage().rss - before).toBeLessThan(20 * 1024 * 1024);
  });

  it(`that never acks JOIN is dropped after ${TUNING.lobby.joinAckSec} s and its seat is free again`, async () => {
    const { room, code } = await openLobby(colyseus);
    const ghost = joined(await rawJoin(TEST_PORT, 'joinById', code, { name: 'Ghost' }, { ack: false }));
    await until(() => room.state.players.has(ghost.sessionId), 3000, 'ghost seated');
    expect(await closedWithin(ghost, TUNING.lobby.joinAckSec * 1000 + 1500)).toBe(FORCED_CLOSE);
    await until(() => !room.state.players.has(ghost.sessionId), 3000, 'ghost removed');
    const ann = await joinPlayer(colyseus, code, 'Ann');
    expect(room.state.players.has(ann.sessionId)).toBe(true);
  }, 15_000);

  it('cannot send game messages (ready) before it acks JOIN', async () => {
    const { room, code } = await openLobby(colyseus);
    const ghost = joined(await rawJoin(TEST_PORT, 'joinById', code, { name: 'Ghost' }, { ack: false }));
    ghost.ws.send(frames.data(MSG.ready, { ready: true }));
    expect(await closedWithin(ghost, 1000)).toBe(FORCED_CLOSE);
    expect(room.state.players.get(ghost.sessionId)?.ready ?? false).toBe(false);
  });

  it('that acks JOIN normally is not dropped by the ack timer', async () => {
    const { room, code } = await openLobby(colyseus);
    const ok = joined(await rawJoin(TEST_PORT, 'joinById', code, { name: 'Ok' }));
    await sleep(TUNING.lobby.joinAckSec * 1000 + 800);
    expect(room.state.players.has(ok.sessionId)).toBe(true);
    ok.ws.close();
  }, 15_000);
});

describe('R1: a joined client, under the frame cap', () => {
  for (const [label, frame] of [
    ['PING', () => frames.ping()],
    [
      'unknown request',
      (() => {
        let id = 0;
        return () => frames.request(id++, 'nope');
      })(),
    ],
  ] as const) {
    it(`sending ${UNDER_CAP} ${label} frames/s is closed`, async () => {
      const { code } = await openLobby(colyseus);
      const c = joined(await rawJoin(TEST_PORT, 'joinById', code, { name: 'Odd' }));
      const stop = flood(c.ws, frame, UNDER_CAP);
      try {
        expect(await closedWithin(c, 1000)).toBe(FORCED_CLOSE);
      } finally {
        stop();
      }
    });
  }

  it('sending 100 game messages/s (over the 60/s bucket) is rate-limited, then kicked with 4020', async () => {
    const { room, code } = await openLobby(colyseus);
    const c = joined(await rawJoin(TEST_PORT, 'joinById', code, { name: 'Chatty' }));
    const stats = () => room.netStats(c.sessionId);
    await until(() => stats() !== undefined, 3000, 'stats');
    const s = stats()!;
    const stop = flood(c.ws, () => frames.data(MSG.ready, { ready: true }), 100);
    try {
      expect(await closedWithin(c, 10_000)).toBe(4020);
    } finally {
      stop();
    }
    expect(s.dropped).toBeGreaterThan(0);
  }, 15_000);
});
