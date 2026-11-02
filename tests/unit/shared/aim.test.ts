import { describe, expect, it } from 'vitest';
import { assistTarget, type AimTarget } from '@crossfire/shared/rules/aim';
import { TUNING } from '@crossfire/shared/tuning';

const range = TUNING.ember.bolt.range;
const cone = TUNING.aim.assistCone;

function e(x: number, z: number, targetable = true): AimTarget {
  return { x, z, targetable };
}

describe('aim assist', () => {
  it('picks the enemy in the cone around the aim direction', () => {
    const list = [e(0, 8), e(8, 0)];
    expect(assistTarget(0, 0, 10, 0, range, cone, list, list.length)).toBe(1);
    expect(assistTarget(0, 0, 0, 10, range, cone, list, list.length)).toBe(0);
  });

  it('prefers the one closest to the aim line, then the nearer one', () => {
    const list = [e(9, 1.5), e(5, 0)];
    expect(assistTarget(0, 0, 10, 0, range, cone, list, list.length)).toBe(1);
  });

  it('returns -1 when nothing is in the cone or in range', () => {
    const outCone = [e(0, 5)];
    expect(assistTarget(0, 0, 10, 0, range, cone, outCone, 1)).toBe(-1);
    const outRange = [e(range + 1, 0)];
    expect(assistTarget(0, 0, 10, 0, range, cone, outRange, 1)).toBe(-1);
  });

  it('ignores enemies that are dead or still spawning', () => {
    const list = [e(5, 0, false), e(7, 0)];
    expect(assistTarget(0, 0, 10, 0, range, cone, list, list.length)).toBe(1);
  });

  it('handles 0 enemies and only reads the first count entries', () => {
    expect(assistTarget(0, 0, 10, 0, range, cone, [], 0)).toBe(-1);
    expect(assistTarget(0, 0, 10, 0, range, cone, [e(5, 0)], 0)).toBe(-1);
  });

  it('handles aiming exactly at the hero position', () => {
    expect(() => assistTarget(1, 1, 1, 1, range, cone, [e(3, 1)], 1)).not.toThrow();
  });
});
