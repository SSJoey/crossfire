import type { Tuning } from '../tuning';

/**
 * Tuning for the test-only load room: heroes take no damage (minions hit for 0, no ring drain),
 * one minion spawns every tick and the wave never runs out, so the field stays at `enemyCap`.
 * Everything else (enemy AI, bolts, kills) runs as in a real game. Returns a copy.
 */
export function loadTuning(base: Tuning, enemyCap: unknown): Tuning {
  const t = structuredClone(base);
  const cap =
    typeof enemyCap === 'number' && Number.isFinite(enemyCap)
      ? Math.min(base.waves.enemyCap, Math.max(1, Math.floor(enemyCap)))
      : base.waves.enemyCap;
  t.minion.damage = 0;
  t.ring.drainPerSec = 0;
  t.waves.enemyCap = cap;
  t.waves.base = base.loadTest.waveBase;
  t.waves.growth = 0;
  t.waves.spawnIntervalSec = 1 / base.tickHz;
  return t;
}
