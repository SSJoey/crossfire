import { describe, expect, it } from 'vitest';
import { kBps, TickStats } from '../../../server/src/log/perf';
import { Rng } from '../../../server/src/sim/rng';

function reference(values: number[], p: number): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(p * s.length) - 1)]!;
}

describe('TickStats', () => {
  it('p95 matches a sorted reference within one bucket', () => {
    const rng = new Rng(3);
    const st = new TickStats(0.05, 50);
    const values: number[] = [];
    for (let i = 0; i < 5000; i++) {
      const v = rng.next() ** 3 * 12;
      values.push(v);
      st.add(v);
    }
    expect(st.count).toBe(5000);
    expect(Math.abs(st.percentile(0.95) - reference(values, 0.95))).toBeLessThanOrEqual(0.05 + 1e-9);
    expect(Math.abs(st.percentile(0.5) - reference(values, 0.5))).toBeLessThanOrEqual(0.05 + 1e-9);
    expect(st.max).toBe(Math.max(...values));
  });

  it('values beyond the histogram report the true maximum', () => {
    const st = new TickStats(0.05, 50);
    for (let i = 0; i < 10; i++) st.add(80);
    expect(st.percentile(0.95)).toBe(80);
    expect(st.max).toBe(80);
  });

  it('is 0 when empty, and reset() starts a new window', () => {
    const st = new TickStats(0.05, 50);
    expect(st.percentile(0.95)).toBe(0);
    st.add(5);
    st.reset();
    expect(st.count).toBe(0);
    expect(st.max).toBe(0);
    expect(st.percentile(0.95)).toBe(0);
    st.add(1);
    expect(st.percentile(0.95)).toBeCloseTo(1, 1);
  });
});

describe('kBps', () => {
  it('kilobytes per second from a byte counter delta', () => {
    expect(kBps(30_000, 10_000, 10_000)).toBe(2);
  });
  it('is 0 for no time or a counter that went backwards', () => {
    expect(kBps(100, 0, 0)).toBe(0);
    expect(kBps(0, 100, 1000)).toBe(0);
  });
});
