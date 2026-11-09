import { ELEMENT_COLOR } from '@crossfire/shared/heroes';
import { ENEMY_FX } from '@crossfire/shared/types';

const FADE_IN = 0.25;
const FADE_OUT = 0.5;

/** A zone's opacity from its time left: fades in after the cast and out before it ends. */
export function zoneOpacity(remaining: number, duration: number): number {
  if (!(remaining > 0) || !(duration > 0)) return 0;
  const age = duration - remaining;
  const fin = Math.min(1, Math.max(0, age / FADE_IN));
  const fout = Math.min(1, remaining / FADE_OUT);
  return Math.min(fin, fout);
}

export const STUN_COLOR = 0xffe14a;

/** The one status glow an enemy shows: stunned, then burning, then slowed; null for none. */
export function statusGlow(fx: number): number | null {
  if (fx & ENEMY_FX.stunned) return STUN_COLOR;
  if (fx & ENEMY_FX.burning) return ELEMENT_COLOR.fire;
  if (fx & ENEMY_FX.slowed) return ELEMENT_COLOR.water;
  return null;
}
