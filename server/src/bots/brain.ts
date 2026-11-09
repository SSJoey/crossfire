import type { Tuning } from '@crossfire/shared/tuning';
import type { HeroStatus } from '@crossfire/shared/types';

/** What a bot sees of a hero (from the synced state). */
export interface BotUnit {
  id: string;
  x: number;
  z: number;
  status: HeroStatus;
}

/** What a bot sees of an enemy. */
export interface BotEnemy {
  x: number;
  z: number;
  state: string;
}

export interface BotView {
  meId: string;
  heroes: BotUnit[];
  enemies: BotEnemy[];
  /** Seconds since the bot started, drives the slow drift around the platform. */
  timeSec: number;
  /** Per-bot number so bots drift to different spots. */
  seed: number;
}

export interface BotControls {
  moveX: number;
  moveZ: number;
  aimX: number;
  aimZ: number;
  attack: boolean;
  revive: boolean;
}

/** Bot behaviour constants. They shape test traffic, not the game, so they live here. */
const BOT = {
  /** Stay within this share of the ring radius. */
  homeShare: 0.7,
  /** Drift circle around the hold point (m) and its angular speed (rad/s). */
  driftRadius: 5.5,
  driftSpeed: 0.25,
  driftPace: 0.6,
  /** Back away from enemies closer than this (m). */
  personalSpace: 2,
  /** Bodies further than this beyond the ring are left alone (m). */
  bodyReach: 4,
  /** Walk until this share of the revive radius, hold F within the larger share. */
  reviveStand: 0.6,
  reviveHold: 0.8,
};

/**
 * A simple teammate: revive the nearest body near the ring, otherwise stay inside the ring,
 * shoot the nearest enemy in range and back off when crowded. Pure: same view, same controls.
 */
export function decide(v: BotView, t: Tuning): BotControls {
  const out: BotControls = { moveX: 0, moveZ: 0, aimX: 0, aimZ: 1, attack: false, revive: false };
  const me = v.heroes.find((h) => h.id === v.meId);
  if (!me) return out;
  out.aimX = me.x;
  out.aimZ = me.z + 1;

  // Nearest enemy that can be hit (rising minions cannot).
  let foe: BotEnemy | null = null;
  let foeD = Infinity;
  for (const e of v.enemies) {
    if (e.state === 'spawning') continue;
    const d = Math.hypot(e.x - me.x, e.z - me.z);
    if (d < foeD) {
      foeD = d;
      foe = e;
    }
  }
  if (foe) {
    out.aimX = foe.x;
    out.aimZ = foe.z;
    out.attack = foeD <= t.heroes.ember.bolt.range;
  }

  // Nearest downed or dead teammate close enough to the ring.
  let body: BotUnit | null = null;
  let bodyD = Infinity;
  for (const h of v.heroes) {
    if (h.id === me.id || h.status === 'standing') continue;
    if (Math.hypot(h.x, h.z) > t.ring.radius + BOT.bodyReach) continue;
    const d = Math.hypot(h.x - me.x, h.z - me.z);
    if (d < bodyD) {
      bodyD = d;
      body = h;
    }
  }

  let mx = 0;
  let mz = 0;
  const r = Math.hypot(me.x, me.z);
  if (body) {
    if (bodyD > t.revive.radius * BOT.reviveStand) {
      mx = (body.x - me.x) / bodyD;
      mz = (body.z - me.z) / bodyD;
    }
    out.revive = bodyD <= t.revive.radius * BOT.reviveHold;
  } else if (r > t.ring.radius * BOT.homeShare) {
    mx = -me.x / r;
    mz = -me.z / r;
  } else {
    const a = v.seed * 1.7 + v.timeSec * BOT.driftSpeed;
    const dx = Math.cos(a) * BOT.driftRadius - me.x;
    const dz = Math.sin(a) * BOT.driftRadius - me.z;
    const d = Math.hypot(dx, dz);
    if (d > 1e-6) {
      const pace = Math.min(1, d / 2) * BOT.driftPace;
      mx = (dx / d) * pace;
      mz = (dz / d) * pace;
    }
    if (foe && foeD < BOT.personalSpace) {
      if (foeD > 1e-6) {
        mx += (me.x - foe.x) / foeD;
        mz += (me.z - foe.z) / foeD;
      } else {
        mx += 1;
      }
    }
  }

  const len = Math.hypot(mx, mz);
  if (len > 1) {
    mx /= len;
    mz /= len;
  }
  out.moveX = mx;
  out.moveZ = mz;
  return out;
}
