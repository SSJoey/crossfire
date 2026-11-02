import { describe, expect, it } from 'vitest';
import { applyDamage, applyHeal } from '@crossfire/shared/rules/health';

describe('health', () => {
  it('damage never takes HP below 0', () => {
    expect(applyDamage(10, 25)).toBe(0);
    expect(applyDamage(0, 5)).toBe(0);
    expect(applyDamage(10, 4)).toBe(6);
    expect(applyDamage(10, 1e308)).toBe(0);
  });

  it('ignores negative, NaN and infinite damage', () => {
    expect(applyDamage(10, -5)).toBe(10);
    expect(applyDamage(10, Number.NaN)).toBe(10);
    expect(applyDamage(10, Number.POSITIVE_INFINITY)).toBe(10);
  });

  it('heal never goes above max and never below 0', () => {
    expect(applyHeal(390, 50, 400)).toBe(400);
    expect(applyHeal(100, 50, 400)).toBe(150);
    expect(applyHeal(100, -50, 400)).toBe(100);
    expect(applyHeal(100, Number.NaN, 400)).toBe(100);
  });
});
