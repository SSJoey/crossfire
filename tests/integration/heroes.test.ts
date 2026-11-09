import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ColyseusTestServer } from '@colyseus/testing';
import type { Room as ClientRoom } from '@colyseus/sdk';
import { TUNING } from '@crossfire/shared/tuning';
import { MSG } from '@crossfire/shared/types';
import { createApp } from '../../server/src/app';
import { HoldRoom } from '../../server/src/rooms/HoldRoom';
import { bootServer, input, joinPlayer, openLobby, sleep, until } from './helpers';

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
  HoldRoom.debugHeroSwitch = false;
});

/** Opens a lobby, lets each player pick, readies everyone and starts the run. */
async function pickAndStart(picks: [string, string][]) {
  const lobby = await openLobby(colyseus);
  const players: ClientRoom[] = [];
  for (const [name, hero] of picks) {
    const p = await joinPlayer(colyseus, lobby.code, name);
    p.send(MSG.pick, { hero });
    players.push(p);
  }
  await until(
    () => picks.every(([, hero], i) => lobby.room.state.players.get(players[i]!.sessionId)?.hero === hero),
    3000,
    'picks',
  );
  for (const p of players) p.send(MSG.ready, { ready: true });
  await until(() => [...lobby.room.state.players.values()].every((p) => p.ready), 3000, 'ready');
  lobby.host.send(MSG.start, {});
  await until(() => lobby.room.state.phase === 'running', 3000, 'run start');
  return { ...lobby, players };
}

describe('hero pick in the lobby', () => {
  it('a new player is Ember until they pick', async () => {
    const lobby = await openLobby(colyseus);
    const p = await joinPlayer(colyseus, lobby.code, 'A');
    await until(() => lobby.room.state.players.has(p.sessionId), 3000, 'join');
    expect(lobby.room.state.players.get(p.sessionId)!.hero).toBe('ember');
  });

  it('the run starts with each picked kit, duplicates allowed', async () => {
    const { room, players } = await pickAndStart([
      ['A', 'bastion'],
      ['B', 'gale'],
      ['C', 'gale'],
    ]);
    const sim = (i: number) => room.world.heroes.get(players[i]!.sessionId)!;
    expect(sim(0)).toMatchObject({ heroId: 'bastion', speed: TUNING.heroes.bastion.speed });
    expect(sim(1)).toMatchObject({ heroId: 'gale', speed: TUNING.heroes.gale.speed });
    expect(sim(2)).toMatchObject({ heroId: 'gale' });
    expect(room.state.heroes.get(players[0]!.sessionId)!.hero).toBe('bastion');
  });

  it('an invalid pick is refused and changes nothing', async () => {
    const lobby = await openLobby(colyseus);
    const p = await joinPlayer(colyseus, lobby.code, 'A');
    for (const bad of [{ hero: '__proto__' }, { hero: 'brand' }, { hero: 3 }, 'gale', null])
      p.send(MSG.pick, bad);
    p.send(MSG.pick, { hero: 'tide' });
    await until(() => lobby.room.state.players.get(p.sessionId)?.hero === 'tide', 3000, 'valid pick');
    expect(lobby.room.state.phase).toBe('lobby');
  });

  it('a pick during a run is refused', async () => {
    const { room, players } = await pickAndStart([['A', 'ember']]);
    players[0]!.send(MSG.pick, { hero: 'gale' });
    await sleep(150);
    expect(room.state.players.get(players[0]!.sessionId)!.hero).toBe('ember');
    expect(room.world.heroes.get(players[0]!.sessionId)!.heroId).toBe('ember');
  });

  it('the host page cannot pick', async () => {
    const lobby = await openLobby(colyseus);
    lobby.host.send(MSG.pick, { hero: 'gale' });
    await sleep(100);
    expect(lobby.room.state.players.size).toBe(0);
  });
});

describe('casting through real inputs', () => {
  it('Q makes a synced zone; Q again within 5 s does not', async () => {
    const { room, players } = await pickAndStart([['A', 'tide']]);
    const p = players[0]!;
    let seq = 1;
    p.send(MSG.input, input(seq++, { cast: 'q', aimX: 0, aimZ: 8 }));
    await until(() => room.state.zones.size === 1, 3000, 'zone');
    const z = [...room.state.zones.values()][0]!;
    expect(z.element).toBe('water');
    for (let i = 0; i < 10; i++) {
      p.send(MSG.input, input(seq++, { cast: 'q', aimX: 4, aimZ: 8 }));
      await sleep(20);
    }
    await sleep(100);
    expect(room.state.zones.size).toBe(1);
    expect(room.state.heroes.get(p.sessionId)!.qCd).toBeGreaterThan(4);
  });

  it('E uses the utility and starts its cooldown', async () => {
    const { room, players } = await pickAndStart([['A', 'bastion']]);
    const p = players[0]!;
    p.send(MSG.input, input(1, { cast: 'e' }));
    await until(() => room.state.heroes.get(p.sessionId)!.stoneSkin, 3000, 'stone skin');
    expect(room.state.heroes.get(p.sessionId)!.eCd).toBeGreaterThan(13);
  });
});

describe('debug hero switch', () => {
  it('is refused unless the server runs with the debug switch', async () => {
    const { room, players } = await pickAndStart([['A', 'ember']]);
    players[0]!.send(MSG.debugHero, { hero: 'gale' });
    await sleep(150);
    expect(room.world.heroes.get(players[0]!.sessionId)!.heroId).toBe('ember');
  });

  it('switches the hero mid-run when enabled, and the change is synced', async () => {
    HoldRoom.debugHeroSwitch = true;
    const { room, players } = await pickAndStart([['A', 'ember']]);
    const id = players[0]!.sessionId;
    players[0]!.send(MSG.debugHero, { hero: 'gale' });
    await until(() => room.state.heroes.get(id)!.hero === 'gale', 3000, 'switch');
    expect(room.world.heroes.get(id)!.heroId).toBe('gale');
    expect(room.state.players.get(id)!.hero).toBe('gale');
  });

  it('createApp turns it on only when asked', () => {
    createApp({});
    expect(HoldRoom.debugHeroSwitch).toBe(false);
    createApp({ debugHeroSwitch: true });
    expect(HoldRoom.debugHeroSwitch).toBe(true);
  });
});
