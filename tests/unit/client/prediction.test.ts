import { describe, expect, it } from 'vitest';
import { HERO_IDS, type HeroId } from '@crossfire/shared/heroes';
import { blinkTarget } from '@crossfire/shared/rules/abilities';
import { stepHero } from '@crossfire/shared/rules/movement';
import { TUNING } from '@crossfire/shared/tuning';
import { Predictor } from '../../../client/src/net/prediction';

const DT = 1 / TUNING.tickHz;
const SPEED = TUNING.heroes.ember.speed;

function predictor(): Predictor {
  const p = new Predictor();
  p.reset(5, 0);
  return p;
}

/** What the server computes for the same inputs, one per tick. */
function serverChain(x: number, z: number, moves: [number, number][]): { x: number; z: number } {
  const pos = { x, z };
  for (const [mx, mz] of moves) stepHero(pos, mx, mz, SPEED, DT);
  return pos;
}

describe('client prediction', () => {
  it('moves the hero locally with the shared movement rule', () => {
    const p = predictor();
    p.applyInput(1, 1, 0);
    p.applyInput(2, 0, 1);
    const expected = serverChain(5, 0, [
      [1, 0],
      [0, 1],
    ]);
    expect(p.x).toBeCloseTo(expected.x, 6);
    expect(p.z).toBeCloseTo(expected.z, 6);
  });

  it('replays unacknowledged inputs on top of the server position', () => {
    const p = predictor();
    const moves: [number, number][] = [
      [1, 0],
      [1, 0],
      [0, -1],
      [0.6, 0.8],
    ];
    moves.forEach(([mx, mz], i) => p.applyInput(i + 1, mx, mz));
    // The server has applied inputs 1 and 2.
    const server = serverChain(5, 0, moves.slice(0, 2));
    p.reconcile(server.x, server.z, 2);
    const expected = serverChain(5, 0, moves);
    expect(p.x).toBeCloseTo(expected.x, 6);
    expect(p.z).toBeCloseTo(expected.z, 6);
    expect(p.pendingCount).toBe(2);
    // No error: the replay matched, so there is nothing to smooth.
    expect(Math.hypot(p.offsetX, p.offsetZ)).toBeLessThan(1e-6);
  });

  it('drops acknowledged inputs', () => {
    const p = predictor();
    for (let i = 1; i <= 5; i++) p.applyInput(i, 1, 0);
    p.reconcile(p.x, p.z, 5);
    expect(p.pendingCount).toBe(0);
  });

  it('caps the pending buffer when the server stops acknowledging', () => {
    const p = predictor();
    for (let i = 1; i <= TUNING.client.pendingInputCap * 3; i++) p.applyInput(i, 0, 1);
    expect(p.pendingCount).toBe(TUNING.client.pendingInputCap);
  });

  it('smooths a small correction instead of jumping', () => {
    const p = predictor();
    p.applyInput(1, 1, 0);
    const before = { x: p.x, z: p.z };
    // The server disagrees by 0.5 m (for example a lost input).
    p.reconcile(before.x - 0.5, before.z, 1);
    expect(p.x).toBeCloseTo(before.x - 0.5, 6);
    // The displayed position starts where it was and eases towards the truth.
    expect(p.offsetX).toBeCloseTo(0.5, 6);
    p.decay(TUNING.client.smoothingSec);
    expect(p.offsetX).toBeGreaterThan(0);
    expect(p.offsetX).toBeLessThan(0.5 * 0.4);
    for (let i = 0; i < 60; i++) p.decay(1 / 60);
    expect(Math.abs(p.offsetX)).toBeLessThan(0.01);
  });

  it('snaps when the correction is larger than the snap distance', () => {
    const p = predictor();
    p.applyInput(1, 1, 0);
    p.reconcile(p.x - TUNING.client.snapDistance - 1, p.z, 1);
    expect(p.offsetX).toBe(0);
    expect(p.offsetZ).toBe(0);
  });

  it('faces the aim point', () => {
    const p = predictor();
    p.setFacingFromAim(5, 10);
    expect(p.facing).toBeCloseTo(0, 6);
    p.setFacingFromAim(10, 0);
    expect(p.facing).toBeCloseTo(Math.PI / 2, 6);
    // Aim on top of the hero keeps the old facing.
    p.setFacingFromAim(p.x, p.z);
    expect(p.facing).toBeCloseTo(Math.PI / 2, 6);
  });

  it('renders a partial step ahead with the held input, without changing the predicted position', () => {
    const p = predictor();
    const out = { x: 0, z: 0 };
    p.renderPos(out, DT / 2, 1, 0);
    expect(out.x).toBeCloseTo(5 + SPEED * (DT / 2), 6);
    expect(p.x).toBe(5);
  });
});

describe('client prediction: hero kits (1b.2)', () => {
  const H = TUNING.heroes;
  const ring = TUNING.ring;

  function hero(id: HeroId, x = 10, z = 0): Predictor {
    const p = new Predictor();
    p.setHero(id);
    p.reset(x, z);
    return p;
  }

  it('each hero predicts at its own speed; a debug switch changes it', () => {
    for (const id of HERO_IDS) {
      const p = hero(id);
      p.applyInput(1, 1, 0);
      expect(p.x - 10, id).toBeCloseTo(H[id].speed * DT, 6);
    }
    const p = hero('ember');
    p.setHero('gale');
    p.applyInput(1, 1, 0);
    expect(p.x - 10).toBeCloseTo(H.gale.speed * DT, 6);
  });

  it('Flame step: the predicted blink matches the shared rule (at most 6 m), then moves as usual', () => {
    const p = hero('ember');
    p.applyInput(1, 1, 0, 'e', 10, 30);
    const want = { x: 0, z: 0 };
    blinkTarget(10, 0, 10, 30, H.ember.utility.range, want, ring);
    stepHero(want, 1, 0, H.ember.speed, DT, ring);
    expect(p.x).toBeCloseTo(want.x, 6);
    expect(p.z).toBeCloseTo(want.z, 6);
    expect(p.z).toBeCloseTo(6, 6);
  });

  it('Flame step stays inside the arena', () => {
    const p = hero('ember', ring.mapRadius - 1, 0);
    p.applyInput(1, 0, 0, 'e', ring.mapRadius + 20, 0);
    expect(Math.hypot(p.x, p.z)).toBeLessThanOrEqual(ring.mapRadius + 1e-9);
  });

  it('an unacknowledged blink is replayed from the server position; an acknowledged one is not replayed', () => {
    const p = hero('ember');
    p.applyInput(1, 0, 0);
    p.applyInput(2, 0, 0, 'e', 10, 30);
    p.applyInput(3, 0, 0);
    // The server has applied input 1 only, and lost 0.3 m somewhere.
    p.reconcile(9.7, 0, 1, 0);
    const want = { x: 0, z: 0 };
    blinkTarget(9.7, 0, 10, 30, H.ember.utility.range, want, ring);
    expect(p.x).toBeCloseTo(want.x, 6);
    expect(p.z).toBeCloseTo(want.z, 6);
    // Now the server has applied the blink: its position already holds it.
    p.reconcile(want.x, want.z, 3, H.ember.utility.cooldownSec - 2 * DT);
    expect(p.x).toBeCloseTo(want.x, 6);
    expect(p.z).toBeCloseTo(want.z, 6);
    expect(p.pendingCount).toBe(0);
  });

  it('Gust dash: 7 m along the aim over 5 ticks, ignoring move input', () => {
    const p = hero('gale');
    const ticks = Math.round(H.gale.utility.durationSec / DT);
    expect(ticks).toBe(5);
    p.applyInput(1, 1, 0, 'e', 10, 30);
    expect(p.dashing).toBe(true);
    for (let i = 2; i <= ticks; i++) p.applyInput(i, 1, 0);
    expect(p.x).toBeCloseTo(10, 6);
    expect(p.z).toBeCloseTo(H.gale.utility.distance, 6);
    expect(p.dashing).toBe(false);
    // Afterwards the move input counts again.
    p.applyInput(ticks + 1, 1, 0);
    expect(p.x).toBeCloseTo(10 + H.gale.speed * DT, 6);
  });

  it('a replay that starts in the middle of a dash finishes it in the stored direction', () => {
    const p = hero('gale');
    p.applyInput(1, 0, 0, 'e', 10, 30);
    for (let i = 2; i <= 5; i++) p.applyInput(i, -1, 0);
    const step = (H.gale.utility.distance / H.gale.utility.durationSec) * DT;
    // The server has applied two dash ticks, and stands 0.2 m to the side.
    p.reconcile(10.2, 2 * step, 2, H.gale.utility.cooldownSec - DT);
    expect(p.x).toBeCloseTo(10.2, 6);
    expect(p.z).toBeCloseTo(H.gale.utility.distance, 6);
  });

  it('renderPos extrapolates along the dash, not along the move input', () => {
    const p = hero('gale');
    p.applyInput(1, 1, 0, 'e', 10, 30);
    const out = { x: 0, z: 0 };
    p.renderPos(out, DT / 2, 1, 0);
    const speed = H.gale.utility.distance / H.gale.utility.durationSec;
    expect(out.x).toBeCloseTo(p.x, 6);
    expect(out.z).toBeCloseTo(p.z + speed * (DT / 2), 6);
  });

  it('eReady is false during the cooldown estimate; an E sent then is not predicted', () => {
    const p = hero('ember');
    expect(p.eReady()).toBe(true);
    p.applyInput(1, 0, 0, 'e', 10, 30);
    expect(p.eReady()).toBe(false);
    const z = p.z;
    p.applyInput(2, 0, 0, 'e', 10, -30);
    expect(p.z).toBeCloseTo(z, 6);
    const cdTicks = Math.round(H.ember.utility.cooldownSec / DT);
    for (let i = 3; i <= cdTicks; i++) p.applyInput(i, 0, 0);
    expect(p.eReady()).toBe(true);
  });

  it('the cooldown estimate follows the server: its eCd minus the replayed inputs', () => {
    const p = hero('ember');
    for (let i = 1; i <= 3; i++) p.applyInput(i, 0, 0);
    // The server says 0.1 s is left after input 1; inputs 2 and 3 tick it to 0.
    p.reconcile(10, 0, 1, 2 * DT);
    expect(p.eReady()).toBe(true);
    p.reconcile(10, 0, 1, 4 * DT);
    expect(p.eReady()).toBe(false);
  });

  it('a blink the server refused snaps back on reconcile', () => {
    const p = hero('ember');
    p.applyInput(1, 0, 0, 'e', 10, 30);
    // The server never blinked: it acknowledges input 1 at the old spot.
    p.reconcile(10, 0, 1, 0);
    expect(p.z).toBeCloseTo(0, 6);
    expect(p.offsetX).toBe(0);
    expect(p.offsetZ).toBe(0);
  });

  it('only Ember blinks and only Gale dashes; Bastion and Tide stand still on E', () => {
    for (const id of ['bastion', 'tide'] as const) {
      const p = hero(id);
      p.applyInput(1, 0, 0, 'e', 10, 30);
      expect(p.x, id).toBeCloseTo(10, 6);
      expect(p.z, id).toBeCloseTo(0, 6);
      expect(p.dashing, id).toBe(false);
      expect(p.eReady(), id).toBe(false);
    }
  });

  it('Q never moves the hero', () => {
    const p = hero('ember');
    p.applyInput(1, 0, 0, 'q', 10, 30);
    expect(p.z).toBeCloseTo(0, 6);
  });
});
