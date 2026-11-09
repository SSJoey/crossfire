import { describe, expect, it } from 'vitest';
import { lerpAngle, SnapshotBuffer } from '../../../client/src/net/interpolation';

const out = { x: 0, z: 0, facing: 0 };

describe('snapshot interpolation', () => {
  it('interpolates between the two snapshots around the render time', () => {
    const b = new SnapshotBuffer(8);
    b.push(1000, 0, 0, 0);
    b.push(1050, 10, -4, 1);
    expect(b.sample(1025, out)).toBe(true);
    expect(out.x).toBeCloseTo(5, 6);
    expect(out.z).toBeCloseTo(-2, 6);
    expect(out.facing).toBeCloseTo(0.5, 6);
  });

  it('holds the newest value when the render time is past it (no extrapolation)', () => {
    const b = new SnapshotBuffer(8);
    b.push(1000, 0, 0, 0);
    b.push(1050, 10, 0, 0);
    b.sample(2000, out);
    expect(out.x).toBe(10);
  });

  it('uses the oldest value when the render time is before it', () => {
    const b = new SnapshotBuffer(8);
    b.push(1000, 3, 0, 0);
    b.push(1050, 10, 0, 0);
    b.sample(500, out);
    expect(out.x).toBe(3);
  });

  it('reports nothing when empty, and a single snapshot is used as is', () => {
    const b = new SnapshotBuffer(8);
    expect(b.sample(1000, out)).toBe(false);
    b.push(1000, 7, 8, 0);
    expect(b.sample(5000, out)).toBe(true);
    expect(out.x).toBe(7);
    expect(out.z).toBe(8);
  });

  it('keeps only the newest snapshots and reuses its storage', () => {
    const b = new SnapshotBuffer(4);
    for (let i = 0; i < 100; i++) b.push(i * 50, i, 0, 0);
    expect(b.size).toBe(4);
    b.sample(97 * 50 + 25, out);
    expect(out.x).toBeCloseTo(97.5, 6);
    b.clear();
    expect(b.size).toBe(0);
  });

  it('takes the short way round when the angle crosses ±π', () => {
    const a = Math.PI - 0.1;
    const c = -Math.PI + 0.1;
    const mid = lerpAngle(a, c, 0.5);
    expect(Math.abs(Math.abs(mid) - Math.PI)).toBeLessThan(1e-6);
    expect(lerpAngle(0, 1, 0.25)).toBeCloseTo(0.25, 6);
  });
});

describe('snapshot rebase after a pause (1b.3)', () => {
  it('keeps only the newest value, re-timed, so nothing slides across the paused gap', () => {
    const b = new SnapshotBuffer(8);
    b.push(1000, 0, 0, 0);
    b.push(1050, 4, 2, 1);
    // Paused for 10 s, then resumed: the old snapshot moves to just before the new one.
    b.rebase(11_000);
    expect(b.size).toBe(1);
    b.push(11_050, 6, 2, 1);
    b.sample(11_000, out);
    expect(out.x).toBe(4);
    b.sample(11_025, out);
    expect(out.x).toBeCloseTo(5, 6);
  });

  it('does nothing on an empty buffer', () => {
    const b = new SnapshotBuffer(8);
    b.rebase(1000);
    expect(b.size).toBe(0);
  });
});
