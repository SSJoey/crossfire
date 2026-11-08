import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ColyseusTestServer } from '@colyseus/testing';
import { TUNING } from '@crossfire/shared/tuning';
import { MSG, SERVER_MSG } from '@crossfire/shared/types';
import { bootServer, input, sleep, startRun, until } from './helpers';

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

describe('network: input validation', () => {
  it('a move vector of (3, 4) is applied as length 1', async () => {
    const { room, players } = await startRun(colyseus, ['A']);
    const p = players[0]!;
    p.send(MSG.input, input(1, { moveX: 3, moveZ: 4 }));
    const hero = () => room.world.heroes.get(p.sessionId)!;
    await until(() => hero().input.seq === 1, 3000, 'input');
    expect(hero().input.moveX).toBeCloseTo(0.6);
    expect(hero().input.moveZ).toBeCloseTo(0.8);
  });

  it('NaN, Infinity, huge numbers and strings are rejected; the room keeps running', async () => {
    const { room, players } = await startRun(colyseus, ['A']);
    const p = players[0]!;
    const bad = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1e308, '1', null];
    let seq = 1;
    for (const v of bad) {
      for (const k of ['moveX', 'moveZ', 'aimX', 'aimZ'] as const)
        p.send(MSG.input, { ...input(seq++), [k]: v });
    }
    p.send(MSG.input, input(seq, { moveX: 1 }));
    const hero = () => room.world.heroes.get(p.sessionId)!;
    await until(() => hero().input.seq === seq, 3000, 'good input after bad');
    expect(room.netStats(p.sessionId)!.rejected).toBe(bad.length * 4);
    expect(room.state.phase).toBe('running');
    expect(Number.isFinite(hero().x)).toBe(true);
  });

  it('unknown message types are rejected and counted', async () => {
    const { room, players } = await startRun(colyseus, ['A']);
    const p = players[0]!;
    p.send('teleport', { x: 0, z: 0 });
    p.send('setHp', 99999);
    p.send(12345, {});
    await until(() => room.netStats(p.sessionId)!.unknown === 3, 3000, 'unknown counted');
    expect(room.state.phase).toBe('running');
  });

  it('malformed payloads and garbage bytes never crash the room', async () => {
    const { room, players } = await startRun(colyseus, ['A', 'B']);
    const [p, other] = [players[0]!, players[1]!];
    for (const junk of [null, undefined, [], [1, 2, 3], 'input', 42, { a: { b: { c: [] } } }, true]) {
      p.send(MSG.input, junk);
      p.send(MSG.ready, junk);
      p.send(MSG.kick, junk);
    }
    p.connection.send(new Uint8Array([0xff, 0x00, 0x13, 0x37, 0xde, 0xad, 0xbe, 0xef]));
    p.connection.send(new Uint8Array([13, 0xc1, 0xc1, 0xc1]));
    other.send(MSG.input, input(1, { moveX: 1 }));
    await until(
      () => room.world.heroes.get(other.sessionId)!.input.seq === 1,
      3000,
      'other client still served',
    );
    expect(room.state.phase).toBe('running');
  });

  it('out-of-order inputs: seq 5 then 3 keeps seq 5', async () => {
    const { room, players } = await startRun(colyseus, ['A']);
    const p = players[0]!;
    p.send(MSG.input, input(5, { moveX: 1 }));
    p.send(MSG.input, input(3, { moveX: -1 }));
    p.send(MSG.input, input(4, { moveX: -1 }));
    const hero = () => room.world.heroes.get(p.sessionId)!;
    await until(() => hero().input.seq === 5, 3000, 'seq 5');
    await sleep(100);
    expect(hero().input.seq).toBe(5);
    expect(hero().input.moveX).toBe(1);
  });

  it('stale input from an alt-tabbed client is treated as standing still', async () => {
    const { room, players } = await startRun(colyseus, ['A']);
    const p = players[0]!;
    const hero = () => room.world.heroes.get(p.sessionId)!;
    p.send(MSG.input, input(1, { moveX: 1, attack: true }));
    await until(() => hero().input.seq === 1, 3000, 'input');
    await sleep(TUNING.net.staleInputMs + 150);
    const x = hero().x;
    await sleep(300);
    expect(hero().x).toBe(x);
    expect(hero().input.attack).toBe(false);
    expect(hero().input.moveX).toBe(0);
  });
});

describe('network: rate limit', () => {
  // Changed 2026-11-07 (audit 1, F3): over TUNING.net.maxFramesPerSec a client is cut off at
  // once by Colyseus' frame cap (close 4002); our token bucket handles the range below it.
  it('1,000 messages in one second: the client is cut off by the frame cap; others unaffected', async () => {
    const { room, players } = await startRun(colyseus, ['A', 'B']);
    const [p, other] = [players[0]!, players[1]!];
    const left = new Promise<number>((resolve) => p.onLeave((code) => resolve(code)));
    let seq = 1;
    for (let i = 0; i < 1000; i++) {
      p.send(MSG.input, input(seq++));
      if (i % 50 === 49) await sleep(48);
    }
    expect(await Promise.race([left, sleep(3000).then(() => -1)])).toBe(4002);
    await until(() => !room.state.players.has(p.sessionId), 3000, 'flooder removed');
    expect(room.netStats(p.sessionId)).toBeUndefined();
    other.send(MSG.input, input(1, { moveX: 1 }));
    await until(() => room.world.heroes.get(other.sessionId)?.input.seq === 1, 3000, 'other still served');
    expect(room.state.phase).toBe('running');
  });

  it('a sustained flood under the frame cap is rate-limited, then kicked with 4020; others unaffected', async () => {
    expect(150).toBeLessThan(TUNING.net.maxFramesPerSec);
    const { room, players } = await startRun(colyseus, ['A', 'B']);
    const [p, other] = [players[0]!, players[1]!];
    const kicked = new Promise<number>((resolve) => p.onLeave((code) => resolve(code)));
    let seq = 1;
    const stats = room.netStats(p.sessionId)!;
    const t0 = Date.now();
    const flood = setInterval(() => {
      for (let i = 0; i < 15; i++) p.send(MSG.input, input(seq++));
    }, 100);
    try {
      const code = await Promise.race([kicked, sleep(8000).then(() => -1)]);
      expect(code).toBe(4020);
    } finally {
      clearInterval(flood);
    }
    const elapsed = (Date.now() - t0) / 1000;
    expect(stats.dropped).toBeGreaterThan(0);
    expect(stats.accepted).toBeLessThanOrEqual(
      TUNING.net.burst + Math.ceil(TUNING.net.ratePerSec * elapsed) + 5,
    );
    await until(() => !room.state.players.has(p.sessionId), 3000, 'flooder removed');
    other.send(MSG.input, input(1, { moveX: 1 }));
    await until(() => room.world.heroes.get(other.sessionId)?.input.seq === 1, 3000, 'other still served');
    expect(room.state.phase).toBe('running');
  });
});

describe('network: run end', () => {
  it('all heroes downed in the same tick ends the run and notifies clients once', async () => {
    const { room, players } = await startRun(colyseus, ['A', 'B']);
    let endedCount = 0;
    players[0]!.onMessage(SERVER_MSG.ended, () => endedCount++);
    for (const h of room.world.heroes.values()) h.hp = 0;
    await until(() => room.state.phase === 'ended', 3000, 'ended');
    await sleep(300);
    expect(endedCount).toBe(1);
  });
});
