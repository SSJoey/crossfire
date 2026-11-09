import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ColyseusTestServer } from '@colyseus/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MSG, type PerfReport } from '@crossfire/shared/types';
import { HoldRoom } from '../../server/src/rooms/HoldRoom';
import { bootServer, input, joinPlayer, openLobby, sleep, startRun, until } from './helpers';

let colyseus: ColyseusTestServer;
let dir: string;
let prevDir: string | undefined;
let prevDebug: boolean;

beforeAll(async () => {
  prevDir = process.env.LOG_DIR;
  dir = mkdtempSync(join(tmpdir(), 'crossfire-pause-'));
  process.env.LOG_DIR = dir;
  prevDebug = HoldRoom.debugHeroSwitch;
  HoldRoom.debugHeroSwitch = true;
  colyseus = await bootServer();
});
afterAll(async () => {
  await colyseus.shutdown();
  HoldRoom.debugHeroSwitch = prevDebug;
  if (prevDir === undefined) delete process.env.LOG_DIR;
  else process.env.LOG_DIR = prevDir;
});
beforeEach(async () => {
  await colyseus.cleanup();
});

type Line = Record<string, unknown> & { t: number; ev: string };

function lines(code: string): Line[] {
  const f = existsSync(dir) ? readdirSync(dir).find((n) => n.endsWith(`_${code}.jsonl`)) : undefined;
  if (!f) return [];
  return readFileSync(join(dir, f), 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Line);
}

/** Everything a pause must freeze, as plain data. */
function snapshot(room: HoldRoom): unknown {
  const w = room.world;
  const enemies = [];
  for (let i = 0; i < w.enemies.count; i++) {
    const e = w.enemies.items[i]!;
    enemies.push([e.uid, e.x, e.z, e.hp, e.state, e.timer, e.swingCd]);
  }
  const zones = [];
  for (let i = 0; i < w.zones.count; i++) zones.push(w.zones.items[i]!.remaining);
  const bolts = [];
  for (let i = 0; i < w.projectiles.count; i++)
    bolts.push([w.projectiles.items[i]!.x, w.projectiles.items[i]!.z]);
  const heroes = [...w.heroes.values()].map((h) => [
    h.x,
    h.z,
    h.hp,
    h.status,
    h.bleedOut,
    h.reviveProgress,
    h.qCd,
    h.eCd,
    h.attackCd,
  ]);
  return { enemies, zones, bolts, heroes, wave: w.wave, waveState: w.waveState, spawned: w.spawnedThisWave };
}

const report: PerfReport = { tier: 'low', fps: 60, low1: 50, w: 800, h: 600, dpr: 1 };

describe('pause (1b.3)', () => {
  it('a downed player pauses; everything freezes, inputs are ignored; the host resumes', async () => {
    const { room, host, players } = await startRun(colyseus, ['Ann', 'Bo']);
    const [ann, bo] = players as [(typeof players)[0], (typeof players)[0]];
    // A zone and cooldowns, a downed hero, and some enemies on the field.
    ann.send(MSG.input, input(1, { cast: 'q', aimX: 0, aimZ: 5 }));
    ann.send(MSG.input, input(2, { cast: 'e', aimX: 0, aimZ: 5 }));
    await until(() => room.world.zones.count === 1, 3000, 'zone cast');
    room.world.heroes.get(bo.sessionId)!.hp = 0;
    await until(() => room.world.heroes.get(bo.sessionId)!.status === 'downed', 3000, 'Bo downed');
    await until(() => room.world.enemies.count > 0, 5000, 'enemies');

    bo.send(MSG.pause, {});
    await until(() => room.state.paused, 3000, 'paused');
    expect(room.state.pausedBy).toBe('Bo');
    await until(() => ann.state.paused === true && ann.state.pausedBy === 'Bo', 3000, 'paused synced');

    const before = snapshot(room);
    const annHero = room.world.heroes.get(ann.sessionId)!;
    const seq = annHero.input.seq;
    for (let i = 0; i < 10; i++) {
      ann.send(MSG.input, input(100 + i, { moveX: 1, attack: true, cast: i === 0 ? 'e' : 'none' }));
      await sleep(100);
    }
    expect(snapshot(room)).toEqual(before);
    expect(annHero.input.seq).toBe(seq);
    expect(room.state.heroes.get(ann.sessionId)!.lastSeq).toBe(Math.max(0, seq));

    // A player cannot resume.
    const rejected = room.netStats(ann.sessionId)!.rejected;
    ann.send(MSG.resume, {});
    await until(() => room.netStats(ann.sessionId)!.rejected > rejected, 3000, 'resume rejected');
    expect(room.state.paused).toBe(true);

    host.send(MSG.resume, {});
    await until(() => !room.state.paused, 3000, 'resumed');
    const zoneLeft = room.world.zones.items[0]!.remaining;
    await until(
      () => room.world.zones.count === 0 || room.world.zones.items[0]!.remaining < zoneLeft,
      3000,
      'sim runs',
    );
  });

  it('own cooldown after resume; other players and the host are not limited', async () => {
    const { room, host, players } = await startRun(colyseus, ['Ann', 'Bo']);
    const [ann, bo] = players as [(typeof players)[0], (typeof players)[0]];
    room.pauseCooldownMs = 1500;

    ann.send(MSG.pause, {});
    await until(() => room.state.paused, 3000, 'Ann paused');
    // Already paused: a second pause changes nothing.
    bo.send(MSG.pause, {});
    await sleep(200);
    expect(room.state.pausedBy).toBe('Ann');
    host.send(MSG.resume, {});
    await until(() => !room.state.paused, 3000, 'resumed');

    const rejected = room.netStats(ann.sessionId)!.rejected;
    ann.send(MSG.pause, {});
    await until(() => room.netStats(ann.sessionId)!.rejected > rejected, 3000, 'Ann refused');
    expect(room.state.paused).toBe(false);

    bo.send(MSG.pause, {});
    await until(() => room.state.paused && room.state.pausedBy === 'Bo', 3000, 'Bo paused');
    host.send(MSG.resume, {});
    await until(() => !room.state.paused, 3000, 'resumed');

    // The host page pauses with no cooldown, again and again.
    for (let i = 0; i < 2; i++) {
      host.send(MSG.pause, {});
      await until(() => room.state.paused && room.state.pausedBy === '', 3000, 'host paused');
      host.send(MSG.resume, {});
      await until(() => !room.state.paused, 3000, 'resumed');
    }

    await sleep(1500);
    ann.send(MSG.pause, {});
    await until(() => room.state.paused && room.state.pausedBy === 'Ann', 3000, 'Ann after cooldown');
  });

  it('refused in the lobby', async () => {
    const { room, code, host } = await openLobby(colyseus);
    const ann = await joinPlayer(colyseus, code, 'Ann');
    ann.send(MSG.pause, {});
    host.send(MSG.pause, {});
    await until(() => room.netStats(ann.sessionId)!.rejected > 0, 3000, 'rejected');
    await sleep(100);
    expect(room.state.paused).toBe(false);
  });

  it('debug hero switch and perf reports are rejected while paused', async () => {
    const { room, players } = await startRun(colyseus, ['Ann']);
    const ann = players[0]!;
    ann.send(MSG.pause, {});
    await until(() => room.state.paused, 3000, 'paused');
    const rejected = room.netStats(ann.sessionId)!.rejected;
    ann.send(MSG.debugHero, { hero: 'tide' });
    ann.send(MSG.perf, report);
    await until(() => room.netStats(ann.sessionId)!.rejected >= rejected + 2, 3000, 'both rejected');
    expect(room.world.heroes.get(ann.sessionId)!.heroId).toBe('ember');
  });

  it('the pauser leaving keeps the pause; everyone leaving goes back to the lobby unpaused', async () => {
    const { room, players } = await startRun(colyseus, ['Ann', 'Bo']);
    const [ann, bo] = players as [(typeof players)[0], (typeof players)[0]];
    ann.send(MSG.pause, {});
    await until(() => room.state.paused, 3000, 'paused');
    await ann.leave();
    await until(() => room.state.players.size === 1, 3000, 'Ann gone');
    expect(room.state.phase).toBe('running');
    expect(room.state.paused).toBe(true);
    await bo.leave();
    await until(() => room.state.phase === 'lobby', 3000, 'lobby');
    expect(room.state.paused).toBe(false);
    expect(room.state.pausedBy).toBe('');
  });

  it('back to lobby while paused clears the pause; the next run starts unpaused', async () => {
    const { room, host, players } = await startRun(colyseus, ['Ann']);
    players[0]!.send(MSG.pause, {});
    await until(() => room.state.paused, 3000, 'paused');
    host.send(MSG.restart, {});
    await until(() => room.state.phase === 'lobby', 3000, 'lobby');
    expect(room.state.paused).toBe(false);
    players[0]!.send(MSG.ready, { ready: true });
    await until(() => room.state.players.get(players[0]!.sessionId)!.ready, 3000, 'ready');
    host.send(MSG.start, {});
    await until(() => room.state.phase === 'running', 3000, 'running');
    expect(room.state.paused).toBe(false);
  });

  it('match log: paused/resumed lines, no perf lines while paused, durations exclude the pause', async () => {
    const { room, host, code, players } = await startRun(colyseus, ['Ann']);
    room.perfIntervalMs = 300;
    await sleep(400);
    players[0]!.send(MSG.pause, {});
    await until(() => room.state.paused, 3000, 'paused');
    await sleep(2200);
    host.send(MSG.resume, {});
    await until(() => !room.state.paused, 3000, 'resumed');
    host.send(MSG.pause, {});
    await until(() => room.state.paused, 3000, 'host paused');
    await sleep(500);
    // Ending a paused run counts the open pause too.
    host.send(MSG.restart, {});
    await until(() => lines(code).some((l) => l.ev === 'end'), 5000, 'end line');

    const log = lines(code);
    const paused = log.filter((l) => l.ev === 'paused');
    const resumed = log.filter((l) => l.ev === 'resumed');
    expect(paused).toHaveLength(2);
    expect(paused[0]).toMatchObject({ name: 'Ann' });
    expect(paused[1]).toMatchObject({ host: true });
    expect(paused[1]!.name).toBeUndefined();
    expect(resumed).toHaveLength(1);
    expect(resumed[0]!.pausedSec as number).toBeGreaterThanOrEqual(2);
    expect(resumed[0]!.pausedSec as number).toBeLessThan(3.5);

    // No perf line between the pause and the resume.
    const from = paused[0]!.t;
    const to = resumed[0]!.t;
    expect(log.filter((l) => l.ev === 'perf' && l.t > from && l.t <= to)).toEqual([]);

    const end = log.find((l) => l.ev === 'end')!;
    const pausedSec = end.pausedSec as number;
    expect(pausedSec).toBeGreaterThanOrEqual(2.5);
    expect(end.durationSec as number).toBeLessThanOrEqual(Math.round(end.t / 1000 - pausedSec) + 1);
    expect(end.durationSec as number).toBeLessThan(Math.round(end.t / 1000) - 1);
  });
});
