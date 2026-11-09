import { describe, expect, it } from 'vitest';
import { HERO_IDS, HEROES, heroKit, isHeroId } from '@crossfire/shared/heroes';
import {
  blinkTarget,
  canCast,
  clampCast,
  damageTaken,
  dashStep,
  healed,
  meleeHits,
  strongestSlow,
  tailwindHit,
} from '@crossfire/shared/rules/abilities';
import { TUNING } from '@crossfire/shared/tuning';

const H = TUNING.heroes;
const Z = TUNING.zones;

describe('hero kits match the 1b definition (NOTES.md 2026-11-09)', () => {
  it('has exactly the four heroes with their element, style and model', () => {
    expect([...HERO_IDS]).toEqual(['ember', 'bastion', 'tide', 'gale']);
    expect(HEROES.ember).toMatchObject({ element: 'fire', style: 'ranged', model: 'Mage' });
    expect(HEROES.bastion).toMatchObject({ element: 'earth', style: 'melee', model: 'Knight' });
    expect(HEROES.tide).toMatchObject({ element: 'water', style: 'ranged', model: 'Rogue_Hooded' });
    expect(HEROES.gale).toMatchObject({ element: 'air', style: 'melee', model: 'Rogue' });
  });

  it('names every slot', () => {
    expect(HEROES.ember).toMatchObject({
      basicAttack: 'Fire bolt',
      zone: 'Fire zone',
      utility: 'Flame step',
      passive: 'Kindle',
    });
    expect(HEROES.bastion).toMatchObject({
      basicAttack: 'Sword chop',
      zone: 'Quake slam',
      utility: 'Stone skin',
      passive: 'Steadfast',
    });
    expect(HEROES.tide).toMatchObject({
      basicAttack: 'Water bolt',
      zone: 'Tidal pool',
      utility: 'Mending wave',
      passive: 'Undertow',
    });
    expect(HEROES.gale).toMatchObject({
      basicAttack: 'Twin daggers',
      zone: 'Cyclone',
      utility: 'Gust dash',
      passive: 'Tailwind',
    });
  });

  it('keeps the agreed props per model', () => {
    expect(HEROES.ember.props).toEqual(['2H_Staff']);
    expect(HEROES.bastion.props).toEqual(['1H_Sword', 'Round_Shield']);
    expect(HEROES.tide.props).toEqual(['1H_Crossbow']);
    expect(HEROES.gale.props).toEqual(['Knife', 'Knife_Offhand']);
  });

  it('base stats and basic attacks are the look-test values', () => {
    for (const id of HERO_IDS) {
      expect(H[id].maxHp).toBe(400);
      expect(H[id].radius).toBe(0.5);
    }
    expect([H.ember.speed, H.bastion.speed, H.tide.speed, H.gale.speed]).toEqual([5.4, 4.8, 5.2, 6.4]);
    expect(H.ember.bolt).toMatchObject({ damage: 20, intervalSec: 0.55, range: 12, speed: 22 });
    expect(H.tide.bolt).toMatchObject({ damage: 16, intervalSec: 0.6, range: 12, speed: 22 });
    expect(H.bastion.melee).toMatchObject({ damage: 34, intervalSec: 0.8, reach: 2.4 });
    expect(H.gale.melee).toMatchObject({ damage: 22, intervalSec: 0.45, reach: 2.2 });
  });

  it('zones: shared size, duration, range and cooldown; distinct effects', () => {
    expect(Z).toMatchObject({ radius: 3, durationSec: 4.2, castRange: 11, cooldownSec: 5 });
    expect(Z.fire).toMatchObject({ dps: 14 });
    expect(Z.earth).toMatchObject({ dps: 6, impactDamage: 30, stunSec: 1 });
    expect(Z.water).toMatchObject({ dps: 6, slowFrac: 0.5 });
    expect(Z.air).toMatchObject({ dps: 6, pullSpeed: 2 });
  });

  it('E utilities and passives', () => {
    expect(H.ember.utility).toMatchObject({ cooldownSec: 8, range: 6 });
    expect(H.ember.passive).toMatchObject({ burnDps: 4, burnSec: 2 });
    expect(H.bastion.utility).toMatchObject({
      cooldownSec: 14,
      durationSec: 4,
      damageTakenMul: 0.4,
      tauntRadius: 6,
      tauntSec: 4,
    });
    expect(H.bastion.passive).toMatchObject({ damageTakenMul: 0.85 });
    expect(H.tide.utility).toMatchObject({ cooldownSec: 16, radius: 6, healFrac: 0.3 });
    expect(H.tide.passive).toMatchObject({ slowFrac: 0.3, slowSec: 1.5 });
    expect(H.gale.utility).toMatchObject({ cooldownSec: 7, distance: 7, durationSec: 0.25, knockback: 3 });
    expect(H.gale.passive).toMatchObject({ every: 4, mult: 2 });
  });

  it('heroKit reads the numbers through a level (always 1 for now)', () => {
    expect(heroKit('gale')).toBe(H.gale);
    expect(heroKit('gale', 1)).toBe(H.gale);
  });

  it('isHeroId accepts only own hero ids', () => {
    for (const id of HERO_IDS) expect(isHeroId(id)).toBe(true);
    for (const bad of [
      '__proto__',
      'constructor',
      'toString',
      'Ember',
      '',
      'brand',
      1,
      null,
      undefined,
      ['ember'],
      {},
    ])
      expect(isHeroId(bad)).toBe(false);
  });
});

describe('canCast', () => {
  it('needs a standing hero and a finished cooldown', () => {
    expect(canCast('standing', 0)).toBe(true);
    expect(canCast('standing', 0.001)).toBe(false);
    expect(canCast('downed', 0)).toBe(false);
    expect(canCast('dead', 0)).toBe(false);
  });
});

describe('clampCast', () => {
  const out = { x: 0, z: 0 };
  it('a cast beyond range is clamped along the aim direction', () => {
    clampCast(1, 1, 1, 31, 11, out);
    expect(out.x).toBeCloseTo(1);
    expect(out.z).toBeCloseTo(12);
    clampCast(0, 0, 30, 40, 11, out);
    expect(Math.hypot(out.x, out.z)).toBeCloseTo(11);
    expect(out.x / out.z).toBeCloseTo(30 / 40);
  });
  it('exactly at range or closer is unchanged', () => {
    clampCast(0, 0, 0, 11, 11, out);
    expect(out).toEqual({ x: 0, z: 11 });
    clampCast(2, 2, 4, 5, 11, out);
    expect(out).toEqual({ x: 4, z: 5 });
  });
  it('aiming at the hero itself casts on the hero', () => {
    clampCast(3, 4, 3, 4, 11, out);
    expect(out).toEqual({ x: 3, z: 4 });
  });
});

describe('Flame step (blinkTarget)', () => {
  const out = { x: 0, z: 0 };
  it('blinks to the aim point, at most 6 m', () => {
    blinkTarget(5, 0, 8, 0, 6, out);
    expect(out.x).toBeCloseTo(8);
    blinkTarget(5, 0, 20, 0, 6, out);
    expect(out.x).toBeCloseTo(11);
    expect(out.z).toBeCloseTo(0);
  });
  it('stays inside the map and off the hold platform', () => {
    blinkTarget(38, 0, 60, 0, 6, out);
    expect(Math.hypot(out.x, out.z)).toBeCloseTo(TUNING.ring.mapRadius);
    blinkTarget(4, 0, -4, 0, 6, out);
    expect(Math.hypot(out.x, out.z)).toBeGreaterThanOrEqual(TUNING.ring.holdRadius - 1e-9);
  });
});

describe('Gust dash (dashStep)', () => {
  it('covers 7 m over 0.25 s, then stops', () => {
    const p = { x: 5, z: 0 };
    const u = H.gale.utility;
    const speed = u.distance / u.durationSec;
    const dt = 1 / TUNING.tickHz;
    for (let i = 0; i < Math.round(u.durationSec / dt); i++) dashStep(p, 0, 1, speed, dt);
    expect(p.x).toBeCloseTo(5);
    expect(p.z).toBeCloseTo(7);
  });
  it('is held inside the map', () => {
    const p = { x: 39, z: 0 };
    dashStep(p, 1, 0, 28, 0.05);
    expect(Math.hypot(p.x, p.z)).toBeLessThanOrEqual(TUNING.ring.mapRadius + 1e-9);
  });
});

describe('damageTaken (Steadfast, Stone skin)', () => {
  it('other heroes take full damage', () => {
    expect(damageTaken(10, 'ember', false)).toBe(10);
    expect(damageTaken(10, 'gale', true)).toBe(10);
  });
  it('Bastion takes 15% less always, ×0.34 with Stone skin', () => {
    expect(damageTaken(10, 'bastion', false)).toBeCloseTo(8.5);
    expect(damageTaken(10, 'bastion', true)).toBeCloseTo(3.4);
  });
});

describe('Mending wave (healed)', () => {
  it('heals 30% of max HP, never above max', () => {
    expect(healed(100, 400, 0.3)).toBe(220);
    expect(healed(350, 400, 0.3)).toBe(400);
    expect(healed(400, 400, 0.3)).toBe(400);
  });
});

describe('strongestSlow', () => {
  it('takes the strongest active slow, ignoring expired ones', () => {
    expect(strongestSlow(0.5, 0.2, 0.3, 1.5)).toBe(0.5);
    expect(strongestSlow(0.5, 0, 0.3, 1.5)).toBe(0.3);
    expect(strongestSlow(0, 0, 0, 0)).toBe(0);
    expect(strongestSlow(0.5, 1, 0.3, 0)).toBe(0.5);
  });
});

describe('Tailwind (tailwindHit)', () => {
  it('every 4th hitting swing doubles, then the count restarts', () => {
    const r = { count: 0, mult: 1 };
    const mults: number[] = [];
    for (let i = 0; i < 9; i++) {
      tailwindHit(r.count, 4, 2, r);
      mults.push(r.mult);
    }
    expect(mults).toEqual([1, 1, 1, 2, 1, 1, 1, 2, 1]);
  });
});

describe('meleeHits', () => {
  const out = new Int32Array(16);
  const foe = (x: number, z: number, targetable = true, hp = 10) => ({ x, z, targetable, hp });

  it('hits every risen enemy in reach inside the front arc', () => {
    const enemies = [
      foe(0, 2), // ahead, in reach
      foe(1.5, 1.5), // 45°, in reach
      foe(0, -1), // behind
      foe(0, 3.5), // beyond reach + 0.4 (2.8)
      foe(0, 2.7), // within reach + extra
      foe(0, 1, false), // still rising
      foe(0.2, 1, true, 0), // already dead
    ];
    const n = meleeHits(0, 0, 0, 1, 2.4, enemies, enemies.length, out);
    expect([...out.slice(0, n)].sort()).toEqual([0, 1, 4]);
  });

  it('the arc edge is cos ≥ 0.35', () => {
    const a = Math.acos(0.35);
    const inside = foe(Math.sin(a - 0.02) * 2, Math.cos(a - 0.02) * 2);
    const outside = foe(Math.sin(a + 0.02) * 2, Math.cos(a + 0.02) * 2);
    expect(meleeHits(0, 0, 0, 1, 2.4, [inside, outside], 2, out)).toBe(1);
    expect(out[0]).toBe(0);
  });

  it('an enemy on top of the hero is hit', () => {
    expect(meleeHits(0, 0, 0, 1, 2.4, [foe(0, 0)], 1, out)).toBe(1);
  });
});
