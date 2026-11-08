/**
 * Audit 1, F2 and the seat-reservation griefing note, seen from a LAN laptop.
 * `lanClients` makes the server treat every caller as a LAN laptop (tests only), so these
 * rules can be proven from loopback. Its own file: Colyseus' matchmaker is one per process.
 */
import { boot, type ColyseusTestServer } from '@colyseus/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TUNING } from '@crossfire/shared/tuning';
import { JOIN_ERRORS } from '@crossfire/shared/types';
import { createApp } from '../../server/src/app';
import { sleep, TEST_PORT } from '../integration/helpers';
import { matchmake } from './raw';

let colyseus: ColyseusTestServer;

beforeAll(async () => {
  colyseus = await boot(createApp({ testRooms: true, lanClients: true }), TEST_PORT);
});
afterAll(async () => {
  await colyseus.shutdown();
});
beforeEach(async () => {
  await colyseus.cleanup();
});

describe('a LAN laptop on the matchmaking route', () => {
  it('cannot create a room', async () => {
    const r = await matchmake(TEST_PORT, 'create', 'hold', { role: 'host' });
    expect(r.status).toBe(403);
    const { matchMaker } = await import('@colyseus/core');
    expect(await matchMaker.query({})).toHaveLength(0);
  });

  it(`holds at most ${TUNING.lobby.maxReservationsPerIp} seat reservations at a time`, async () => {
    const room = await colyseus.createRoom('hold', {});
    // No host page joins here; keep the empty room open while the reservations lapse.
    room.autoDispose = false;
    const code = room.roomId;
    for (let i = 0; i < TUNING.lobby.maxReservationsPerIp; i++)
      expect((await matchmake(TEST_PORT, 'joinById', code, { name: `G${i}` })).status).toBe(200);
    const refused = await matchmake(TEST_PORT, 'joinById', code, { name: 'G9' });
    expect(refused.status).toBe(429);
    expect(refused.json?.error).toBe(JOIN_ERRORS.tooManyJoins);
    await sleep(TUNING.lobby.seatReservationSec * 1000 + 100);
    expect((await matchmake(TEST_PORT, 'joinById', code, { name: 'G9' })).status).toBe(200);
  }, 15_000);
});
