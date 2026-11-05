import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Room as ClientRoom } from '@colyseus/sdk';
import type { ColyseusTestServer } from '@colyseus/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MSG } from '@crossfire/shared/types';
import { bootServer, input, joinPlayer, openLobby, sleep, startRun, until } from './helpers';

let colyseus: ColyseusTestServer;
let dir: string;
let prevDir: string | undefined;

beforeAll(async () => {
  prevDir = process.env.LOG_DIR;
  dir = mkdtempSync(join(tmpdir(), 'crossfire-matchlog-'));
  process.env.LOG_DIR = dir;
  colyseus = await bootServer();
});
afterAll(async () => {
  await colyseus.shutdown();
  if (prevDir === undefined) delete process.env.LOG_DIR;
  else process.env.LOG_DIR = prevDir;
});
beforeEach(async () => {
  await colyseus.cleanup();
});

type Line = Record<string, unknown> & { t: number; ev: string };

function filesFor(code: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(`_${code}.jsonl`)) : [];
}

function lines(code: string, index = 0): Line[] {
  const f = filesFor(code)[index];
  if (!f) return [];
  return readFileSync(join(dir, f), 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Line);
}

async function waitForLine(code: string, pred: (l: Line) => boolean, label: string, index = 0) {
  await until(() => lines(code, index).some(pred), 5000, label);
  return lines(code, index).find(pred)!;
}

/** The first perf line written after the first `from` lines of the file. */
async function perfLineAfter(code: string, from: number): Promise<Line> {
  const find = () =>
    lines(code)
      .slice(from)
      .find((l) => l.ev === 'perf');
  await until(() => find() !== undefined, 5000, 'perf line');
  return find()!;
}

describe('match log', () => {
  it('nothing is written while the room is only a lobby', async () => {
    const { code } = await openLobby(colyseus);
    await joinPlayer(colyseus, code, 'Ann');
    expect(filesFor(code)).toEqual([]);
  });

  it('a run writes start and wave lines with names only', async () => {
    const { code, players } = await startRun(colyseus, ['Ann', 'Bo']);
    const start = await waitForLine(code, (l) => l.ev === 'start', 'start line');
    expect(start.t).toBe(0);
    expect(start.code).toBe(code);
    expect(start.players).toEqual(['Ann', 'Bo']);
    expect(typeof start.at).toBe('string');
    expect(typeof start.seed).toBe('number');
    await waitForLine(code, (l) => l.ev === 'waveStarted' && l.wave === 1, 'wave 1');

    const text = readFileSync(join(dir, filesFor(code)[0]!), 'utf8');
    for (const p of players) expect(text).not.toContain(p.sessionId);
    expect(text).not.toMatch(/127\.0\.0\.1|::1|::ffff/);
  });

  it('host restart ends the file with reason "aborted"', async () => {
    const { code, host } = await startRun(colyseus, ['Ann']);
    host.send(MSG.restart, {});
    const end = await waitForLine(code, (l) => l.ev === 'end', 'end line');
    expect(end.reason).toBe('aborted');
    expect(end).toMatchObject({ wave: 1 });
    expect(typeof end.durationSec).toBe('number');
    expect(typeof end.kills).toBe('number');
    expect(typeof end.tickP95Ms).toBe('number');
  });

  it('everyone dead ends the file with reason "wiped" and logs each death by name', async () => {
    const { code, room } = await startRun(colyseus, ['Ann', 'Bo']);
    for (const h of room.world.heroes.values()) {
      h.hp = 0;
      h.status = 'dead';
    }
    const end = await waitForLine(code, (l) => l.ev === 'end', 'end line');
    expect(end.reason).toBe('wiped');
    const died = lines(code)
      .filter((l) => l.ev === 'died')
      .map((l) => l.name)
      .sort();
    expect(died).toEqual(['Ann', 'Bo']);
  });

  it('the last player leaving ends the file with reason "empty"', async () => {
    const { code, players } = await startRun(colyseus, ['Ann', 'Bo']);
    await players[0]!.leave();
    const left = await waitForLine(code, (l) => l.ev === 'left', 'left line');
    expect(left).toMatchObject({ name: 'Ann', reason: 'left' });
    await players[1]!.leave();
    const end = await waitForLine(code, (l) => l.ev === 'end', 'end line');
    expect(end.reason).toBe('empty');
  });

  it('a kick is logged by name', async () => {
    const { code, host, players } = await startRun(colyseus, ['Ann', 'Bo']);
    host.send(MSG.kick, { sessionId: players[1]!.sessionId });
    const left = await waitForLine(code, (l) => l.ev === 'left', 'left line');
    expect(left).toMatchObject({ name: 'Bo', reason: 'kicked' });
  });

  it('perf lines carry tick time, memory, counts and kB/s for each player by name', async () => {
    const { code, room, players } = await startRun(colyseus, ['Ann', 'Bo']);
    room.perfIntervalMs = 300;
    let seq = 1;
    const timer = setInterval(() => {
      for (const p of players) p.send(MSG.input, input(seq, { attack: true }));
      seq++;
    }, 50);
    try {
      const perf = await waitForLine(code, (l) => l.ev === 'perf' && l.t > 500, 'perf line');
      expect(perf.tickP95Ms as number).toBeGreaterThan(0);
      expect(perf.tickMaxMs as number).toBeGreaterThanOrEqual(perf.tickP95Ms as number);
      expect(perf.heapMB as number).toBeGreaterThan(0);
      expect(perf.rssMB as number).toBeGreaterThan(0);
      expect(perf.players).toBe(2);
      expect(typeof perf.enemies).toBe('number');
      expect(typeof perf.bolts).toBe('number');
      const k = perf.kBps as Record<string, number>;
      expect(Object.keys(k).sort()).toEqual(['Ann', 'Bo']);
      expect(k.Ann).toBeGreaterThan(0);
      expect(k.Bo).toBeGreaterThan(0);
      expect(perf.kBpsMax as number).toBeGreaterThanOrEqual(perf.kBpsAvg as number);
    } finally {
      clearInterval(timer);
    }
  });

  it('client perf reports appear in perf lines by name; bad, too frequent and old ones do not', async () => {
    const { code, room, host, players } = await startRun(colyseus, ['Ann', 'Bo']);
    const [ann, bo] = players as [ClientRoom, ClientRoom];
    room.perfIntervalMs = 300;
    const good = { tier: 'low', fps: 59.94, low1: 48.2, w: 1920, h: 1080, dpr: 1 };
    ann.send(MSG.perf, good);
    // Too soon after the first one: rejected.
    ann.send(MSG.perf, { ...good, fps: 1 });
    // Invalid: rejected.
    bo.send(MSG.perf, { ...good, tier: 'ultra' });
    bo.send(MSG.perf, { ...good, fps: Number.NaN });
    // The host page is not a player: ignored.
    host.send(MSG.perf, good);
    await until(() => room.netStats(bo.sessionId)!.rejected >= 2, 3000, 'bo rejected');
    await until(() => room.netStats(ann.sessionId)!.rejected >= 1, 3000, 'ann rejected');
    const perf = await perfLineAfter(code, lines(code).length);
    expect(perf.clients).toEqual({ Ann: { tier: 'low', fps: 59.9, low1: 48.2, w: 1920, h: 1080, dpr: 1 } });

    // Reports older than the max age are left out.
    room.clientReportMaxAgeMs = 200;
    await sleep(400);
    const later = await perfLineAfter(code, lines(code).length);
    expect(later.clients).toEqual({});
  });

  it('perf reports sent in the lobby are ignored', async () => {
    const { code, room } = await openLobby(colyseus);
    const ann = await joinPlayer(colyseus, code, 'Ann');
    ann.send(MSG.perf, { tier: 'low', fps: 60, low1: 50, w: 800, h: 600, dpr: 1 });
    await until(() => room.netStats(ann.sessionId)!.received >= 1, 3000, 'received');
    ann.send(MSG.ready, { ready: true });
    await until(() => room.state.players.get(ann.sessionId)!.ready, 3000, 'ready');
    room.perfIntervalMs = 200;
    (await colyseus.sdk.joinById(code, { role: 'host' })).send(MSG.start, {});
    await until(() => room.state.phase === 'running', 3000, 'running');
    const perf = await waitForLine(code, (l) => l.ev === 'perf', 'perf line');
    expect(perf.clients).toEqual({});
  });

  it('a second run in the same room starts a new file', async () => {
    const { code, host, players, room } = await startRun(colyseus, ['Ann']);
    host.send(MSG.restart, {});
    await waitForLine(code, (l) => l.ev === 'end', 'first end');
    await until(() => room.state.phase === 'lobby', 3000, 'lobby');
    players[0]!.send(MSG.ready, { ready: true });
    await until(() => [...room.state.players.values()].every((p) => p.ready), 3000, 'ready');
    host.send(MSG.start, {});
    await until(() => filesFor(code).length === 2, 5000, 'second file');
  });
});
