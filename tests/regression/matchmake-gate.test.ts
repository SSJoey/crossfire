/**
 * Audit 1, F2 (medium) and the seat-reservation griefing note (checklist 18).
 * Colyseus answers POST /matchmake/<method>/<room> before Express, reads the body with no size
 * limit and lets anyone create rooms. The server now guards that route itself:
 * only `create` (host laptop only) and `joinById`, a small body, and few open seats per LAN IP.
 */
import type { ColyseusTestServer } from '@colyseus/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { matchmakeGate, ReservationLimiter } from '@crossfire/shared/rules/validation';
import { TUNING } from '@crossfire/shared/tuning';
import { JOIN_ERRORS } from '@crossfire/shared/types';
import { bootServer, openLobby, sleep, TEST_PORT } from '../integration/helpers';
import { matchmake } from './raw';

const MAX = TUNING.net.maxMatchmakeBodyBytes;
const req = (patch: Partial<Parameters<typeof matchmakeGate>[0]> = {}) => ({
  method: 'joinById',
  contentLength: '20',
  chunked: false,
  loopback: false,
  ...patch,
});

describe('audit 1 F2: matchmakeGate (pure)', () => {
  it('allows joinById from anywhere and create from the host laptop', () => {
    expect(matchmakeGate(req())).toEqual({ ok: true });
    expect(matchmakeGate(req({ loopback: true }))).toEqual({ ok: true });
    expect(matchmakeGate(req({ method: 'create', loopback: true }))).toEqual({ ok: true });
  });

  it('refuses create from a LAN laptop', () => {
    expect(matchmakeGate(req({ method: 'create' }))).toMatchObject({ ok: false, status: 403 });
  });

  it('refuses every other matchmaking method, from anywhere', () => {
    for (const method of ['join', 'joinOrCreate', 'reconnect', 'consumeSeat', 'x', '']) {
      expect(matchmakeGate(req({ method })), method).toMatchObject({ ok: false, status: 403 });
      expect(matchmakeGate(req({ method, loopback: true })), method).toMatchObject({
        ok: false,
        status: 403,
      });
    }
  });

  it('needs a declared body length within the cap', () => {
    expect(matchmakeGate(req({ contentLength: '0' }))).toEqual({ ok: true });
    expect(matchmakeGate(req({ contentLength: String(MAX) }))).toEqual({ ok: true });
    expect(matchmakeGate(req({ contentLength: String(MAX + 1) }))).toMatchObject({ ok: false, status: 413 });
    expect(matchmakeGate(req({ contentLength: '134217728', loopback: true }))).toMatchObject({ status: 413 });
    expect(matchmakeGate(req({ contentLength: undefined }))).toMatchObject({ ok: false, status: 411 });
    expect(matchmakeGate(req({ chunked: true }))).toMatchObject({ ok: false, status: 411 });
    for (const bad of ['-1', '1.5', 'abc', '', '1e3', ' 12'])
      expect(matchmakeGate(req({ contentLength: bad })), bad).toMatchObject({ ok: false, status: 400 });
  });
});

describe('seat griefing: ReservationLimiter (pure)', () => {
  const window = TUNING.lobby.seatReservationSec * 1000;

  it(`allows ${TUNING.lobby.maxReservationsPerIp} joins per IP per reservation window`, () => {
    const l = new ReservationLimiter();
    for (let i = 0; i < TUNING.lobby.maxReservationsPerIp; i++)
      expect(l.allow('10.0.0.5', 1000 + i)).toBe(true);
    expect(l.allow('10.0.0.5', 1100)).toBe(false);
    expect(l.allow('10.0.0.6', 1100)).toBe(true);
    expect(l.allow('10.0.0.5', 1000 + window)).toBe(true);
  });

  it('a refused attempt does not extend the wait', () => {
    const l = new ReservationLimiter(1, 5000);
    expect(l.allow('a', 0)).toBe(true);
    for (let t = 100; t < 5000; t += 100) expect(l.allow('a', t)).toBe(false);
    expect(l.allow('a', 5000)).toBe(true);
  });

  it('forgets idle addresses, so memory stays bounded', () => {
    const l = new ReservationLimiter(2, 5000);
    for (let i = 0; i < 1000; i++) l.allow(`10.0.${i >> 8}.${i & 255}`, i);
    expect(l.size).toBe(1000);
    l.allow('10.9.9.9', 20_000);
    expect(l.size).toBe(1);
  });
});

describe('audit 1 F2: the matchmaking route on a real server (host laptop)', () => {
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

  it('a body over the cap is refused with 413 and creates no room', async () => {
    const big = JSON.stringify({ role: 'host', name: 'x'.repeat(MAX + 1) });
    const r = await matchmake(TEST_PORT, 'create', 'hold', big);
    expect(r.status).toBe(413);
    expect(await liveRooms()).toBe(0);
  });

  it('a chunked body with no declared length is refused with 411', async () => {
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"role":"host"}'));
        c.close();
      },
    });
    const r = await fetch(`http://127.0.0.1:${TEST_PORT}/matchmake/create/hold`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      duplex: 'half',
    } as RequestInit);
    expect(r.status).toBe(411);
    expect(await liveRooms()).toBe(0);
  });

  it('no other spelling of the route and no other write method gets past the guard', async () => {
    const big = JSON.stringify({ role: 'host', name: 'x'.repeat(MAX + 1) });
    for (const path of [
      '//matchmake/create/hold',
      '/matchmake/create/hold/',
      '/matchmake//create/hold',
      '/x',
    ])
      expect(
        (await fetch(`http://127.0.0.1:${TEST_PORT}${path}`, { method: 'POST', body: big })).status,
        path,
      ).toBeGreaterThanOrEqual(400);
    for (const method of ['PUT', 'PATCH', 'DELETE'])
      expect(
        (await fetch(`http://127.0.0.1:${TEST_PORT}/matchmake/create/hold`, { method, body: '{}' })).status,
        method,
      ).toBe(405);
    expect(await liveRooms()).toBe(0);
  });

  it('join and joinOrCreate are refused: players only join by code', async () => {
    await openLobby(colyseus);
    for (const method of ['join', 'joinOrCreate']) {
      const r = await matchmake(TEST_PORT, method, 'hold', { name: 'Mallory' });
      expect(r.status, method).toBe(403);
    }
  });

  it('the host page still opens a room and players still join by code', async () => {
    const { code } = await openLobby(colyseus);
    const p = await colyseus.sdk.joinById(code, { name: 'Ann' });
    expect(p.sessionId).toBeTruthy();
  });

  it(`an unused seat reservation lapses after ${TUNING.lobby.seatReservationSec} s`, async () => {
    const { room, code } = await openLobby(colyseus);
    // Fill every seat the room has left with reservations that never connect.
    const free = room.maxClients - room.clients.length;
    for (let i = 0; i < free; i++)
      expect((await matchmake(TEST_PORT, 'joinById', code, { name: `G${i}` })).status).toBe(200);
    await expect(colyseus.sdk.joinById(code, { name: 'Ann' })).rejects.toThrow();
    await sleep(TUNING.lobby.seatReservationSec * 1000 + 600);
    const ann = await colyseus.sdk.joinById(code, { name: 'Ann' });
    expect(ann.sessionId).toBeTruthy();
  }, 15_000);

  async function liveRooms(): Promise<number> {
    const { matchMaker } = await import('@colyseus/core');
    return (await matchMaker.query({})).length;
  }
});

describe('error texts', () => {
  it('the too-many-joins refusal has a message for the join screen', () => {
    expect(JOIN_ERRORS.tooManyJoins).toMatch(/wait/i);
  });
});
