import { describe, expect, it } from 'vitest';
import type { HeroId } from '@crossfire/shared/heroes';
import { TUNING, type Tuning } from '@crossfire/shared/tuning';
import type { InputMessage } from '@crossfire/shared/types';
import type { SimEnemy } from '../../../server/src/sim/enemies';
import { World } from '../../../server/src/sim/world';

const TICK_MS = 1000 / TUNING.tickHz;
const DT = 1 / TUNING.tickHz;
const H = TUNING.heroes;
const Z = TUNING.zones;

/** No waves and harmless minions, so each test controls every enemy. */
function quietTuning(): Tuning {
  const t = structuredClone(TUNING);
  t.waves.base = 0;
  t.waves.growth = 0;
  t.minion.damage = 0;
  t.ring.regenPerSec = 0;
  t.ring.drainPerSec = 0;
  return t;
}

function input(seq: number, patch: Partial<InputMessage> = {}): InputMessage {
  return {
    seq,
    moveX: 0,
    moveZ: 0,
    aimX: 10,
    aimZ: 5,
    attack: false,
    revive: false,
    cast: 'none',
    qHeld: false,
    ...patch,
  };
}

class Sim {
  readonly w: World;
  now = 0;
  private seq = 0;
  /** Enemies held in place after every tick (melee knockback would push them out of reach). */
  private readonly pins: [SimEnemy, number, number][] = [];

  constructor(heroes: [string, HeroId][], t = quietTuning()) {
    this.w = new World({ seed: 1, tuning: t });
    for (const [id, hero] of heroes) this.w.addHero(id, id, hero);
    this.w.start(0);
    // Everyone stands at (10, 0), facing +z, unless the test moves them.
    for (const h of this.w.heroes.values()) {
      h.x = 10;
      h.z = 0;
      h.facing = 0;
    }
  }

  hero(id: string) {
    return this.w.heroes.get(id)!;
  }

  /** Sends one input for `id` and steps one tick (other heroes keep fresh empty inputs). */
  tick(id?: string, patch: Partial<InputMessage> = {}): void {
    this.now += TICK_MS;
    this.seq++;
    for (const h of this.w.heroes.values()) {
      const p = h.id === id ? patch : {};
      this.w.setInput(h.id, input(this.seq, { aimX: h.x, aimZ: h.z + 5, ...p }), this.now);
    }
    this.w.step(this.now);
    for (const [e, x, z] of this.pins) {
      e.x = x;
      e.z = z;
      e.kvx = 0;
      e.kvz = 0;
    }
  }

  pin(e: SimEnemy): SimEnemy {
    this.pins.push([e, e.x, e.z]);
    return e;
  }

  run(seconds: number, id?: string, patch: Partial<InputMessage> = {}): void {
    for (let i = 0; i < Math.round(seconds / DT); i++) this.tick(id, patch);
  }

  /** A risen, motionless minion at (x, z). */
  foe(x: number, z: number, hp = 10_000): SimEnemy {
    const e = this.w.enemies.spawn(x, z, 1, this.w.t)!;
    e.state = 'moving';
    e.timer = 0;
    e.targetable = true;
    e.speed = 0;
    e.hp = hp;
    e.maxHp = hp;
    return e;
  }
}

describe('cooldowns cannot be bypassed', () => {
  it('spamming Q: a cast on every input for 30 s gives one zone per 5 s cooldown', () => {
    for (const id of ['ember', 'bastion', 'tide', 'gale'] as const) {
      const s = new Sim([['a', id]]);
      let casts = 0;
      let prevCd = 0;
      for (let i = 0; i < Math.round(30 / DT); i++) {
        s.tick('a', { cast: 'q', qHeld: true, aimX: 10, aimZ: 6 });
        const cd = s.hero('a').qCd;
        if (cd > prevCd + 1e-9) casts++;
        prevCd = cd;
      }
      // Casts at 0.05 s, then every cooldown: 0.05, 5.05, … 25.05.
      expect(casts, id).toBe(Math.ceil(30 / Z.cooldownSec));
    }
  });

  it('spamming E: one use per cooldown for every hero', () => {
    for (const id of ['ember', 'bastion', 'tide', 'gale'] as const) {
      const s = new Sim([['a', id]]);
      let uses = 0;
      let prevCd = 0;
      for (let i = 0; i < Math.round(30 / DT); i++) {
        // Aim back at the start point so blinks and dashes stay in the map.
        const h = s.hero('a');
        s.tick('a', { cast: 'e', aimX: h.x > 10 ? 6 : 14, aimZ: 0 });
        const cd = s.hero('a').eCd;
        if (cd > prevCd + 1e-9) uses++;
        prevCd = cd;
      }
      expect(uses, id).toBe(Math.ceil(30 / H[id].utility.cooldownSec));
    }
  });

  it('a cast on the tick the cooldown has 1 ms left is dropped, not queued', () => {
    const s = new Sim([['a', 'ember']]);
    s.tick('a', { cast: 'q' });
    expect(s.w.zones.count).toBe(1);
    s.hero('a').qCd = 0.001 + DT; // 1 ms left after this tick's decrement
    s.tick('a', { cast: 'q' });
    expect(s.w.zones.count).toBe(1);
    s.tick('a');
    expect(s.w.zones.count).toBe(1);
  });

  it('the attack cooldown holds for melee heroes too', () => {
    const s = new Sim([['a', 'gale']]);
    const e = s.pin(s.foe(10, 1.5));
    const hp0 = e.hp;
    s.run(1, 'a', { attack: true, aimX: 10, aimZ: 1.5 });
    // 1 s at a 0.45 s interval → 3 swings (t = 0, 0.45, 0.9), below Tailwind's 4th.
    expect(hp0 - e.hp).toBe(3 * H.gale.melee.damage);
  });
});

describe('casting while downed or dead is refused', () => {
  for (const status of ['downed', 'dead'] as const) {
    it(`${status}: Q and E do nothing and start no cooldown`, () => {
      const s = new Sim([
        ['a', 'tide'],
        ['b', 'ember'],
      ]);
      const a = s.hero('a');
      a.status = status;
      a.prevStatus = status;
      a.hp = 0;
      a.bleedOut = 10;
      s.tick('a', { cast: 'q' });
      s.tick('a', { cast: 'e' });
      expect(s.w.zones.count).toBe(0);
      expect(a.qCd).toBe(0);
      expect(a.eCd).toBe(0);
      expect(a.hp).toBe(0);
    });
  }

  it('a cast sent just before going down is not saved for after the revive', () => {
    const s = new Sim([
      ['a', 'ember'],
      ['b', 'ember'],
    ]);
    const a = s.hero('a');
    a.hp = 0; // downed at the start of the next tick
    s.tick('a', { cast: 'q' });
    expect(a.status).not.toBe('standing');
    a.status = 'standing';
    a.hp = 200;
    s.tick('a');
    expect(s.w.zones.count).toBe(0);
  });
});

describe('Q zones do what their definition says', () => {
  it('a cast beyond range is clamped to 11 m', () => {
    const s = new Sim([['a', 'ember']]);
    s.tick('a', { cast: 'q', aimX: 10, aimZ: 30 });
    const zn = s.w.zones.items[0]!;
    expect(zn.x).toBeCloseTo(10);
    expect(zn.z).toBeCloseTo(11);
    expect(zn.element).toBe('fire');
  });

  it('fire zone: 14 damage per second for 4.2 s, then it is gone', () => {
    const s = new Sim([['a', 'ember']]);
    const e = s.foe(10, 8);
    s.tick('a', { cast: 'q', aimX: 10, aimZ: 8 });
    s.run(1);
    expect(10_000 - e.hp).toBeCloseTo(14 * 1.05, 1); // the cast tick + 20 ticks
    s.run(Z.durationSec);
    expect(s.w.zones.count).toBe(0);
    expect(10_000 - e.hp).toBeCloseTo(14 * Z.durationSec, 0);
  });

  it('zones skip enemies outside the radius and enemies still rising', () => {
    const s = new Sim([['a', 'ember']]);
    const out = s.foe(10, 8 + Z.radius + 0.5);
    const rising = s.foe(10, 8);
    rising.state = 'spawning';
    rising.targetable = false;
    rising.timer = 100;
    s.tick('a', { cast: 'q', aimX: 10, aimZ: 8 });
    s.run(1);
    expect(out.hp).toBe(10_000);
    expect(rising.hp).toBe(10_000);
  });

  it('quake slam: 30 on cast and a 1 s stun, then 6 per second', () => {
    const s = new Sim([['a', 'bastion']]);
    const e = s.foe(10, 8);
    e.speed = 2;
    s.tick('a', { cast: 'q', aimX: 10, aimZ: 8 });
    expect(10_000 - e.hp).toBeCloseTo(30 + 6 * DT, 3);
    expect(e.stunT).toBeGreaterThan(0.9);
    const z0 = e.z;
    s.run(0.9);
    expect(e.z).toBeCloseTo(z0, 5); // stunned: does not walk toward the hero
    s.run(0.3);
    expect(e.z).toBeLessThan(z0); // walks again
    expect(10_000 - e.hp).toBeCloseTo(30 + 6 * 1.25, 0);
  });

  it('tidal pool: 6 per second and a 50% slow while inside', () => {
    const s = new Sim([['a', 'tide']]);
    const e = s.foe(10, 8);
    e.speed = 2;
    s.tick('a', { cast: 'q', aimX: 10, aimZ: 8 });
    const z0 = e.z;
    s.run(0.5);
    expect(z0 - e.z).toBeCloseTo(2 * 0.5 * 0.5, 1);
    expect(10_000 - e.hp).toBeCloseTo(6 * 0.55, 1);
  });

  it('cyclone: 6 per second and a pull to the centre at 2 m/s', () => {
    const s = new Sim([['a', 'gale']]);
    const e = s.foe(10 + 2, 8); // motionless: only the pull moves it
    s.tick('a', { cast: 'q', aimX: 10, aimZ: 8 });
    const z = s.w.zones.items[0]!;
    expect(z.x).toBeCloseTo(10);
    s.run(0.5);
    expect(Math.hypot(e.x - z.x, e.z - z.z)).toBeCloseTo(2 - 2 * 0.55, 1);
    s.run(2);
    expect(Math.hypot(e.x - z.x, e.z - z.z)).toBeLessThan(0.05); // pulled in, not past the centre
    expect(10_000 - e.hp).toBeGreaterThan(6 * 2.5 - 0.5);
  });

  it('zone kills count as kills', () => {
    const s = new Sim([['a', 'ember']]);
    s.foe(10, 8, 5);
    s.tick('a', { cast: 'q', aimX: 10, aimZ: 8 });
    s.run(1);
    expect(s.w.kills).toBe(1);
    expect(s.w.enemies.count).toBe(0);
  });
});

describe('E utilities do what their definition says', () => {
  it('Flame step: blinks toward the aim, at most 6 m', () => {
    const s = new Sim([['a', 'ember']]);
    s.tick('a', { cast: 'e', aimX: 10, aimZ: 20 });
    expect(s.hero('a').x).toBeCloseTo(10);
    expect(s.hero('a').z).toBeCloseTo(6);
    expect(s.hero('a').eCd).toBeCloseTo(H.ember.utility.cooldownSec, 5);
  });

  it('Stone skin: −60% (×0.34 with Steadfast) for 4 s, and taunts enemies within 6 m only', () => {
    const t = quietTuning();
    t.minion.damage = 10;
    const s = new Sim(
      [
        ['b', 'bastion'],
        ['e', 'ember'],
      ],
      t,
    );
    s.hero('e').x = -10; // the ember is far from both minions
    const near = s.foe(10, 5.5);
    const far = s.foe(10, 6.6);
    near.speed = far.speed = 0;
    s.tick('b', { cast: 'e' });
    expect(s.hero('b').stoneSkinT).toBeCloseTo(4 - DT, 5);
    expect(near.tauntId).toBe('b');
    expect(far.tauntId).toBeNull();
    s.run(3.5);
    expect(near.targetId).toBe('b');
    s.run(1);
    expect(s.hero('b').stoneSkinT).toBe(0);
    expect(near.tauntT).toBe(0);
  });

  it('Stone skin and Steadfast reduce a real minion hit', () => {
    const t = quietTuning();
    t.minion.damage = 10;
    const s = new Sim([['b', 'bastion']], t);
    const e = s.foe(10, 1.2);
    e.damage = 10;
    s.run(1); // one swing lands (wind-up 0.42 s)
    expect(400 - s.hero('b').hp).toBeCloseTo(8.5, 5);
    s.tick('b', { cast: 'e' });
    s.run(2); // the next swing lands under Stone skin
    expect(400 - s.hero('b').hp).toBeCloseTo(8.5 + 3.4, 5);
  });

  it('Mending wave: +30% max HP to self and standing allies within 6 m, capped; the downed are not healed', () => {
    const s = new Sim([
      ['t', 'tide'],
      ['near', 'ember'],
      ['far', 'ember'],
      ['full', 'gale'],
      ['down', 'bastion'],
    ]);
    const set = (id: string, x: number, hp: number) => {
      s.hero(id).x = x;
      s.hero(id).hp = hp;
    };
    set('t', 10, 100);
    set('near', 15.5, 100);
    set('far', 16.5, 100);
    set('full', 11, 350);
    set('down', 11, 0);
    s.hero('down').status = 'downed';
    s.hero('down').prevStatus = 'downed';
    s.hero('down').bleedOut = 10;
    s.tick('t', { cast: 'e' });
    expect(s.hero('t').hp).toBeCloseTo(220);
    expect(s.hero('near').hp).toBeCloseTo(220);
    expect(s.hero('far').hp).toBeCloseTo(100);
    expect(s.hero('full').hp).toBe(400);
    expect(s.hero('down').hp).toBe(0);
    expect(s.hero('down').status).toBe('downed');
  });

  it('Gust dash: 7 m toward the aim over 0.25 s, enemies on the path knocked 3 m aside', () => {
    const s = new Sim([['g', 'gale']]);
    const onPath = s.foe(10.4, 3);
    const offPath = s.foe(7, 3); // 3 m to the other side, clear of where onPath slides
    s.tick('g', { cast: 'e', aimX: 10, aimZ: 20 });
    s.run(0.25);
    expect(s.hero('g').x).toBeCloseTo(10, 3);
    expect(s.hero('g').z).toBeCloseTo(7, 1);
    s.run(1.5); // the knockback slides out
    expect(onPath.x - 10.4).toBeCloseTo(3, 0);
    expect(onPath.z).toBeCloseTo(3, 1);
    expect(offPath.x).toBeCloseTo(7, 3);
  });

  it('Gust dash ignores move input while dashing', () => {
    const s = new Sim([['g', 'gale']]);
    s.tick('g', { cast: 'e', aimX: 10, aimZ: 20, moveX: 1 });
    s.run(0.2, 'g', { moveX: 1 });
    expect(s.hero('g').x).toBeCloseTo(10, 3);
  });
});

describe('passives do what their definition says', () => {
  /** Lets one bolt from `id` at the foe land and returns the foe. */
  function boltHit(id: HeroId) {
    const s = new Sim([['a', id]]);
    const e = s.foe(10, 4);
    e.speed = 2;
    s.tick('a', { attack: true, aimX: 10, aimZ: 4 });
    for (let i = 0; i < 10 && e.hp === 10_000; i++) s.tick('a');
    return { s, e };
  }

  it('Kindle: an Ember bolt burns 4/s for 2 s; a new hit refreshes, never stacks', () => {
    const { s, e } = boltHit('ember');
    expect(10_000 - e.hp).toBe(20);
    expect(e.burnT).toBeGreaterThan(1.9);
    s.run(1);
    expect(10_000 - e.hp).toBeCloseTo(20 + 4, 0);
    s.run(1.5);
    expect(10_000 - e.hp).toBeCloseTo(20 + 8, 0);
    expect(e.burnT).toBe(0);
  });

  it('Kindle refresh: repeated hits burn 4/s, never 8/s', () => {
    const s = new Sim([['a', 'ember']]);
    const e = s.foe(10, 3);
    let hits = 0;
    let prev = e.hp;
    for (let i = 0; i < Math.round(3 / DT); i++) {
      s.tick('a', { attack: true, aimX: 10, aimZ: 3 });
      const d = prev - e.hp;
      prev = e.hp;
      if (d >= 20) hits++;
      else if (d > 0) expect(d).toBeCloseTo(4 * DT, 9);
    }
    expect(hits).toBeGreaterThanOrEqual(4);
  });

  it('Tide bolts do not burn; Ember bolts do not slow', () => {
    expect(boltHit('tide').e.burnT).toBe(0);
    expect(boltHit('ember').e.boltSlowT).toBe(0);
  });

  it('Undertow: a Tide bolt slows 30% for 1.5 s', () => {
    const { s, e } = boltHit('tide');
    expect(10_000 - e.hp).toBe(16);
    expect(e.boltSlowFrac).toBe(0.3);
    expect(e.boltSlowT).toBeGreaterThan(1.4);
    s.hero('a').z = -6;
    const z0 = e.z;
    s.run(0.5);
    expect(z0 - e.z).toBeCloseTo(2 * 0.7 * 0.5, 1);
    s.run(1.2);
    expect(e.boltSlowT).toBe(0);
  });

  it('Undertow inside a tidal pool: the strongest slow wins (50%, not 80%)', () => {
    const s = new Sim([
      ['a', 'tide'],
      ['b', 'tide'],
    ]);
    s.hero('b').x = 4; // within 11 m of the pool
    const e = s.foe(10, 6);
    e.speed = 2;
    s.tick('b', { cast: 'q', aimX: 10, aimZ: 6 });
    s.tick('a', { attack: true, aimX: 10, aimZ: 6 });
    for (let i = 0; i < 10 && e.boltSlowT === 0; i++) s.tick();
    const z0 = e.z;
    s.run(0.5);
    expect(z0 - e.z).toBeCloseTo(2 * 0.5 * 0.5, 1);
  });

  it('Steadfast: Bastion takes 15% less from a minion, an Ember does not', () => {
    const t = quietTuning();
    t.minion.damage = 10;
    for (const [id, taken] of [
      ['bastion', 8.5],
      ['ember', 10],
    ] as const) {
      const s = new Sim([['a', id]], t);
      const e = s.foe(10, 1.2);
      e.damage = 10;
      s.run(1);
      expect(400 - s.hero('a').hp, id).toBeCloseTo(taken, 5);
    }
  });

  it('Tailwind: the 4th hitting swing deals double to everything it hits; misses do not count', () => {
    const s = new Sim([['g', 'gale']]);
    const g = s.hero('g');
    // Two misses first (nothing in reach).
    s.run(0.9, 'g', { attack: true, aimX: 10, aimZ: 5 });
    expect(g.tailwindCount).toBe(0);
    const a = s.pin(s.foe(10, 1.5));
    const b = s.pin(s.foe(10.6, 1.5));
    const log: number[] = [];
    let prev = a.hp;
    for (let i = 0; i < Math.round(2.25 / DT); i++) {
      s.tick('g', { attack: true, aimX: 10, aimZ: 1.5 });
      if (a.hp !== prev) log.push(prev - a.hp);
      prev = a.hp;
    }
    expect(log.slice(0, 5)).toEqual([22, 22, 22, 44, 22]);
    expect(10_000 - b.hp).toBe(10_000 - a.hp);
  });
});

describe('melee basic attack', () => {
  it('hits enemies in the front arc within reach, not behind', () => {
    const s = new Sim([['b', 'bastion']]);
    const front = s.foe(10, 2);
    const behind = s.foe(10, -2);
    s.tick('b', { attack: true, aimX: 10, aimZ: 2 });
    expect(10_000 - front.hp).toBe(34);
    expect(behind.hp).toBe(10_000);
  });

  it('knocks hit enemies back a little', () => {
    const s = new Sim([['b', 'bastion']]);
    const e = s.foe(10, 2);
    s.tick('b', { attack: true, aimX: 10, aimZ: 2 });
    s.run(1);
    expect(e.z).toBeGreaterThan(2.3);
  });

  it('aim assist turns the swing toward an enemy near the aim line', () => {
    const s = new Sim([['b', 'bastion']]);
    const e = s.foe(10.7, 1.8); // 0.37 rad off the aim line, inside the 0.45 rad cone
    s.tick('b', { attack: true, aimX: 10, aimZ: 5 });
    expect(10_000 - e.hp).toBe(34);
    expect(s.hero('b').facing).toBeCloseTo(Math.atan2(0.7, 1.8), 5);
  });

  it('a melee kill counts as a kill', () => {
    const s = new Sim([['b', 'bastion']]);
    s.foe(10, 2, 30);
    s.tick('b', { attack: true, aimX: 10, aimZ: 2 });
    s.tick('b');
    expect(s.w.kills).toBe(1);
  });
});

describe('duplicate heroes side by side', () => {
  it('two Embers: both fire zones on one enemy stack', () => {
    const s = new Sim([
      ['a', 'ember'],
      ['b', 'ember'],
    ]);
    s.hero('b').x = 11;
    const e = s.foe(10, 8);
    s.tick('a', { cast: 'q', aimX: 10, aimZ: 8 });
    s.tick('b', { cast: 'q', aimX: 10, aimZ: 8 });
    s.run(1);
    expect(s.w.zones.count).toBe(2);
    expect(10_000 - e.hp).toBeCloseTo(14 * 1.1 + 14 * 1.05, 0);
  });

  it('two Gales dash in the same tick and both arrive', () => {
    const s = new Sim([
      ['a', 'gale'],
      ['b', 'gale'],
    ]);
    s.hero('b').x = 12;
    s.now += TICK_MS;
    s.w.setInput('a', input(1, { cast: 'e', aimX: 10, aimZ: 20 }), s.now);
    s.w.setInput('b', input(1, { cast: 'e', aimX: 12, aimZ: 20 }), s.now);
    s.w.step(s.now);
    s.run(0.3);
    expect(s.hero('a').z).toBeCloseTo(7, 1);
    expect(s.hero('b').z).toBeCloseTo(7, 1);
    expect(s.hero('a').x).toBeCloseTo(10, 3);
    expect(s.hero('b').x).toBeCloseTo(12, 3);
  });

  it('two Bastions: the latest Stone skin takes the taunt', () => {
    const s = new Sim([
      ['a', 'bastion'],
      ['b', 'bastion'],
    ]);
    s.hero('b').x = 12;
    const e = s.foe(11, 4);
    s.tick('a', { cast: 'e' });
    expect(e.tauntId).toBe('a');
    s.tick('b', { cast: 'e' });
    expect(e.tauntId).toBe('b');
  });

  it('two Tides: both heals apply, each capped', () => {
    const s = new Sim([
      ['a', 'tide'],
      ['b', 'tide'],
    ]);
    s.hero('a').hp = 100;
    s.hero('b').hp = 300;
    s.now += TICK_MS;
    s.w.setInput('a', input(1, { cast: 'e' }), s.now);
    s.w.setInput('b', input(1, { cast: 'e' }), s.now);
    s.w.step(s.now);
    expect(s.hero('a').hp).toBeCloseTo(340);
    expect(s.hero('b').hp).toBe(400);
  });

  it('8 heroes, duplicates of all four, fight for 60 s with no NaN', () => {
    const roster: [string, HeroId][] = [];
    const ids: HeroId[] = ['ember', 'bastion', 'tide', 'gale'];
    for (let i = 0; i < 8; i++) roster.push([`p${i}`, ids[i % 4]!]);
    const w = new World({ seed: 7 });
    for (const [id, hero] of roster) w.addHero(id, id, hero);
    w.start(0);
    let now = 0;
    for (let i = 0; i < Math.round(60 / DT); i++) {
      now += TICK_MS;
      let k = 0;
      for (const h of w.heroes.values()) {
        const a = (i / 40 + k++) % (Math.PI * 2);
        const cast = i % 37 === k ? 'q' : i % 53 === k ? 'e' : 'none';
        w.setInput(
          h.id,
          input(i + 1, {
            moveX: Math.cos(a),
            moveZ: Math.sin(a),
            aimX: Math.cos(a) * 9,
            aimZ: Math.sin(a) * 9,
            attack: true,
            cast,
          }),
          now,
        );
      }
      w.step(now);
      for (const h of w.heroes.values()) {
        expect(Number.isFinite(h.x) && Number.isFinite(h.z) && Number.isFinite(h.hp)).toBe(true);
      }
      for (let j = 0; j < w.enemies.count; j++) {
        const e = w.enemies.items[j]!;
        expect(Number.isFinite(e.x) && Number.isFinite(e.z) && Number.isFinite(e.hp)).toBe(true);
      }
      if (w.phase !== 'running') break;
    }
  });
});

describe('hero pick and the debug switch', () => {
  it('a picked hero starts with its own kit', () => {
    const s = new Sim([
      ['a', 'bastion'],
      ['b', 'gale'],
    ]);
    expect(s.hero('a')).toMatchObject({ heroId: 'bastion', maxHp: 400, speed: 4.8 });
    expect(s.hero('b')).toMatchObject({ heroId: 'gale', speed: 6.4 });
  });

  it('switchHero keeps the HP fraction and the remaining cooldowns', () => {
    const s = new Sim([['a', 'tide']]);
    s.tick('a', { cast: 'q' });
    s.tick('a', { cast: 'e' });
    const a = s.hero('a');
    a.hp = 100;
    const q = a.qCd;
    const e = a.eCd;
    s.run(1);
    expect(s.w.switchHero('a', 'gale')).toBe(true);
    expect(a).toMatchObject({ heroId: 'gale', speed: 6.4, hp: 100 });
    expect(a.qCd).toBeCloseTo(q - 1, 5);
    expect(a.eCd).toBeCloseTo(e - 1, 5);
    s.tick('a', { cast: 'e' });
    expect(a.eCd).toBeCloseTo(e - 1 - DT, 5); // still on cooldown: no dash
  });

  it('switchHero is refused while downed, within 1 s of the last switch, or to the same hero', () => {
    const s = new Sim([['a', 'ember']]);
    expect(s.w.switchHero('a', 'ember')).toBe(false);
    expect(s.w.switchHero('a', 'gale')).toBe(true);
    s.run(0.5);
    expect(s.w.switchHero('a', 'tide')).toBe(false);
    s.run(0.55);
    expect(s.w.switchHero('a', 'tide')).toBe(true);
    s.run(1.1);
    s.hero('a').status = 'downed';
    expect(s.w.switchHero('a', 'ember')).toBe(false);
    expect(s.w.switchHero('nobody', 'ember')).toBe(false);
  });

  it('switching ends kit-specific effects (no Stone skin carried to another hero)', () => {
    const s = new Sim([['a', 'bastion']]);
    s.tick('a', { cast: 'e' });
    s.run(1);
    s.w.switchHero('a', 'ember');
    expect(s.hero('a').stoneSkinT).toBe(0);
  });
});
