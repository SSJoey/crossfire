import { describe, expect, it } from 'vitest';
import { downIfDepleted, stepRevive } from '@crossfire/shared/rules/revive';
import { TUNING, type Tuning } from '@crossfire/shared/tuning';
import type { InputMessage } from '@crossfire/shared/types';
import { World } from '../../../server/src/sim/world';
import { DT, hero, runRevive } from '../helpers';

const TICK_MS = 1000 / TUNING.tickHz;

function tuning(patch: (t: Tuning) => void): Tuning {
  const t = structuredClone(TUNING);
  patch(t);
  return t;
}

function idle(seq: number, patch: Partial<InputMessage> = {}): InputMessage {
  return { seq, moveX: 0, moveZ: 0, aimX: 0, aimZ: 5, attack: false, revive: false, ...patch };
}

function makeWorld(
  ids: string[],
  t: Tuning = TUNING,
): { w: World; now: () => number; step: (n?: number) => void } {
  const w = new World({ seed: 7, tuning: t });
  for (const id of ids) w.addHero(id, id);
  let now = 0;
  w.start(now);
  return {
    w,
    now: () => now,
    step: (n = 1) => {
      for (let i = 0; i < n; i++) {
        now += TICK_MS;
        for (const id of ids) if (w.heroes.has(id)) w.setInput(id, idle(Math.floor(now)), now);
        w.step(now);
      }
    },
  };
}

describe('edge: revive interrupted by the reviver going down', () => {
  it('resets the downed revive when the reviver goes down', () => {
    const a = hero('a', 0, 0, { hp: 0 });
    downIfDepleted(a);
    const b = hero('b', 1, 0, { holdingRevive: true });
    runRevive([a, b], 2);
    expect(a.reviveProgress).toBeGreaterThan(1.9);
    b.hp = 0;
    downIfDepleted(b);
    stepRevive([a, b], DT);
    expect(a.reviveProgress).toBe(0);
    runRevive([a, b], 5);
    expect(a.status).toBe('downed');
  });

  it('full-death revive: when a helper goes down, the remaining standing heroes suffice', () => {
    const d = hero('d', 0, 0, { status: 'dead', hp: 0 });
    const a = hero('a', 1, 0, { holdingRevive: true });
    const b = hero('b', -1, 0, { holdingRevive: true });
    runRevive([d, a, b], 2);
    b.hp = 0;
    downIfDepleted(b);
    runRevive([d, a, b], TUNING.revive.deadReviveSec - 2 + 0.1);
    expect(d.status).toBe('standing');
  });
});

describe('edge: all heroes downed in the same tick', () => {
  it('ends the run once with one runEnded event', () => {
    const { w, step } = makeWorld(['a', 'b', 'c']);
    step(2);
    for (const h of w.heroes.values()) h.hp = 0;
    step();
    expect(w.phase).toBe('ended');
    const ended = w.events.filter((e) => e.type === 'runEnded');
    expect(ended).toHaveLength(1);
    step(10);
    expect(w.events.filter((e) => e.type === 'runEnded')).toHaveLength(0);
    expect(w.phase).toBe('ended');
  });

  it('a run with one downed and one dead hero ends too (nobody standing)', () => {
    const { w, step } = makeWorld(['a', 'b']);
    const [a, b] = [...w.heroes.values()];
    a!.status = 'dead';
    a!.hp = 0;
    b!.hp = 0;
    step();
    expect(w.phase).toBe('ended');
  });
});

describe('edge: hero exactly on the ring edge', () => {
  it('d = 14 counts as inside (regen), d = 14 + 0.01 drains', () => {
    const { w, step } = makeWorld(['a', 'b']);
    const [a, b] = [...w.heroes.values()];
    a!.x = TUNING.ring.radius;
    a!.z = 0;
    a!.hp = 300;
    b!.x = -(TUNING.ring.radius + 0.01);
    b!.z = 0;
    b!.hp = 300;
    step();
    expect(a!.hp).toBeCloseTo(300 + TUNING.ring.regenPerSec * DT);
    expect(b!.hp).toBeCloseTo(300 - TUNING.ring.drainPerSec * DT);
  });
});

describe('edge: 0 enemies alive', () => {
  it('a cleared wave goes to the break and then starts the next wave', () => {
    const t = tuning((t) => {
      t.waves.base = 2;
      t.waves.growth = 0;
    });
    const { w, step } = makeWorld(['a'], t);
    expect(w.wave).toBe(1);
    step(Math.ceil((t.waves.spawnIntervalSec * 4) / DT));
    expect(w.enemies.count).toBe(2);
    while (w.enemies.count > 0) w.enemies.release(0);
    step();
    expect(w.waveState).toBe('break');
    expect(w.events.some((e) => e.type === 'waveCleared' && e.wave === 1)).toBe(true);
    step(Math.ceil(t.waves.breakSec / DT) + 1);
    expect(w.wave).toBe(2);
    expect(w.waveState).toBe('spawning');
  });

  it('heroes attacking with no enemies do not throw and still fire at the aim point', () => {
    const { w } = makeWorld(['a']);
    let now = 0;
    for (let i = 0; i < 20; i++) {
      now += TICK_MS;
      w.setInput('a', idle(i, { attack: true, aimX: 8, aimZ: 0 }), now);
      expect(() => w.step(now)).not.toThrow();
    }
    expect(w.enemies.count).toBeGreaterThanOrEqual(0);
    expect(w.projectiles.count).toBeGreaterThan(0);
  });
});

describe('edge: enemy cap reached', () => {
  it('never exceeds the cap and resumes spawning when one dies', () => {
    const t = tuning((t) => {
      t.waves.enemyCap = 10;
      t.waves.base = 50;
      t.ember.maxHp = 1e7;
    });
    const { w, step } = makeWorld(['a'], t);
    let max = 0;
    for (let i = 0; i < 200; i++) {
      step();
      max = Math.max(max, w.enemies.count);
    }
    expect(max).toBe(10);
    expect(w.enemies.count).toBe(10);
    const spawnedBefore = w.spawnedThisWave;
    w.enemies.release(0);
    w.enemies.release(0);
    w.enemies.release(0);
    step(Math.ceil((t.waves.spawnIntervalSec * 4) / DT));
    expect(w.enemies.count).toBe(10);
    expect(w.spawnedThisWave).toBe(spawnedBefore + 3);
  });

  it('the default cap is 120', () => {
    expect(TUNING.waves.enemyCap).toBe(120);
  });
});

describe('enemies ignore downed heroes', () => {
  it('a downed hero takes no damage and only bleeds out', () => {
    const t = tuning((t) => {
      t.waves.base = 20;
    });
    const { w, step } = makeWorld(['a', 'b'], t);
    const [a, b] = [...w.heroes.values()];
    b!.maxHp = 1e7;
    b!.hp = 1e7;
    a!.hp = 0;
    step();
    expect(a!.status).toBe('downed');
    for (let i = 0; i < Math.round(10 / DT); i++) {
      step();
      for (let k = 0; k < w.enemies.count; k++) expect(w.enemies.items[k]!.targetId).not.toBe('a');
    }
    expect(a!.hp).toBe(0);
    expect(a!.status).toBe('downed');
  });
});
