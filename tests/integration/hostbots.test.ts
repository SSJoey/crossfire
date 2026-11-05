import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ColyseusTestServer } from '@colyseus/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TUNING } from '@crossfire/shared/tuning';
import { MSG } from '@crossfire/shared/types';
import { logDir } from '../../server/src/log/MatchLog';
import type { HoldRoom } from '../../server/src/rooms/HoldRoom';
import { bootServer, joinPlayer, openLobby, sleep, until } from './helpers';

let colyseus: ColyseusTestServer;
const pids = new Set<number>();

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function bots(room: HoldRoom): string[] {
  return [...room.state.players.values()].filter((p) => p.bot).map((p) => p.name);
}

/** Pid of the room's bot process (remembered so afterEach can check nothing is left behind). */
function botPid(room: HoldRoom): number | undefined {
  const pid = room.botProcessPid;
  if (pid !== undefined) pids.add(pid);
  return pid;
}

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
  await colyseus.cleanup();
  await until(() => [...pids].every((p) => !alive(p)), 5000, 'no bot process left behind');
  pids.clear();
});

describe('bots added from the host page', () => {
  it('Add bot adds bot players that get ready by themselves and play', async () => {
    const { host, room } = await openLobby(colyseus);
    expect(room.botProcessPid).toBeUndefined();
    for (let i = 0; i < 3; i++) host.send(MSG.addBot, {});
    await until(() => room.state.players.size === 3, 8000, '3 bots joined');
    expect(bots(room).sort()).toEqual(['Bot 1', 'Bot 2', 'Bot 3']);
    const pid = botPid(room);
    expect(pid).toBeGreaterThan(0);
    expect(alive(pid!)).toBe(true);
    // One process for all bots of the room.
    await until(() => [...room.state.players.values()].every((p) => p.ready), 4000, 'bots ready');

    host.send(MSG.start, {});
    await until(() => room.state.phase === 'running', 3000, 'running');
    await until(() => [...room.world.heroes.values()].every((h) => h.input.seq > 5), 5000, 'bot inputs');
  });

  it('humans and bots mix; a bot never takes a human name', async () => {
    const { host, room, code } = await openLobby(colyseus);
    await joinPlayer(colyseus, code, 'Bot 1');
    host.send(MSG.addBot, {});
    await until(() => room.state.players.size === 2, 8000, 'bot joined');
    botPid(room);
    const names = [...room.state.players.values()].map((p) => [p.name, p.bot]);
    expect(names).toContainEqual(['Bot 1', false]);
    expect(names).toContainEqual(['Bot 2', true]);
  });

  it('Remove bots removes every bot and stops the bot process', async () => {
    const { host, room, code } = await openLobby(colyseus);
    await joinPlayer(colyseus, code, 'Ann');
    host.send(MSG.addBot, {});
    host.send(MSG.addBot, {});
    await until(() => room.state.players.size === 3, 8000, 'bots joined');
    const pid = botPid(room)!;
    host.send(MSG.removeBots, {});
    await until(() => room.state.players.size === 1, 4000, 'bots removed');
    expect([...room.state.players.values()][0]!.name).toBe('Ann');
    await until(() => !alive(pid), 5000, 'bot process exits');
    expect(room.botProcessPid).toBeUndefined();
  });

  it('kicking the last bot also stops the bot process', async () => {
    const { host, room } = await openLobby(colyseus);
    host.send(MSG.addBot, {});
    await until(() => room.state.players.size === 1, 8000, 'bot joined');
    const pid = botPid(room)!;
    const [id] = [...room.state.players.keys()];
    host.send(MSG.kick, { sessionId: id });
    await until(() => room.state.players.size === 0, 4000, 'bot kicked');
    await until(() => !alive(pid), 5000, 'bot process exits');
  });

  it('a player cannot add or remove bots; the messages are counted', async () => {
    const { host, room, code } = await openLobby(colyseus);
    const ann = await joinPlayer(colyseus, code, 'Ann');
    host.send(MSG.addBot, {});
    await until(() => room.state.players.size === 2, 8000, 'bot joined');
    botPid(room);
    ann.send(MSG.addBot, {});
    ann.send(MSG.addBot, {});
    ann.send(MSG.removeBots, {});
    await until(() => room.netStats(ann.sessionId)!.received >= 3, 3000, 'messages arrive');
    await sleep(1500);
    expect(bots(room)).toEqual(['Bot 1']);
    expect(room.state.players.size).toBe(2);
  });

  it('Add bot and Remove bots do nothing during a run', async () => {
    const { host, room } = await openLobby(colyseus);
    host.send(MSG.addBot, {});
    await until(() => room.state.players.size === 1, 8000, 'bot joined');
    botPid(room);
    await until(() => [...room.state.players.values()].every((p) => p.ready), 4000, 'ready');
    host.send(MSG.start, {});
    await until(() => room.state.phase === 'running', 3000, 'running');
    host.send(MSG.addBot, {});
    host.send(MSG.removeBots, {});
    await sleep(1500);
    expect(bots(room)).toEqual(['Bot 1']);
    expect(room.state.phase).toBe('running');
  });

  it('20 quick Add bot clicks never take the room past 8 players', async () => {
    const { host, room, code } = await openLobby(colyseus);
    await joinPlayer(colyseus, code, 'Ann');
    await joinPlayer(colyseus, code, 'Bo');
    for (let i = 0; i < 20; i++) host.send(MSG.addBot, {});
    await until(() => room.state.players.size === TUNING.lobby.maxPlayers, 10000, 'room full');
    botPid(room);
    await sleep(1500);
    expect(room.state.players.size).toBe(TUNING.lobby.maxPlayers);
    expect(bots(room)).toHaveLength(6);
    // A human still gets the normal "full" refusal.
    await expect(joinPlayer(colyseus, code, 'Cy')).rejects.toThrow(/full/);
  });

  it('a made-up bot ticket joins as a normal player', async () => {
    const { host, room, code } = await openLobby(colyseus);
    host.send(MSG.addBot, {});
    await until(() => room.state.players.size === 1, 8000, 'bot joined');
    botPid(room);
    const forged = await colyseus.sdk.joinById(code, {
      name: 'Mallory',
      botTicket: '00000000-0000-4000-8000-000000000000',
    });
    const p = room.state.players.get(forged.sessionId)!;
    expect(p.name).toBe('Mallory');
    expect(p.bot).toBe(false);
    const odd = await colyseus.sdk.joinById(code, { name: 'Odd', botTicket: { $ne: null } });
    expect(room.state.players.get(odd.sessionId)!.bot).toBe(false);
  });

  it('the last host page leaving removes the bots and stops the bot process', async () => {
    const { host, room, code } = await openLobby(colyseus);
    const ann = await joinPlayer(colyseus, code, 'Ann');
    host.send(MSG.addBot, {});
    host.send(MSG.addBot, {});
    await until(() => room.state.players.size === 3, 8000, 'bots joined');
    const pid = botPid(room)!;
    await host.leave();
    await until(() => !alive(pid), 5000, 'bot process exits');
    await until(() => bots(room).length === 0, 4000, 'bots gone');
    expect(room.state.players.has(ann.sessionId)).toBe(true);
  });

  it('a second host page keeps the bots; closing the room leaves no bot process', async () => {
    const { host, room, code } = await openLobby(colyseus);
    const host2 = await colyseus.sdk.joinById(code, { role: 'host' });
    host.send(MSG.addBot, {});
    await until(() => room.state.players.size === 1, 8000, 'bot joined');
    const pid = botPid(room)!;
    await host.leave();
    await sleep(500);
    expect(bots(room)).toEqual(['Bot 1']);
    await host2.leave();
    await until(() => !alive(pid), 5000, 'bot process exits');
  });

  it('the match log start line lists the bots', async () => {
    const { host, room, code } = await openLobby(colyseus);
    const ann = await joinPlayer(colyseus, code, 'Ann');
    host.send(MSG.addBot, {});
    await until(() => room.state.players.size === 2, 8000, 'bot joined');
    botPid(room);
    ann.send(MSG.ready, { ready: true });
    await until(() => [...room.state.players.values()].every((p) => p.ready), 4000, 'ready');
    host.send(MSG.start, {});
    await until(() => room.state.phase === 'running', 3000, 'running');
    const startLine = () => {
      const f = existsSync(logDir())
        ? readdirSync(logDir()).find((n) => n.endsWith(`_${code}.jsonl`))
        : undefined;
      return f ? (JSON.parse(readFileSync(join(logDir(), f), 'utf8').split('\n')[0]!) as object) : undefined;
    };
    await until(() => startLine() !== undefined, 3000, 'start line');
    expect(startLine()).toMatchObject({ ev: 'start', players: ['Ann', 'Bot 1'], bots: ['Bot 1'] });
  });
});
