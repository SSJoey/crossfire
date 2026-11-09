import { HEROES, HERO_IDS, type HeroId } from '@crossfire/shared/heroes';

/** Model files written by tools/assets.mjs into client/public/models/. */
export const MODEL_FILES = {
  heroes: Object.fromEntries(HERO_IDS.map((id) => [id, `${HEROES[id].model}.glb`])) as Record<HeroId, string>,
  heroAnims: 'hero-anims.glb',
  minion: 'Skeleton_Minion.glb',
  skeletonAnims: 'skeleton-anims.glb',
} as const;

/** Hero clips the client plays (KayKit Adventurers names; every hero model shares them). */
export const HERO_CLIP = {
  idle: 'Idle',
  run: 'Running_A',
  shoot: 'Spellcast_Shoot',
  hit: 'Hit_A',
  lieDown: 'Lie_Down',
  lieIdle: 'Lie_Idle',
  standUp: 'Lie_StandUp',
  death: 'Death_A',
  chop: '1H_Melee_Attack_Chop',
  dualChop: 'Dualwield_Melee_Attack_Chop',
  crossbow: '1H_Ranged_Shoot',
  raise: 'Spellcast_Raise',
  block: 'Block',
  dodge: 'Dodge_Forward',
} as const;

export interface HeroAnims {
  attack: string;
  q: string;
  /** null: the E has no clip (Flame step is instant). */
  e: string | null;
}

/** Per-hero clips for the basic attack, Q and E (NOTES.md 2026-11-09, 1b.2 answer 2). */
export const HERO_ANIM: Readonly<Record<HeroId, HeroAnims>> = {
  ember: { attack: HERO_CLIP.shoot, q: HERO_CLIP.raise, e: null },
  bastion: { attack: HERO_CLIP.chop, q: HERO_CLIP.chop, e: HERO_CLIP.block },
  tide: { attack: HERO_CLIP.crossbow, q: HERO_CLIP.raise, e: HERO_CLIP.raise },
  gale: { attack: HERO_CLIP.dualChop, q: HERO_CLIP.chop, e: HERO_CLIP.dodge },
};

/** Skeleton clips the client plays (KayKit Skeletons names). */
export const SKELETON_CLIP = {
  spawn: 'Spawn_Ground_Skeletons',
  walk: 'Walking_D_Skeletons',
  idle: 'Idle_Combat',
  attack: '1H_Melee_Attack_Chop',
  hit: 'Hit_A',
  death: 'Death_A',
} as const;

export const HERO_CLIPS: readonly string[] = Object.values(HERO_CLIP);
export const SKELETON_CLIPS: readonly string[] = Object.values(SKELETON_CLIP);
