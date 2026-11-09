import { describe, expect, it } from 'vitest';
import { HERO_IDS, type HeroId } from '@crossfire/shared/heroes';
import { TUNING, type Tuning } from '@crossfire/shared/tuning';
import type { CastId, InputMessage } from '@crossfire/shared/types';
import { Predictor } from '../../client/src/net/prediction';
import { World } from '../../server/src/sim/world';

/**
 * Own-hero prediction must move exactly like the server: the real simulation and a Predictor
 * get the same inputs, one per tick, and must agree on the position after every tick.
 */
const TICK_MS = 1000 / TUNING.tickHz;

function quietTuning(): Tuning {
  const t = structuredClone(TUNING);
  t.waves.base = 0;
  t.waves.growth = 0;
  t.ring.drainPerSec = 0;
  t.ring.regenPerSec = 0;
  return t;
}

interface Step {
  moveX: number;
  moveZ: number;
  aimX: number;
  aimZ: number;
  cast: CastId;
}

function script(): Step[] {
  const s: Step[] = [];
  const add = (n: number, p: Partial<Step>) => {
    for (let i = 0; i < n; i++) s.push({ moveX: 0, moveZ: 0, aimX: 0, aimZ: 20, cast: 'none', ...p });
  };
  add(8, { moveX: 1 });
  add(1, { moveX: 0.6, moveZ: 0.8, cast: 'e', aimX: 20, aimZ: 18 });
  add(10, { moveX: -1, aimX: 20, aimZ: 18 });
  add(1, { moveZ: -1, cast: 'q', aimX: -5, aimZ: -30 });
  add(6, { moveZ: -1, aimX: -5, aimZ: -30 });
  // A second E, still on cooldown for every hero: refused by both sides.
  add(1, { moveX: 1, cast: 'e', aimX: -30, aimZ: 0 });
  add(6, { moveX: 1, aimX: -30, aimZ: 0 });
  return s;
}

function run(id: HeroId): void {
  const w = new World({ seed: 1, tuning: quietTuning() });
  w.addHero('a', 'A', id);
  w.start(0);
  const h = w.heroes.get('a')!;
  h.x = 10;
  h.z = 0;
  const p = new Predictor();
  p.setHero(id);
  p.reset(h.x, h.z);
  let now = 0;
  script().forEach((st, i) => {
    const seq = i + 1;
    const inp: InputMessage = { seq, attack: false, revive: false, qHeld: false, ...st };
    // The client only sends E when it predicts it is ready (NOTES.md 2026-11-09, 1b.2 default 5).
    const cast = st.cast === 'e' && !p.eReady() ? 'none' : st.cast;
    now += TICK_MS;
    w.setInput('a', { ...inp, cast }, now);
    w.step(now);
    p.setFacingFromAim(st.aimX, st.aimZ);
    p.applyInput(seq, st.moveX, st.moveZ, cast, st.aimX, st.aimZ);
    expect(p.x, `${id} x after input ${seq}`).toBeCloseTo(h.x, 6);
    expect(p.z, `${id} z after input ${seq}`).toBeCloseTo(h.z, 6);
    // Reconciling with the server's own numbers changes nothing.
    p.reconcile(h.x, h.z, seq, h.eCd);
    expect(Math.hypot(p.offsetX, p.offsetZ), `${id} offset after input ${seq}`).toBeLessThan(1e-6);
  });
  // Each hero's E really fired once (the cooldown is running).
  expect(h.eCd, id).toBeGreaterThan(0);
}

describe('own-hero prediction matches the server simulation', () => {
  for (const id of HERO_IDS) it(`${id}: moves, E and Q, tick by tick`, () => run(id));
});
