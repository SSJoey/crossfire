import { describe, expect, it } from 'vitest';
import { loadTuning } from '@crossfire/shared/rules/loadtest';
import { waveSize } from '@crossfire/shared/rules/scaling';
import { TUNING } from '@crossfire/shared/tuning';

describe('load-test tuning', () => {
  it('heroes take no damage: minion damage and ring drain are 0', () => {
    const t = loadTuning(TUNING, 120);
    expect(t.minion.damage).toBe(0);
    expect(t.ring.drainPerSec).toBe(0);
  });

  it('keeps the field full: one spawn per tick and a wave far larger than the cap', () => {
    const t = loadTuning(TUNING, 120);
    expect(t.waves.spawnIntervalSec).toBeCloseTo(1 / TUNING.tickHz);
    expect(waveSize(1, 1, t.waves)).toBeGreaterThan(100 * TUNING.waves.enemyCap);
  });

  it('the cap is clamped to 1..the game cap and rounded down', () => {
    expect(loadTuning(TUNING, 80).waves.enemyCap).toBe(80);
    expect(loadTuning(TUNING, 80.9).waves.enemyCap).toBe(80);
    expect(loadTuning(TUNING, 500).waves.enemyCap).toBe(TUNING.waves.enemyCap);
    expect(loadTuning(TUNING, 0).waves.enemyCap).toBe(1);
    expect(loadTuning(TUNING, -5).waves.enemyCap).toBe(1);
  });

  it('anything that is not a finite number gives the game cap', () => {
    for (const v of [undefined, null, 'abc', NaN, Infinity, {}, '80'])
      expect(loadTuning(TUNING, v).waves.enemyCap).toBe(TUNING.waves.enemyCap);
  });

  it('leaves the real tuning untouched', () => {
    const before = JSON.stringify(TUNING);
    loadTuning(TUNING, 50);
    expect(JSON.stringify(TUNING)).toBe(before);
  });
});
