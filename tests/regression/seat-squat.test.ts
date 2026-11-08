/**
 * Audit 1 re-audit, R2 (medium). Round 1 capped how fast one address starts joins, not how many
 * seats it holds: one LAN laptop filled all 8 seats in 15 s, and kicked squatters rejoined at
 * once. Now one LAN address holds at most TUNING.lobby.maxSeatsPerAddress seats, and a kicked
 * address waits TUNING.lobby.kickCooldownSec. The host laptop (loopback) is exempt.
 * `lanClients` makes the server treat loopback as a LAN laptop, so this runs from one address.
 */
import { boot, type ColyseusTestServer } from '@colyseus/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KickCooldown, seatsHeldBy } from '@crossfire/shared/rules/validation';
import { TUNING } from '@crossfire/shared/tuning';
import { JOIN_ERRORS, MSG } from '@crossfire/shared/types';
import { createApp } from '../../server/src/app';
import type { HoldRoom } from '../../server/src/rooms/HoldRoom';
import { sleep, TEST_PORT, until } from '../integration/helpers';

describe('R2: pure rules', () => {
  it('seatsHeldBy counts the seats of one address', () => {
    const seats = new Map([
      ['s1', '10.0.0.5'],
      ['s2', '10.0.0.6'],
      ['s3', '10.0.0.5'],
    ]);
    expect(seatsHeldBy('10.0.0.5', seats)).toBe(2);
    expect(seatsHeldBy('10.0.0.7', seats)).toBe(0);
  });

  it('KickCooldown blocks an address for its time, then forgets it', () => {
    const k = new KickCooldown(60_000);
    k.block('10.0.0.5', 1000);
    expect(k.blocked('10.0.0.5', 1000)).toBe(true);
    expect(k.blocked('10.0.0.5', 60_999)).toBe(true);
    expect(k.blocked('10.0.0.6', 2000)).toBe(false);
    expect(k.blocked('10.0.0.5', 61_000)).toBe(false);
    expect(k.size).toBe(0);
  });

  it('the agreed values', () => {
    expect(TUNING.lobby.maxSeatsPerAddress).toBe(1);
    expect(TUNING.lobby.kickCooldownSec).toBe(60);
  });
});

describe('R2: one LAN laptop', () => {
  let colyseus: ColyseusTestServer;

  beforeAll(async () => {
    colyseus = await boot(createApp({ testRooms: true, lanClients: true }), TEST_PORT);
  });
  afterAll(async () => {
    await colyseus.shutdown();
  });

  // The join-rate window: wait it out between joins from "one address".
  const window = () => sleep(TUNING.lobby.seatReservationSec * 1000 + 150);

  it('holds one seat; a kicked laptop waits out the cooldown', async () => {
    const room = (await colyseus.createRoom('hold', {})) as unknown as HoldRoom;
    room.autoDispose = false;
    const code = room.roomId;
    const host = await colyseus.sdk.joinById(code, { role: 'host' });
    const a = await colyseus.sdk.joinById(code, { name: 'A' });
    await until(() => room.state.players.size === 1, 3000, 'A seated');

    await window();
    await expect(colyseus.sdk.joinById(code, { name: 'B' })).rejects.toThrow(JOIN_ERRORS.oneSeat);
    expect(room.state.players.size).toBe(1);

    room.kickCooldownMs = 2000;
    host.send(MSG.kick, { sessionId: a.sessionId });
    await until(() => room.state.players.size === 0, 3000, 'A kicked');
    await expect(colyseus.sdk.joinById(code, { name: 'A' })).rejects.toThrow(JOIN_ERRORS.kickedWait);

    await window();
    const back = await colyseus.sdk.joinById(code, { name: 'A' });
    expect(room.state.players.has(back.sessionId)).toBe(true);
  }, 30_000);
});
