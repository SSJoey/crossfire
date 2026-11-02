import { describe, expect, it } from 'vitest';
import {
  pixelRatioFor,
  resolveTier,
  saveTier,
  TIER_KEY,
  TIERS,
  type Store,
} from '../../../client/src/render/tiers';

function memStore(init: Record<string, string> = {}): Store & { data: Record<string, string> } {
  const data = { ...init };
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

const throwing: Store = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
};

describe('graphics tiers', () => {
  it('High has shadows and bloom, Medium shadows only, Low neither', () => {
    expect(TIERS.high).toMatchObject({ shadows: true, bloom: true });
    expect(TIERS.medium).toMatchObject({ shadows: true, bloom: false });
    expect(TIERS.low).toMatchObject({ shadows: false, bloom: false });
  });

  it('Low renders at pixel ratio 1; the others cap at 2', () => {
    expect(pixelRatioFor('low', 2)).toBe(1);
    expect(pixelRatioFor('medium', 3)).toBe(2);
    expect(pixelRatioFor('high', 1.25)).toBe(1.25);
  });

  it('defaults to Medium', () => {
    expect(resolveTier('', memStore())).toBe('medium');
    expect(resolveTier('', undefined)).toBe('medium');
  });

  it('the URL beats the saved choice, which beats the default', () => {
    expect(resolveTier('', memStore({ [TIER_KEY]: 'low' }))).toBe('low');
    expect(resolveTier('?gfx=high', memStore({ [TIER_KEY]: 'low' }))).toBe('high');
  });

  it('ignores invalid values', () => {
    expect(resolveTier('?gfx=ultra', memStore({ [TIER_KEY]: '<script>' }))).toBe('medium');
    expect(resolveTier('?gfx=', memStore({ [TIER_KEY]: 'high' }))).toBe('high');
  });

  it('survives storage that throws (private window, blocked site data)', () => {
    expect(resolveTier('', throwing)).toBe('medium');
    expect(() => saveTier(throwing, 'low')).not.toThrow();
  });

  it('saves the choice', () => {
    const s = memStore();
    saveTier(s, 'high');
    expect(s.data[TIER_KEY]).toBe('high');
  });
});
