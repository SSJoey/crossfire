import { describe, expect, it } from 'vitest';
import { stepHero } from '@crossfire/shared/rules/movement';
import { TUNING } from '@crossfire/shared/tuning';

const speed = TUNING.ember.speed;

describe('hero movement', () => {
  it('moves at the hero speed', () => {
    const p = { x: 5, z: 0 };
    stepHero(p, 1, 0, speed, 1);
    expect(p.x).toBeCloseTo(5 + speed);
    expect(p.z).toBeCloseTo(0);
  });

  it('never moves faster than speed even with a long vector', () => {
    const p = { x: 5, z: 5 };
    stepHero(p, 3, 4, speed, 1);
    expect(Math.hypot(p.x - 5, p.z - 5)).toBeCloseTo(speed);
  });

  it('is deterministic: same inputs give the same position', () => {
    const a = { x: 4, z: -3 };
    const b = { x: 4, z: -3 };
    for (let i = 0; i < 200; i++) {
      const mx = Math.sin(i * 0.3);
      const mz = Math.cos(i * 0.7);
      stepHero(a, mx, mz, speed, 0.05);
      stepHero(b, mx, mz, speed, 0.05);
    }
    expect(a).toEqual(b);
  });

  it('is clamped to the map radius', () => {
    const p = { x: 39, z: 0 };
    stepHero(p, 1, 0, speed, 5);
    expect(Math.hypot(p.x, p.z)).toBeCloseTo(TUNING.ring.mapRadius);
  });

  it('is pushed out of the hold platform', () => {
    const p = { x: 3, z: 0 };
    stepHero(p, -1, 0, speed, 1);
    expect(Math.hypot(p.x, p.z)).toBeCloseTo(TUNING.ring.holdRadius);
  });

  it('standing still does not move', () => {
    const p = { x: 6, z: 2 };
    stepHero(p, 0, 0, speed, 1);
    expect(p).toEqual({ x: 6, z: 2 });
  });
});
