import { describe, expect, it } from 'vitest';
import { isOutsideRing, ringHealth } from '@crossfire/shared/rules/ring';
import { TUNING } from '@crossfire/shared/tuning';

const R = TUNING.ring.radius;

describe('soft-edge ring', () => {
  it('uses the look-test starting values', () => {
    expect(R).toBe(14);
    expect(TUNING.ring.drainPerSec).toBe(26);
    expect(TUNING.ring.regenPerSec).toBe(7);
  });

  it('drains 26 HP/s outside the ring', () => {
    expect(ringHealth(400, 400, R + 2, 0, 1, 'standing')).toBeCloseTo(374);
    expect(ringHealth(400, 400, 0, -(R + 5), 0.5, 'standing')).toBeCloseTo(387);
  });

  it('regenerates inside the ring, capped at max HP', () => {
    expect(ringHealth(100, 400, 3, 3, 1, 'standing')).toBeCloseTo(107);
    expect(ringHealth(398, 400, 3, 3, 1, 'standing')).toBe(400);
  });

  it('can drain a hero to 0 (downed is decided by the caller) and never below', () => {
    expect(ringHealth(10, 400, R + 1, 0, 1, 'standing')).toBe(0);
  });

  it('downed and dead heroes neither drain nor regenerate', () => {
    expect(ringHealth(0, 400, R + 5, 0, 1, 'downed')).toBe(0);
    expect(ringHealth(0, 400, 0, 3, 1, 'downed')).toBe(0);
    expect(ringHealth(0, 400, 0, 3, 1, 'dead')).toBe(0);
  });

  it('isOutsideRing is strict', () => {
    expect(isOutsideRing(R, 0)).toBe(false);
    expect(isOutsideRing(R + 0.001, 0)).toBe(true);
  });
});
