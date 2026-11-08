/**
 * Audit 1, F1 (high): the host check must use the real socket address. Colyseus resolves
 * `context.ip` from X-Real-IP / X-Forwarded-For / X-Client-IP first, and a LAN client sets
 * those itself. There is no proxy, so the server must ignore them.
 */
import type { ColyseusTestServer } from '@colyseus/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HoldRoom } from '../../server/src/rooms/HoldRoom';
import { bootServer, openLobby, TEST_PORT } from '../integration/helpers';
import { joined, matchmake, rawJoin } from './raw';

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
afterEach(() => {
  vi.restoreAllMocks();
});

const SPOOF_HEADERS = ['x-real-ip', 'x-forwarded-for', 'x-client-ip'];

describe('audit 1 F1: forged IP headers never decide who the host is', () => {
  for (const header of SPOOF_HEADERS) {
    it(`the host check sees the socket address, not ${header}`, async () => {
      const { code } = await openLobby(colyseus);
      const seen = vi.spyOn(HoldRoom.prototype, 'isHostAddress');
      // From the host laptop, but claiming to be a LAN laptop: the claim must be ignored.
      const c = joined(
        await rawJoin(TEST_PORT, 'joinById', code, { role: 'host' }, { headers: { [header]: '10.9.9.9' } }),
      );
      expect(seen).toHaveBeenCalled();
      for (const [ip] of seen.mock.calls) expect(ip).toMatch(/^(::ffff:)?127\.0\.0\.1$|^::1$/);
      c.ws.close();
    });
  }

  it('a socket that is not the host laptop cannot become host by naming its address in a header', async () => {
    const { code } = await openLobby(colyseus);
    // Only "::1" counts as the host laptop here. The test socket really comes from 127.0.0.1,
    // so it stands in for a LAN laptop, and the headers claim the host's address.
    vi.spyOn(HoldRoom.prototype, 'isHostAddress').mockImplementation((ip) => ip === '::1');
    for (const header of SPOOF_HEADERS) {
      const r = await rawJoin(
        TEST_PORT,
        'joinById',
        code,
        { role: 'host' },
        { headers: { [header]: '::1' } },
      );
      expect(r, header).toMatchObject({ refused: 'ws' });
    }
  });

  it('room creation from the host laptop still works with a forged LAN header', async () => {
    const r = await matchmake(
      TEST_PORT,
      'create',
      'hold',
      { role: 'host' },
      { 'x-forwarded-for': '10.9.9.9' },
    );
    expect(r.status).toBe(200);
  });
});
