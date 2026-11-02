import { describe, expect, it } from 'vitest';
import { FixedTicker } from '../../../server/src/sim/tick';

describe('FixedTicker', () => {
  it('runs at a fixed 20 Hz regardless of frame timing', () => {
    let steps = 0;
    const t = new FixedTicker(20, 5, () => steps++);
    for (let i = 0; i < 60; i++) t.advance(1000 / 60);
    expect(steps).toBe(20);
  });

  it('caps catch-up steps after a long stall', () => {
    let steps = 0;
    const t = new FixedTicker(20, 5, () => steps++);
    t.advance(10_000);
    expect(steps).toBe(5);
    t.advance(50);
    expect(steps).toBe(6);
  });

  it('ignores negative and NaN deltas', () => {
    let steps = 0;
    const t = new FixedTicker(20, 5, () => steps++);
    t.advance(-100);
    t.advance(Number.NaN);
    expect(steps).toBe(0);
  });
});
