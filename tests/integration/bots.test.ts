import type { ColyseusTestServer } from '@colyseus/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MSG } from '@crossfire/shared/types';
import { Bot } from '../../tools/bots/bot';
import { bootServer, openLobby, until } from './helpers';

let colyseus: ColyseusTestServer;
let bots: Bot[] = [];

beforeAll(async () => {
  colyseus = await bootServer();
});
afterAll(async () => {
  await colyseus.shutdown();
});
beforeEach(async () => {
  await colyseus.cleanup();
});
afterEach(async () => {
  await Promise.all(bots.map((b) => b.stop()));
  bots = [];
});

describe('headless bots', () => {
  it('join, get ready by themselves, play, and get ready again after a restart', async () => {
    const { host, room, code } = await openLobby(colyseus);
    bots = [1, 2, 3].map((i) => new Bot(colyseus.sdk, code, `Bot ${i}`, i));
    await Promise.all(bots.map((b) => b.start()));
    expect(bots.every((b) => b.connected)).toBe(true);

    await until(
      () => room.state.players.size === 3 && [...room.state.players.values()].every((p) => p.ready),
      4000,
      'bots ready',
    );
    expect([...room.state.players.values()].map((p) => p.name).sort()).toEqual(['Bot 1', 'Bot 2', 'Bot 3']);

    host.send(MSG.start, {});
    await until(() => room.state.phase === 'running', 3000, 'running');
    // Bots send inputs (hero input seq advances) and shoot at the first minions.
    await until(() => [...room.world.heroes.values()].every((h) => h.input.seq > 10), 4000, 'bot inputs');
    await until(() => room.world.kills > 0, 15000, 'a kill');
    for (const h of room.world.heroes.values()) expect(Math.hypot(h.x, h.z)).toBeLessThan(14);

    host.send(MSG.restart, {});
    await until(() => room.state.phase === 'lobby', 3000, 'lobby');
    await until(() => [...room.state.players.values()].every((p) => p.ready), 4000, 'ready again');
  });

  it('a refused join rejects start() and leaves the bot disconnected', async () => {
    const bot = new Bot(colyseus.sdk, 'ZZZZ', 'Lost', 1);
    bots = [bot];
    await expect(bot.start()).rejects.toThrow();
    expect(bot.connected).toBe(false);
  });
});
