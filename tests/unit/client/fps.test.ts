import { describe, expect, it } from 'vitest';
import { FpsStats } from '../../../client/src/hud/fpsStats';

describe('fps stats', () => {
  it('average fps over the last second', () => {
    const s = new FpsStats(600);
    for (let i = 0; i < 120; i++) s.add(1000 / 60);
    expect(s.fps()).toBeCloseTo(60, 0);
  });

  it('only the last second counts for the average', () => {
    const s = new FpsStats(600);
    for (let i = 0; i < 60; i++) s.add(50); // 3 s at 20 fps
    for (let i = 0; i < 60; i++) s.add(1000 / 60); // 1 s at 60 fps
    expect(s.fps()).toBeCloseTo(60, 0);
  });

  it('1% low comes from the slowest frames', () => {
    const s = new FpsStats(600);
    for (let i = 0; i < 5; i++) s.add(100);
    for (let i = 0; i < 495; i++) s.add(1000 / 60);
    expect(s.low1()).toBeCloseTo(10, 0);
    // The slow frames are older than the last second, so the average is back to 60.
    expect(s.fps()).toBeCloseTo(60, 0);
  });

  it('keeps only the newest frames (fixed buffer)', () => {
    const s = new FpsStats(100);
    for (let i = 0; i < 50; i++) s.add(100);
    for (let i = 0; i < 100; i++) s.add(1000 / 60);
    expect(s.low1()).toBeCloseTo(60, 0);
  });

  it('is 0 with no frames', () => {
    const s = new FpsStats(10);
    expect(s.fps()).toBe(0);
    expect(s.low1()).toBe(0);
  });
});
