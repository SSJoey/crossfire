import { describe, expect, it } from 'vitest';
import { TUNING } from '@crossfire/shared/tuning';
import type { InputMessage } from '@crossfire/shared/types';
import { World } from '../../../server/src/sim/world';

const TICK_MS = 1000 / TUNING.tickHz;

function input(seq: number, patch: Partial<InputMessage> = {}): InputMessage {
  return {
    seq,
    moveX: 0,
    moveZ: 0,
    aimX: 0,
    aimZ: 5,
    attack: false,
    revive: false,
    cast: 'none',
    qHeld: false,
    ...patch,
  };
}

describe('World basics', () => {
  it('spawns minions of the wave level outside the ring', () => {
    const w = new World({ seed: 1 });
    w.addHero('a', 'a');
    w.start(0);
    let now = 0;
    for (let i = 0; i < 40; i++) {
      now += TICK_MS;
      w.setInput('a', input(i), now);
      w.step(now);
    }
    expect(w.enemies.count).toBeGreaterThan(0);
    for (let i = 0; i < w.enemies.count; i++) {
      const e = w.enemies.items[i]!;
      expect(e.level).toBe(1);
      expect(Math.hypot(e.x, e.z)).toBeGreaterThan(TUNING.ring.radius);
    }
  });

  it('stale input: a hero stops moving 250 ms after the last input', () => {
    const w = new World({ seed: 1 });
    w.addHero('a', 'a');
    w.start(0);
    const h = w.heroes.get('a')!;
    h.x = 5;
    h.z = 0;
    w.setInput('a', input(1, { moveX: 1, attack: true }), 0);
    let now = 0;
    for (let i = 0; i < 4; i++) w.step((now += TICK_MS));
    expect(h.x).toBeGreaterThan(5);
    for (let i = 0; i < 2; i++) w.step((now += TICK_MS));
    const x = h.x;
    for (let i = 0; i < 10; i++) w.step((now += TICK_MS));
    expect(h.x).toBe(x);
    expect(h.input.attack).toBe(false);
  });

  it('out-of-order input is ignored', () => {
    const w = new World({ seed: 1 });
    w.addHero('a', 'a');
    w.start(0);
    expect(w.setInput('a', input(5, { moveX: 1 }), 0)).toBe(true);
    expect(w.setInput('a', input(3, { moveX: -1 }), 0)).toBe(false);
    expect(w.heroes.get('a')!.input.moveX).toBe(1);
  });

  it('a bolt kills a level-1 minion in 3 hits', () => {
    expect(Math.ceil(TUNING.minion.baseHp / TUNING.heroes.ember.bolt.damage)).toBe(3);
  });

  it('heroes start around the hold point inside the ring', () => {
    const w = new World({ seed: 1 });
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) w.addHero(id, id);
    w.start(0);
    for (const h of w.heroes.values()) {
      const d = Math.hypot(h.x, h.z);
      expect(d).toBeGreaterThanOrEqual(TUNING.ring.holdRadius);
      expect(d).toBeLessThan(TUNING.ring.radius);
      expect(h.hp).toBe(TUNING.heroes.ember.maxHp);
    }
  });
});

describe('World pause time (1b.3)', () => {
  it('run duration excludes paused time', () => {
    const w = new World({ seed: 1 });
    w.addHero('a', 'a');
    w.start(0);
    w.step(TICK_MS);
    // 30 s on the clock, 20 s of it paused: the run lasted 10 s.
    w.addPausedTime(20_000);
    w.heroes.get('a')!.hp = 0;
    w.heroes.get('a')!.status = 'dead';
    w.step(30_000);
    const ended = w.events.find((e) => e.type === 'runEnded');
    expect(ended).toMatchObject({ type: 'runEnded', durationSec: 10 });
  });
});
