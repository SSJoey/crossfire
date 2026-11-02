import { stepRevive, type ReviveHero } from '@crossfire/shared/rules/revive';
import { TUNING } from '@crossfire/shared/tuning';

export const DT = 1 / TUNING.tickHz;

export function hero(id: string, x = 0, z = 0, patch: Partial<ReviveHero> = {}): ReviveHero {
  return {
    id,
    x,
    z,
    status: 'standing',
    hp: 400,
    maxHp: 400,
    bleedOut: 0,
    reviveProgress: 0,
    holdingRevive: false,
    ...patch,
  };
}

export function runRevive(heroes: ReviveHero[], seconds: number): void {
  const ticks = Math.round(seconds / DT);
  for (let i = 0; i < ticks; i++) stepRevive(heroes, DT);
}
