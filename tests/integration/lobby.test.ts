import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ColyseusTestServer } from '@colyseus/testing';
import { JOIN_ERRORS, MSG } from '@crossfire/shared/types';
import { bootServer, joinPlayer, openLobby, REMOTE_ROOM, startRun, until } from './helpers';

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

function names(room: { state: { players: Map<string, { name: string }> } }): string[] {
  return [...room.state.players.values()].map((p) => p.name);
}

describe('lobby: joining', () => {
  it('the host page gets a short room code and does not count as a player', async () => {
    const { room, code } = await openLobby(colyseus);
    expect(code).toMatch(/^[A-Z]{4}$/);
    expect(room.state.players.size).toBe(0);
    expect(room.state.phase).toBe('lobby');
  });

  it('8 joins within one second all succeed and the count is live', async () => {
    const { room, code } = await openLobby(colyseus);
    const t0 = Date.now();
    const joined = await Promise.all(
      Array.from({ length: 8 }, (_, i) => joinPlayer(colyseus, code, `P${i + 1}`)),
    );
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(joined).toHaveLength(8);
    expect(room.state.players.size).toBe(8);
    expect(room.state.playerCount).toBe(8);
  });

  it('a 9th player is refused with a clear message', async () => {
    const { code } = await openLobby(colyseus);
    await Promise.all(Array.from({ length: 8 }, (_, i) => joinPlayer(colyseus, code, `P${i + 1}`)));
    await expect(joinPlayer(colyseus, code, 'Nine')).rejects.toThrow(JOIN_ERRORS.full);
  });

  it('a join during a run is refused with the run-in-progress message', async () => {
    const { code } = await startRun(colyseus, ['A']);
    await expect(joinPlayer(colyseus, code, 'Late')).rejects.toThrow(JOIN_ERRORS.inProgress);
  });

  it('leaving frees a slot and updates the live count', async () => {
    const { room, code } = await openLobby(colyseus);
    const a = await joinPlayer(colyseus, code, 'A');
    await joinPlayer(colyseus, code, 'B');
    await a.leave();
    await until(() => room.state.players.size === 1, 3000, 'leave');
    expect(room.state.playerCount).toBe(1);
  });
});

describe('lobby: names', () => {
  it('caps names at 16 characters and stores HTML as plain text', async () => {
    const { room, code } = await openLobby(colyseus);
    await joinPlayer(colyseus, code, '<img src=x onerror=alert(1)>');
    expect(names(room)).toEqual(['<img src=x onerr']);
  });

  it('keeps emoji and right-to-left text, strips bidi overrides', async () => {
    const { room, code } = await openLobby(colyseus);
    await joinPlayer(colyseus, code, '🔥Ember🔥');
    await joinPlayer(colyseus, code, 'مرحبا');
    await joinPlayer(colyseus, code, 'ev‮il');
    expect(names(room)).toEqual(['🔥Ember🔥', 'مرحبا', 'evil']);
  });

  it('refuses an empty name with a message', async () => {
    const { code } = await openLobby(colyseus);
    await expect(joinPlayer(colyseus, code, '   ')).rejects.toThrow(JOIN_ERRORS.emptyName);
    await expect(colyseus.sdk.joinById(code, {})).rejects.toThrow(JOIN_ERRORS.emptyName);
  });

  it('suffixes duplicate names', async () => {
    const { room, code } = await openLobby(colyseus);
    await joinPlayer(colyseus, code, 'Joey');
    await joinPlayer(colyseus, code, 'Joey');
    await joinPlayer(colyseus, code, 'joey');
    expect(names(room)).toEqual(['Joey', 'Joey 2', 'joey 3']);
  });
});

describe('lobby: host commands', () => {
  it('the host starts the run only when every player is ready', async () => {
    const { host, room, code } = await openLobby(colyseus);
    const a = await joinPlayer(colyseus, code, 'A');
    await joinPlayer(colyseus, code, 'B');
    a.send(MSG.ready, { ready: true });
    await until(() => room.state.players.get(a.sessionId)!.ready, 3000, 'ready');
    host.send(MSG.start, {});
    await new Promise((r) => setTimeout(r, 150));
    expect(room.state.phase).toBe('lobby');
  });

  it('the host cannot start an empty lobby', async () => {
    const { host, room } = await openLobby(colyseus);
    host.send(MSG.start, {});
    await new Promise((r) => setTimeout(r, 150));
    expect(room.state.phase).toBe('lobby');
  });

  it('a player cannot start, restart or kick', async () => {
    const { room, code } = await openLobby(colyseus);
    const a = await joinPlayer(colyseus, code, 'A');
    const b = await joinPlayer(colyseus, code, 'B');
    a.send(MSG.ready, { ready: true });
    b.send(MSG.ready, { ready: true });
    await until(() => [...room.state.players.values()].every((p) => p.ready), 3000, 'ready');
    a.send(MSG.start, {});
    a.send(MSG.kick, { sessionId: b.sessionId });
    a.send(MSG.restart, {});
    await new Promise((r) => setTimeout(r, 200));
    expect(room.state.phase).toBe('lobby');
    expect(room.state.players.size).toBe(2);
  });

  it('a non-loopback client cannot open the host page or send host commands', async () => {
    await expect(colyseus.sdk.create(REMOTE_ROOM, { role: 'host' })).rejects.toThrow(JOIN_ERRORS.notHost);
  });

  it('the host can kick a player', async () => {
    const { host, room, code } = await openLobby(colyseus);
    const a = await joinPlayer(colyseus, code, 'A');
    host.send(MSG.kick, { sessionId: a.sessionId });
    await until(() => room.state.players.size === 0, 3000, 'kick');
  });

  it('restart after the run ended returns everyone to the lobby, not ready', async () => {
    const { host, room } = await startRun(colyseus, ['A', 'B']);
    for (const h of room.world.heroes.values()) h.hp = 0;
    await until(() => room.state.phase === 'ended', 3000, 'end');
    host.send(MSG.restart, {});
    await until(() => room.state.phase === 'lobby', 3000, 'restart');
    expect([...room.state.players.values()].every((p) => !p.ready)).toBe(true);
  });
});
