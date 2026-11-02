import { describe, expect, it } from 'vitest';
import { TUNING } from '@crossfire/shared/tuning';
import type { HeroStatus } from '@crossfire/shared/types';
import { Rng } from '../../../server/src/sim/rng';
import { decide, type BotEnemy, type BotUnit, type BotView } from '../../../tools/bots/brain';

function unit(id: string, x: number, z: number, status: HeroStatus = 'standing'): BotUnit {
  return { id, x, z, status };
}
function enemy(x: number, z: number, state = 'moving'): BotEnemy {
  return { x, z, state };
}
function view(me: BotUnit, others: BotUnit[] = [], enemies: BotEnemy[] = [], timeSec = 0): BotView {
  return { meId: me.id, heroes: [me, ...others], enemies, timeSec, seed: 1 };
}
/** Cosine of the angle between the move vector and the direction to (tx, tz). */
function heading(c: { moveX: number; moveZ: number }, from: BotUnit, tx: number, tz: number): number {
  const dx = tx - from.x;
  const dz = tz - from.z;
  return (c.moveX * dx + c.moveZ * dz) / (Math.hypot(c.moveX, c.moveZ) * Math.hypot(dx, dz));
}

describe('bot brain', () => {
  it('heads back into the ring from outside it', () => {
    const me = unit('a', 13, 0);
    const c = decide(view(me), TUNING);
    expect(heading(c, me, 0, 0)).toBeGreaterThan(0.9);
  });

  it('aims at and attacks the nearest enemy within bolt range', () => {
    const me = unit('a', 0, 4);
    const c = decide(view(me, [], [enemy(0, 14), enemy(6, 4), enemy(-20, 4)]), TUNING);
    expect(c.attack).toBe(true);
    expect(c.aimX).toBeCloseTo(6);
    expect(c.aimZ).toBeCloseTo(4);
  });

  it('does not attack when nothing is in range, or only spawning enemies are', () => {
    const me = unit('a', 0, 4);
    expect(decide(view(me, [], [enemy(0, 4 + TUNING.ember.bolt.range + 3)]), TUNING).attack).toBe(false);
    expect(decide(view(me, [], [enemy(3, 4, 'spawning')]), TUNING).attack).toBe(false);
    expect(decide(view(me), TUNING).attack).toBe(false);
  });

  it('backs away from an enemy closer than 2 m', () => {
    const me = unit('a', 0, 5);
    const c = decide(view(me, [], [enemy(1, 5)]), TUNING);
    expect(c.moveX).toBeLessThan(0);
    expect(c.attack).toBe(true);
  });

  it.each(['downed', 'dead'] as const)(
    'walks to a %s teammate, then holds F inside the revive radius',
    (st) => {
      const far = unit('a', 0, 4);
      const body = unit('b', 6, 4, st);
      const walking = decide(view(far, [body]), TUNING);
      expect(heading(walking, far, 6, 4)).toBeGreaterThan(0.9);
      expect(walking.revive).toBe(false);

      const near = unit('a', 6 - TUNING.revive.radius * 0.3, 4);
      const holding = decide(view(near, [body]), TUNING);
      expect(holding.revive).toBe(true);
    },
  );

  it('ignores a body far outside the ring', () => {
    const me = unit('a', 0, 4);
    const c = decide(view(me, [unit('b', 0, TUNING.ring.radius + 15, 'downed')]), TUNING);
    expect(c.revive).toBe(false);
    expect(Math.hypot(me.x + c.moveX, me.z + c.moveZ)).toBeLessThan(TUNING.ring.radius);
  });

  it('always returns finite numbers and a move vector of length at most 1', () => {
    const rng = new Rng(9);
    const statuses: HeroStatus[] = ['standing', 'downed', 'dead'];
    for (let n = 0; n < 2000; n++) {
      const r = (s: number) => (rng.next() - 0.5) * 2 * s;
      const me = unit('a', r(45), r(45));
      const others = Array.from({ length: Math.floor(rng.next() * 8) }, (_, i) =>
        unit(`h${i}`, r(30), r(30), statuses[Math.floor(rng.next() * 3)]),
      );
      const foes = Array.from({ length: Math.floor(rng.next() * 30) }, () => enemy(r(30), r(30)));
      // Includes enemies exactly on top of the bot.
      if (n % 10 === 0) foes.push(enemy(me.x, me.z));
      const c = decide(view(me, others, foes, rng.next() * 900), TUNING);
      for (const v of [c.moveX, c.moveZ, c.aimX, c.aimZ]) expect(Number.isFinite(v)).toBe(true);
      expect(Math.hypot(c.moveX, c.moveZ)).toBeLessThanOrEqual(1 + 1e-9);
    }
  });
});
