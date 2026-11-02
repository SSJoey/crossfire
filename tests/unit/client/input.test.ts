import { describe, expect, it } from 'vitest';
import { TUNING } from '@crossfire/shared/tuning';
import { clampToMap, rayToGround } from '../../../client/src/input/aim';
import { InputSeq, KeyState } from '../../../client/src/input/keys';

const move = { x: 0, z: 0 };

describe('keyboard movement', () => {
  it('maps WASD to the camera view: W is away from the camera (−Z), D is right (+X)', () => {
    const k = new KeyState();
    k.down('KeyW');
    k.move(move);
    expect(move).toEqual({ x: 0, z: -1 });
    k.up('KeyW');
    k.down('KeyD');
    k.move(move);
    expect(move).toEqual({ x: 1, z: 0 });
    k.up('KeyD');
    k.down('KeyS');
    k.down('KeyA');
    k.move(move);
    expect(move.x).toBeCloseTo(-Math.SQRT1_2, 6);
    expect(move.z).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('normalises diagonals to length 1', () => {
    const k = new KeyState();
    k.down('KeyW');
    k.down('KeyD');
    k.move(move);
    expect(Math.hypot(move.x, move.z)).toBeCloseTo(1, 6);
  });

  it('opposite keys cancel', () => {
    const k = new KeyState();
    k.down('KeyA');
    k.down('KeyD');
    k.move(move);
    expect(move.x).toBe(0);
    expect(move.z).toBe(0);
  });

  it('releasing everything (window blur) stops the hero', () => {
    const k = new KeyState();
    k.down('KeyW');
    k.down('KeyF');
    k.clear();
    k.move(move);
    expect(move).toEqual({ x: 0, z: 0 });
    expect(k.isDown('KeyF')).toBe(false);
  });

  it('ignores keys it does not use', () => {
    const k = new KeyState();
    k.down('KeyP');
    k.move(move);
    expect(move).toEqual({ x: 0, z: 0 });
  });
});

describe('input sequence numbers', () => {
  it('increase with every input', () => {
    const s = new InputSeq();
    const a = s.next();
    const b = s.next();
    const c = s.next();
    expect(b).toBe(a + 1);
    expect(c).toBe(b + 1);
    expect(a).toBeGreaterThanOrEqual(0);
  });
});

describe('aim on the ground', () => {
  it('finds where the mouse ray meets the ground plane', () => {
    const out = { x: 0, z: 0 };
    // From (0, 17, 12.5) straight down-forward towards the origin.
    expect(rayToGround(0, 17, 12.5, 0, -17, -12.5, out)).toBe(true);
    expect(out.x).toBeCloseTo(0, 6);
    expect(out.z).toBeCloseTo(0, 6);
    expect(rayToGround(2, 10, 0, 1, -1, 0, out)).toBe(true);
    expect(out.x).toBeCloseTo(12, 6);
  });

  it('keeps the last aim when the ray is parallel to or points away from the ground', () => {
    const out = { x: 3, z: 4 };
    expect(rayToGround(0, 10, 0, 1, 0, 0, out)).toBe(false);
    expect(rayToGround(0, 10, 0, 0, 1, 0, out)).toBe(false);
    expect(out).toEqual({ x: 3, z: 4 });
  });

  it('clamps the aim point to the map', () => {
    const out = { x: 300, z: 400 };
    clampToMap(out, TUNING.ring.mapRadius);
    expect(Math.hypot(out.x, out.z)).toBeCloseTo(TUNING.ring.mapRadius, 6);
    expect(out.x / out.z).toBeCloseTo(0.75, 6);
    const inside = { x: 1, z: 2 };
    clampToMap(inside, TUNING.ring.mapRadius);
    expect(inside).toEqual({ x: 1, z: 2 });
  });
});
