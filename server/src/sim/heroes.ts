import { heroKit, type HeroId } from '@crossfire/shared/heroes';
import type { ReviveHero } from '@crossfire/shared/rules/revive';
import type { Tuning } from '@crossfire/shared/tuning';
import type { CastId, HeroStatus, InputMessage } from '@crossfire/shared/types';

/** What the hero last did, for the client's animations (synced with a counter). */
export type HeroAct = '' | 'attack' | 'q' | 'e';

export interface SimHero extends ReviveHero {
  name: string;
  heroId: HeroId;
  facing: number;
  speed: number;
  radius: number;
  attackCd: number;
  /** Q zone and E utility cooldowns (s). */
  qCd: number;
  eCd: number;
  /** A cast from the latest input, applied (or dropped) on the next tick. */
  pendingCast: CastId;
  /** Bastion: Stone skin time left (s). */
  stoneSkinT: number;
  /** Gale: Gust dash time left (s), its unit direction and an id per dash (for its knockback). */
  dashT: number;
  dashDirX: number;
  dashDirZ: number;
  dashId: number;
  /** Gale: swings that hit since the last Tailwind. */
  tailwindCount: number;
  /** Debug hero switch cooldown (s). */
  switchCd: number;
  act: HeroAct;
  /** Counts up (wrapping at 256) every time `act` happens. */
  actSeq: number;
  /** The controls currently applied (zeroed when input goes stale). */
  input: InputMessage;
  lastInputMs: number;
  /** Status at the end of the previous tick, to emit events on change. */
  prevStatus: HeroStatus;
  /** Position index around the hold point. */
  slot: number;
}

export function emptyInput(seq = -1): InputMessage {
  return {
    seq,
    moveX: 0,
    moveZ: 0,
    aimX: 0,
    aimZ: 0,
    attack: false,
    revive: false,
    cast: 'none',
    qHeld: false,
  };
}

/** Takes on a hero's base stats (HP is set by the caller). */
export function applyKit(h: SimHero, heroId: HeroId, t: Tuning): void {
  const k = heroKit(heroId, 1, t);
  h.heroId = heroId;
  h.maxHp = k.maxHp;
  h.speed = k.speed;
  h.radius = k.radius;
}

/** Ends every effect that belongs to one kit (on run start and on a hero switch). */
export function clearKitEffects(h: SimHero): void {
  h.stoneSkinT = 0;
  h.dashT = 0;
  h.tailwindCount = 0;
  h.pendingCast = 'none';
}

export function createHero(id: string, name: string, slot: number, heroId: HeroId, t: Tuning): SimHero {
  const h: SimHero = {
    id,
    name,
    heroId,
    slot,
    x: 0,
    z: 0,
    facing: 0,
    status: 'standing',
    prevStatus: 'standing',
    hp: 0,
    maxHp: 0,
    speed: 0,
    radius: 0,
    bleedOut: 0,
    reviveProgress: 0,
    holdingRevive: false,
    attackCd: 0,
    qCd: 0,
    eCd: 0,
    pendingCast: 'none',
    stoneSkinT: 0,
    dashT: 0,
    dashDirX: 0,
    dashDirZ: 1,
    dashId: 0,
    tailwindCount: 0,
    switchCd: 0,
    act: '',
    actSeq: 0,
    input: emptyInput(),
    lastInputMs: 0,
  };
  applyKit(h, heroId, t);
  h.hp = h.maxHp;
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
  applyKit(h, h.heroId, t);
  h.hp = h.maxHp;
  h.bleedOut = 0;
  h.reviveProgress = 0;
  h.holdingRevive = false;
  h.attackCd = 0;
  h.qCd = 0;
  h.eCd = 0;
  h.switchCd = 0;
  h.act = '';
  clearKitEffects(h);
  const seq = h.input.seq;
  h.input = emptyInput(seq);
  h.input.aimX = h.x * 2;
  h.input.aimZ = h.z * 2;
  h.lastInputMs = nowMs;
}
