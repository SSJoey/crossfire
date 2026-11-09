import { describe, expect, it } from 'vitest';
import { sanitizePerfReport } from '@crossfire/shared/rules/validation';
import type { PerfReport } from '@crossfire/shared/types';
import { PerfReporter } from '../../../client/src/net/perfReport';

const canvas = { w: 1920, h: 1080, dpr: 1 };

/** Feeds `n` frames of `ms` each; returns every report produced. */
function feed(r: PerfReporter, n: number, ms: number, running = true): PerfReport[] {
  const out: PerfReport[] = [];
  for (let i = 0; i < n; i++) {
    const rep = r.frame(ms, running, 'medium', canvas.w, canvas.h, canvas.dpr);
    if (rep) out.push(rep);
  }
  return out;
}

describe('PerfReporter', () => {
  it('reports once per 10 s with the average fps of those 10 s', () => {
    const r = new PerfReporter(10_000);
    expect(feed(r, 599, 1000 / 60)).toEqual([]);
    const reports = feed(r, 1, 1000 / 60);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ tier: 'medium', fps: 60, w: 1920, h: 1080, dpr: 1 });
    // Next window: 20 fps for 10 s.
    const next = feed(r, 200, 50);
    expect(next).toHaveLength(1);
    expect(next[0]!.fps).toBe(20);
  });

  it('1% low comes from the slowest frames of the window', () => {
    const r = new PerfReporter(10_000);
    // 10 frames of 100 ms (1 s) + 540 frames of 1000/60 ms (9 s) = 550 frames in 10 s.
    feed(r, 10, 100);
    const [rep] = feed(r, 540, 1000 / 60);
    expect(rep).toBeDefined();
    expect(rep!.fps).toBeCloseTo(55, 1);
    // Slowest 1% of 550 frames = 6 frames, all 100 ms -> 10 fps.
    expect(rep!.low1).toBeCloseTo(10, 1);
  });

  it('the 1% low of a window ignores slow frames from the previous window', () => {
    const r = new PerfReporter(10_000);
    feed(r, 10, 100);
    feed(r, 540, 1000 / 60);
    const [rep] = feed(r, 600, 1000 / 60);
    expect(rep!.low1).toBeCloseTo(60, 0);
  });

  it('sends nothing outside a run, and a run restarts the window', () => {
    const r = new PerfReporter(10_000);
    expect(feed(r, 1200, 1000 / 60, false)).toEqual([]);
    feed(r, 300, 1000 / 60);
    feed(r, 1, 1000 / 60, false);
    expect(feed(r, 400, 1000 / 60)).toEqual([]);
  });

  it('a gap longer than the cap (sleep or frozen machine) does not count as a frame', () => {
    const r = new PerfReporter(10_000);
    // No visibility event fired (a closed lid may not send one); the first frame back is a 30 s gap.
    expect(feed(r, 1, 30_000)).toEqual([]);
    expect(feed(r, 599, 1000 / 60)).toEqual([]);
    expect(feed(r, 1, 1000 / 60)).toHaveLength(1);
  });

  it('frames slower than 1 s count: a browser below 1 fps shows up as slow', () => {
    const r = new PerfReporter(10_000);
    const reports = feed(r, 4, 2500);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.fps).toBe(0.4);
    expect(reports[0]!.low1).toBe(0.4);
  });

  it('the gap frame after a hidden tab is skipped', () => {
    const r = new PerfReporter(10_000);
    r.hidden();
    expect(feed(r, 1, 30_000)).toEqual([]);
    expect(feed(r, 599, 1000 / 60)).toEqual([]);
    const [rep] = feed(r, 1, 1000 / 60);
    expect(rep!.fps).toBe(60);
  });

  it('only the one gap frame is skipped', () => {
    const r = new PerfReporter(10_000);
    r.hidden();
    expect(feed(r, 1, 5000)).toEqual([]);
    const reports = feed(r, 5, 2000);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.fps).toBe(0.5);
  });

  it('its reports pass the server validation', () => {
    const r = new PerfReporter(10_000);
    const [rep] = feed(r, 1000, 10);
    expect(sanitizePerfReport(rep)).toEqual(rep);
    const [slow] = feed(new PerfReporter(10_000), 4, 2500);
    expect(sanitizePerfReport(slow)).toEqual(slow);
  });
});
