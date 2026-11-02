import { boot, type ColyseusTestServer } from '@colyseus/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LOAD_ROOM_NAME, MSG } from '@crossfire/shared/types';
import { TUNING } from '@crossfire/shared/tuning';
import { createApp } from '../../server/src/app';
import type { HoldRoom } from '../../server/src/rooms/HoldRoom';
import { bootServer, input, joinPlayer, until } from './helpers';

const LOAD_ROOM = LOAD_ROOM_NAME;

describe('load room is absent by default', () => {
  let colyseus: ColyseusTestServer;
  beforeAll(async () => {
    colyseus = await bootServer();
  });
  afterAll(async () => {
    await colyseus.shutdown();
  });

  it('creating hold_load fails on a normal server', async () => {
    await expect(colyseus.sdk.create(LOAD_ROOM, { role: 'host' })).rejects.toThrow();
  });
});

describe('load room (CROSSFIRE_LOAD_ROOM)', () => {
  let colyseus: ColyseusTestServer;
  beforeAll(async () => {
    colyseus = await boot(createApp({ loadRooms: true }));
  });
  afterAll(async () => {
    await colyseus.shutdown();
  });
  beforeEach(async () => {
    await colyseus.cleanup();
  });

  it('only a host page can open it: a player cannot create one', async () => {
    await expect(colyseus.sdk.create(LOAD_ROOM, { name: 'Mallory' })).rejects.toThrow();
  });

  it('fills to the requested cap, stays there, and heroes take no damage', async () => {
    const host = await colyseus.sdk.create(LOAD_ROOM, { role: 'host', enemyCap: 20 });
    const room = colyseus.getRoomById<HoldRoom>(host.roomId);
    expect(room.world.t.waves.enemyCap).toBe(20);
    const players = [
      await joinPlayer(colyseus, host.roomId, 'Bot 1'),
      await joinPlayer(colyseus, host.roomId, 'Bot 2'),
    ];
    for (const p of players) p.send(MSG.ready, { ready: true });
    await until(() => [...room.state.players.values()].every((p) => p.ready), 3000, 'ready');
    host.send(MSG.start, {});
    await until(() => room.state.phase === 'running', 3000, 'running');

    // Walk one hero out of the ring and shoot: nothing should hurt either hero.
    let seq = 1;
    const timer = setInterval(() => {
      players[0]!.send(MSG.input, input(seq, { moveX: 1, attack: true }));
      players[1]!.send(MSG.input, input(seq, { attack: true }));
      seq++;
    }, 50);
    try {
      await until(() => room.world.enemies.count === 20, 5000, 'cap reached');
      // Enemies need ~6 s to walk in from the spawn ring and start swinging.
      const counts: number[] = [];
      const t0 = Date.now();
      while (Date.now() - t0 < 9000) {
        counts.push(room.world.enemies.count);
        await new Promise((r) => setTimeout(r, 250));
      }
      expect(Math.min(...counts)).toBeGreaterThanOrEqual(18);
      expect(room.world.kills).toBeGreaterThan(0);
      for (const h of room.world.heroes.values()) {
        expect(h.status).toBe('standing');
        expect(h.hp).toBe(TUNING.ember.maxHp);
      }
      const outside = [...room.world.heroes.values()].some((h) => Math.hypot(h.x, h.z) > TUNING.ring.radius);
      expect(outside).toBe(true);
    } finally {
      clearInterval(timer);
    }
  });

  it('a bad or missing cap falls back to the game cap', async () => {
    const host = await colyseus.sdk.create(LOAD_ROOM, { role: 'host', enemyCap: 'lots' });
    const room = colyseus.getRoomById<HoldRoom>(host.roomId);
    expect(room.world.t.waves.enemyCap).toBe(TUNING.waves.enemyCap);
  });

  it('the normal hold room still uses the real tuning on this server', async () => {
    const host = await colyseus.sdk.create('hold', { role: 'host', enemyCap: 5 });
    const room = colyseus.getRoomById<HoldRoom>(host.roomId);
    expect(room.world.t).toBe(TUNING);
  });
});
