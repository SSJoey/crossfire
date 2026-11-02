import { describe, expect, it } from 'vitest';
import { ViewRegistry } from '../../../client/src/render/views';

interface FakeView {
  n: number;
  visible: boolean;
  dying: boolean;
}

function registry(max: number) {
  let made = 0;
  const log: string[] = [];
  const reg = new ViewRegistry<FakeView>(() => ({ n: made++, visible: false, dying: false }), {
    max,
    onShow: (v) => {
      v.visible = true;
      v.dying = false;
      log.push(`show ${v.n}`);
    },
    onHide: (v) => {
      v.visible = false;
      log.push(`hide ${v.n}`);
    },
    onDie: (v) => {
      v.dying = true;
      log.push(`die ${v.n}`);
    },
  });
  return { reg, log, made: () => made };
}

describe('pooled entity views', () => {
  it('shows a view for a new id and returns the same view for the same id', () => {
    const { reg } = registry(10);
    const a = reg.acquire('1')!;
    expect(a.visible).toBe(true);
    expect(reg.acquire('1')).toBe(a);
    expect(reg.get('1')).toBe(a);
    expect(reg.activeCount).toBe(1);
  });

  it('a killed view plays its death, then goes back to the pool and is reused', () => {
    const { reg, made } = registry(10);
    const a = reg.acquire('1')!;
    reg.kill('1', 3);
    expect(a.dying).toBe(true);
    expect(a.visible).toBe(true);
    expect(reg.get('1')).toBeUndefined();
    expect(reg.dyingCount).toBe(1);
    reg.update(2.9);
    expect(a.visible).toBe(true);
    reg.update(0.2);
    expect(a.visible).toBe(false);
    expect(reg.dyingCount).toBe(0);
    const b = reg.acquire('2')!;
    expect(b).toBe(a);
    expect(b.dying).toBe(false);
    expect(made()).toBe(1);
  });

  it('release hides at once (back to the lobby) without a death', () => {
    const { reg, log } = registry(10);
    reg.acquire('1');
    reg.release('1');
    expect(log).toEqual(['show 0', 'hide 0']);
    expect(reg.activeCount).toBe(0);
  });

  it('never creates more views than its maximum; it recycles the oldest dying view first', () => {
    const { reg, made } = registry(3);
    reg.acquire('a');
    reg.acquire('b');
    reg.acquire('c');
    reg.kill('a', 3);
    reg.update(0.1);
    reg.kill('b', 3);
    const d = reg.acquire('d');
    expect(d).toBeDefined();
    expect(d!.n).toBe(0);
    expect(made()).toBe(3);
    reg.acquire('e');
    expect(made()).toBe(3);
    // Every view is live now: no more room.
    expect(reg.acquire('f')).toBeNull();
  });

  it('releaseAll empties everything', () => {
    const { reg } = registry(5);
    reg.acquire('1');
    reg.acquire('2');
    reg.kill('2', 3);
    reg.releaseAll();
    expect(reg.activeCount).toBe(0);
    expect(reg.dyingCount).toBe(0);
  });

  it('a churn of spawns and kills keeps the pool bounded', () => {
    const { reg, made } = registry(20);
    for (let i = 0; i < 1000; i++) {
      reg.acquire(String(i));
      if (i >= 10) reg.kill(String(i - 10), 1);
      reg.update(0.05);
    }
    expect(made()).toBeLessThanOrEqual(20);
  });
});
