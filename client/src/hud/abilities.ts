import { HEROES, type HeroId } from '@crossfire/shared/heroes';

/** Share of a cooldown still to run, 0..1 (0 = ready). */
export function cdFrac(cd: number, max: number): number {
  if (!(max > 0) || !(cd > 0)) return 0;
  return Math.min(1, cd / max);
}

export interface HeroText {
  name: string;
  /** "Fire, ranged" */
  sub: string;
  basic: string;
  q: string;
  e: string;
  passive: string;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The HUD and lobby labels of a hero, straight from shared/heroes.ts. */
export function heroText(id: HeroId): HeroText {
  const d = HEROES[id];
  return {
    name: d.name,
    sub: `${cap(d.element)}, ${d.style}`,
    basic: d.basicAttack,
    q: d.zone,
    e: d.utility,
    passive: d.passive,
  };
}
