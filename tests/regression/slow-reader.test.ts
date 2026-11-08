/**
 * Audit 1 re-audit, observation O1. A client that stops reading but keeps the connection alive
 * made the server buffer state patches for it until the run ended. The room now drops a client
 * whose unsent backlog passes TUNING.net.maxSendBacklogBytes.
 */
import type { ColyseusTestServer } from '@colyseus/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TUNING } from '@crossfire/shared/tuning';
import { MSG } from '@crossfire/shared/types';
import { bootServer, joinPlayer, openLobby, until } from '../integration/helpers';
import { closedWithin, frames, joined, rawJoin } from './raw';
import { TEST_PORT } from '../integration/helpers';

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

describe('O1: a client that stops reading', () => {
  it('is dropped once its unsent backlog passes the limit; others play on', async () => {
    const { host, room, code } = await openLobby(colyseus);
    const slow = joined(await rawJoin(TEST_PORT, 'joinById', code, { name: 'Slow' }));
    const other = await joinPlayer(colyseus, code, 'Ok');
    slow.ws.send(frames.data(MSG.ready, { ready: true }));
    other.send(MSG.ready, { ready: true });
    await until(() => [...room.state.players.values()].every((p) => p.ready), 3000, 'ready');
    host.send(MSG.start, {});
    await until(() => room.state.phase === 'running', 3000, 'run start');

    // The server-side socket reports a backlog over the limit, as a stalled reader's would.
    const server = room.clients.find((c) => c.sessionId === slow.sessionId)!;
    Object.defineProperty(server.ref, 'bufferedAmount', {
      get: () => TUNING.net.maxSendBacklogBytes + 1,
      configurable: true,
    });
    expect(await closedWithin(slow, 2000)).toBe(4002);
    await until(() => !room.state.players.has(slow.sessionId), 3000, 'slow removed');
    expect(room.state.phase).toBe('running');
    expect(room.state.players.has(other.sessionId)).toBe(true);
  });

  it('a backlog under the limit is left alone', async () => {
    const { room, code } = await openLobby(colyseus);
    const c = joined(await rawJoin(TEST_PORT, 'joinById', code, { name: 'Busy' }));
    const server = room.clients.find((x) => x.sessionId === c.sessionId)!;
    Object.defineProperty(server.ref, 'bufferedAmount', {
      get: () => TUNING.net.maxSendBacklogBytes - 1,
      configurable: true,
    });
    expect(await closedWithin(c, 1500)).toBe(-1);
    c.ws.close();
  });
});
