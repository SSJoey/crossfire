import type { ReviveHero } from '@crossfire/shared/rules/revive';
import type { Tuning } from '@crossfire/shared/tuning';
import type { HeroStatus, InputMessage } from '@crossfire/shared/types';

export interface SimHero extends ReviveHero {
  name: string;
  facing: number;
  speed: number;
  radius: number;
  attackCd: number;
  /** The controls currently applied (zeroed when input goes stale). */
  input: InputMessage;
  lastInputMs: number;
  /** Status at the end of the previous tick, to emit events on change. */
  prevStatus: HeroStatus;
  /** Position index around the hold point. */
  slot: number;
}

export function emptyInput(seq = -1): InputMessage {
  return { seq, moveX: 0, moveZ: 0, aimX: 0, aimZ: 0, attack: false, revive: false };
}

export function createHero(id: string, name: string, slot: number, t: Tuning): SimHero {
  const h: SimHero = {
    id,
    name,
    slot,
    x: 0,
    z: 0,
    facing: 0,
    status: 'standing',
    prevStatus: 'standing',
    hp: t.ember.maxHp,
    maxHp: t.ember.maxHp,
    speed: t.ember.speed,
    radius: t.ember.radius,
    bleedOut: 0,
    reviveProgress: 0,
    holdingRevive: false,
    attackCd: 0,
    input: emptyInput(),
    lastInputMs: 0,
  };
  return h;
}

/** Puts a hero back to full health at its place around the hold point. */
export function resetHero(h: SimHero, slotCount: number, nowMs: number, t: Tuning): void {
  const a = (h.slot / Math.max(1, slotCount)) * Math.PI * 2 + Math.PI / 4;
  h.x = Math.cos(a) * t.ring.heroStartRadius;
  h.z = Math.sin(a) * t.ring.heroStartRadius;
  h.facing = Math.atan2(h.x, h.z);
  h.status = 'standing';
  h.prevStatus = 'standing';
  h.maxHp = t.ember.maxHp;
  h.hp = h.maxHp;
  h.speed = t.ember.speed;
  h.radius = t.ember.radius;
  h.bleedOut = 0;
  h.reviveProgress = 0;
  h.holdingRevive = false;
  h.attackCd = 0;
  const seq = h.input.seq;
  h.input = emptyInput(seq);
  h.input.aimX = h.x * 2;
  h.input.aimZ = h.z * 2;
  h.lastInputMs = nowMs;
}
