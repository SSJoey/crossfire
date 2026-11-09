import { TUNING, type Tuning } from './tuning';

/**
 * The four Phase 1 heroes (stage 1b; NOTES.md 2026-11-09). Names, element, attack style and
 * art live here; every number lives in `TUNING.heroes` and is read through `heroKit`.
 */
export const HERO_IDS = ['ember', 'bastion', 'tide', 'gale'] as const;
export type HeroId = (typeof HERO_IDS)[number];
export type Element = 'fire' | 'earth' | 'water' | 'air';
export type AttackStyle = 'ranged' | 'melee';

export interface HeroDef {
  id: HeroId;
  name: string;
  element: Element;
  style: AttackStyle;
  /** KayKit Adventurers model. */
  model: string;
  /** Model parts kept by the asset pipeline (everything else is dropped). */
  props: readonly string[];
  /** Colour multiplied over the whole model (Tide's blue recolour), or null. */
  tint: number | null;
  basicAttack: string;
  zone: string;
  utility: string;
  passive: string;
}

export const HEROES: Readonly<Record<HeroId, HeroDef>> = {
  ember: {
    id: 'ember',
    name: 'Ember',
    element: 'fire',
    style: 'ranged',
    model: 'Mage',
    props: ['2H_Staff'],
    tint: null,
    basicAttack: 'Fire bolt',
    zone: 'Fire zone',
    utility: 'Flame step',
    passive: 'Kindle',
  },
  bastion: {
    id: 'bastion',
    name: 'Bastion',
    element: 'earth',
    style: 'melee',
    model: 'Knight',
    props: ['1H_Sword', 'Round_Shield'],
    tint: null,
    basicAttack: 'Sword chop',
    zone: 'Quake slam',
    utility: 'Stone skin',
    passive: 'Steadfast',
  },
  tide: {
    id: 'tide',
    name: 'Tide',
    element: 'water',
    style: 'ranged',
    model: 'Rogue_Hooded',
    props: ['1H_Crossbow'],
    tint: 0xa9c6ff,
    basicAttack: 'Water bolt',
    zone: 'Tidal pool',
    utility: 'Mending wave',
    passive: 'Undertow',
  },
  gale: {
    id: 'gale',
    name: 'Gale',
    element: 'air',
    style: 'melee',
    model: 'Rogue',
    props: ['Knife', 'Knife_Offhand'],
    tint: null,
    basicAttack: 'Twin daggers',
    zone: 'Cyclone',
    utility: 'Gust dash',
    passive: 'Tailwind',
  },
};

/** True only for one of the four hero ids (own keys only: `__proto__` and friends fail). */
export function isHeroId(x: unknown): x is HeroId {
  return typeof x === 'string' && (HERO_IDS as readonly string[]).includes(x);
}

export type HeroKit<H extends HeroId = HeroId> = Tuning['heroes'][H];

/**
 * A hero's numbers at a level. Every kit number is read through here, so in-run XP (parked,
 * NOTES.md 2026-11-09) can scale them later. Phase 1 has no levels: `level` is always 1.
 */
export function heroKit<H extends HeroId>(id: H, _level = 1, t: Tuning = TUNING): HeroKit<H> {
  return t.heroes[id];
}
