import { describe, expect, it } from 'vitest';
import { TUNING } from '@crossfire/shared/tuning';
import { clampToMap, rayToGround } from '../../../client/src/input/aim';
import { CastLatch, debugEnabled, debugHeroKey } from '../../../client/src/input/cast';
import { InputSeq, isGameKey, KeyState } from '../../../client/src/input/keys';

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

describe('Q and E casts (1b.2)', () => {
  it('a Q release gives exactly one cast "q"; qHeld follows the key', () => {
    const c = new CastLatch();
    c.keyDown('KeyQ', false);
    expect(c.qHeld).toBe(true);
    expect(c.take(true, true)).toBe('none');
    c.keyUp('KeyQ');
    expect(c.qHeld).toBe(false);
    expect(c.take(true, true)).toBe('q');
    expect(c.take(true, true)).toBe('none');
  });

  it('an E press gives one cast "e"; holding E does not repeat it', () => {
    const c = new CastLatch();
    c.keyDown('KeyE', false);
    c.keyDown('KeyE', true); // key repeat
    c.keyDown('KeyE', false); // some systems repeat without the flag
    expect(c.take(true, true)).toBe('e');
    expect(c.take(true, true)).toBe('none');
    c.keyUp('KeyE');
    c.keyDown('KeyE', false);
    expect(c.take(true, true)).toBe('e');
  });

  it('a tap between two sends is not lost', () => {
    const c = new CastLatch();
    c.keyDown('KeyE', false);
    c.keyUp('KeyE');
    c.keyDown('KeyQ', false);
    c.keyUp('KeyQ');
    expect(c.qHeld).toBe(false);
    expect(c.take(true, true)).toBe('q');
    expect(c.take(true, true)).toBe('e');
    expect(c.take(true, true)).toBe('none');
  });

  it('Q and E in the same tick go out as q, then e', () => {
    const c = new CastLatch();
    c.keyDown('KeyQ', false);
    c.keyDown('KeyE', false);
    c.keyUp('KeyQ');
    expect(c.take(true, true)).toBe('q');
    expect(c.take(true, true)).toBe('e');
  });

  it('a window blur while Q is held cancels the cast', () => {
    const c = new CastLatch();
    c.keyDown('KeyQ', false);
    c.cancel();
    expect(c.qHeld).toBe(false);
    c.keyUp('KeyQ');
    expect(c.take(true, true)).toBe('none');
  });

  it('nothing is cast while not standing, and the press is dropped, not saved', () => {
    const c = new CastLatch();
    c.keyDown('KeyQ', false);
    c.keyUp('KeyQ');
    c.keyDown('KeyE', false);
    expect(c.take(false, true)).toBe('none');
    expect(c.take(true, true)).toBe('none');
  });

  it('an E press while the predictor says E is not ready is dropped', () => {
    const c = new CastLatch();
    c.keyDown('KeyE', false);
    expect(c.take(true, false)).toBe('none');
    expect(c.take(true, true)).toBe('none');
  });

  it('Q and E count as game keys (no browser default)', () => {
    expect(isGameKey('KeyQ')).toBe(true);
    expect(isGameKey('KeyE')).toBe(true);
  });
});

describe('debug hero switch keys (1b.2)', () => {
  it('1 to 4 pick Ember, Bastion, Tide and Gale, only in debug mode', () => {
    expect(debugHeroKey('Digit1', true)).toBe('ember');
    expect(debugHeroKey('Digit2', true)).toBe('bastion');
    expect(debugHeroKey('Digit3', true)).toBe('tide');
    expect(debugHeroKey('Digit4', true)).toBe('gale');
    expect(debugHeroKey('Digit5', true)).toBeNull();
    expect(debugHeroKey('Digit1', false)).toBeNull();
  });

  it('debug mode needs ?debug=1 exactly', () => {
    expect(debugEnabled('?debug=1')).toBe(true);
    expect(debugEnabled('?code=ABCD&debug=1')).toBe(true);
    expect(debugEnabled('')).toBe(false);
    expect(debugEnabled('?debug=0')).toBe(false);
    expect(debugEnabled('?debug=true')).toBe(false);
  });
});
