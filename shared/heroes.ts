import { TUNING } from './tuning';

/** Stage 1a has one hero for everyone: Ember. The full roster arrives in stage 1b. */
export const HEROES = {
  ember: {
    id: 'ember',
    name: 'Ember',
    element: 'fire',
    style: 'ranged',
    model: 'Mage',
    basicAttack: 'Fire bolt',
    stats: TUNING.ember,
  },
} as const;

export type HeroId = keyof typeof HEROES;
