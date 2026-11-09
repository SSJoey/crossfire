import { describe, expect, it } from 'vitest';
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
