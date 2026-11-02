/** Model files written by tools/assets.mjs into client/public/models/. */
export const MODEL_FILES = {
  hero: 'Mage.glb',
  heroAnims: 'hero-anims.glb',
  minion: 'Skeleton_Minion.glb',
  skeletonAnims: 'skeleton-anims.glb',
} as const;

/** Hero clips the client plays (KayKit Adventurers names). */
export const HERO_CLIP = {
  idle: 'Idle',
  run: 'Running_A',
  shoot: 'Spellcast_Shoot',
  hit: 'Hit_A',
  lieDown: 'Lie_Down',
  lieIdle: 'Lie_Idle',
  standUp: 'Lie_StandUp',
  death: 'Death_A',
} as const;

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
