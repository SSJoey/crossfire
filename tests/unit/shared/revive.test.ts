import { describe, expect, it } from 'vitest';
import { downIfDepleted, type ReviveHero } from '@crossfire/shared/rules/revive';
import { DT, hero, runRevive as run } from '../helpers';
import { TUNING } from '@crossfire/shared/tuning';

const T = TUNING.revive;
describe('downed and bleed-out', () => {
  it('uses the brief values: 20 s bleed-out, 3 s revive', () => {
    expect(T.bleedOutSec).toBe(20);
    expect(T.downedReviveSec).toBe(3);
    expect(T.deadReviveSec).toBe(5);
    expect(T.radius).toBe(2);
  });

  it('a standing hero at 0 HP goes down with a full bleed-out timer', () => {
    const h = hero('a', 0, 0, { hp: 0 });
    expect(downIfDepleted(h)).toBe(true);
    expect(h.status).toBe('downed');
    expect(h.bleedOut).toBe(T.bleedOutSec);
    expect(downIfDepleted(h)).toBe(false);
  });

  it('a downed hero dies when the bleed-out runs out', () => {
    const a = hero('a', 0, 0, { hp: 0 });
    downIfDepleted(a);
    run([a], T.bleedOutSec - 0.5);
    expect(a.status).toBe('downed');
    run([a], 0.6);
    expect(a.status).toBe('dead');
    expect(a.hp).toBe(0);
  });
});

describe('downed revive', () => {
  it('one teammate holding F within the radius revives after 3 s at 50% HP', () => {
    const a = hero('a', 0, 0, { hp: 0 });
    downIfDepleted(a);
    const b = hero('b', 1.5, 0, { holdingRevive: true });
    run([a, b], T.downedReviveSec - 0.1);
    expect(a.status).toBe('downed');
    run([a, b], 0.15);
    expect(a.status).toBe('standing');
    expect(a.hp).toBe(200);
    expect(a.reviveProgress).toBe(0);
  });

  it('does nothing when the reviver is out of range or not holding F', () => {
    const a = hero('a', 0, 0, { hp: 0 });
    downIfDepleted(a);
    const far = hero('b', 2.5, 0, { holdingRevive: true });
    const idle = hero('c', 1, 0, { holdingRevive: false });
    run([a, far, idle], 5);
    expect(a.status).toBe('downed');
  });

  it('releasing F resets the downed revive', () => {
    const a = hero('a', 0, 0, { hp: 0 });
    downIfDepleted(a);
    const b = hero('b', 1, 0, { holdingRevive: true });
    run([a, b], 2);
    b.holdingRevive = false;
    run([a, b], DT);
    expect(a.reviveProgress).toBe(0);
    b.holdingRevive = true;
    run([a, b], 2);
    expect(a.status).toBe('downed');
  });

  it('a downed hero holding F cannot revive anyone', () => {
    const a = hero('a', 0, 0, { hp: 0 });
    const b = hero('b', 1, 0, { hp: 0 });
    downIfDepleted(a);
    downIfDepleted(b);
    b.holdingRevive = true;
    run([a, b], 4);
    expect(a.status).toBe('downed');
  });

  it('a reviver works on the nearest body only', () => {
    const near = hero('near', 1, 0, { hp: 0 });
    const far = hero('far', -1.8, 0, { hp: 0 });
    downIfDepleted(near);
    downIfDepleted(far);
    const r = hero('r', 0, 0, { holdingRevive: true });
    run([near, far, r], T.downedReviveSec + 0.1);
    expect(near.status).toBe('standing');
    expect(far.status).toBe('downed');
  });
});

describe('full-death revive', () => {
  function deadHero(id: string, x = 0, z = 0): ReviveHero {
    return hero(id, x, z, { status: 'dead', hp: 0 });
  }

  it('needs every standing hero near and holding F; 5 s; 50% HP', () => {
    const d = deadHero('d');
    const a = hero('a', 1, 0, { holdingRevive: true });
    const b = hero('b', -1, 0, { holdingRevive: true });
    run([d, a, b], T.deadReviveSec - 0.1);
    expect(d.status).toBe('dead');
    run([d, a, b], 0.15);
    expect(d.status).toBe('standing');
    expect(d.hp).toBe(200);
  });

  it('does not progress while one standing hero is away', () => {
    const d = deadHero('d');
    const a = hero('a', 1, 0, { holdingRevive: true });
    const away = hero('b', 8, 0, { holdingRevive: true });
    run([d, a, away], 10);
    expect(d.status).toBe('dead');
    expect(d.reviveProgress).toBe(0);
  });

  it('pauses (does not reset) when one lets go', () => {
    const d = deadHero('d');
    const a = hero('a', 1, 0, { holdingRevive: true });
    const b = hero('b', -1, 0, { holdingRevive: true });
    run([d, a, b], 3);
    b.holdingRevive = false;
    run([d, a, b], 2);
    expect(d.reviveProgress).toBeCloseTo(3);
    b.holdingRevive = true;
    run([d, a, b], 2.1);
    expect(d.status).toBe('standing');
  });

  it('downed heroes do not count as living and do not block it', () => {
    const d = deadHero('d');
    const a = hero('a', 1, 0, { holdingRevive: true });
    const downed = hero('x', 9, 0, { hp: 0 });
    downIfDepleted(downed);
    downed.bleedOut = 1000;
    run([d, a, downed], T.deadReviveSec + 0.1);
    expect(d.status).toBe('standing');
  });

  it('nothing happens when nobody is standing', () => {
    const d = deadHero('d');
    const e = deadHero('e', 1, 0);
    run([d, e], 10);
    expect(d.status).toBe('dead');
    expect(e.status).toBe('dead');
  });
});
