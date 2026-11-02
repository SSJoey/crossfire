import { TUNING } from '../tuning';

/** Wave-size multiplier for the number of players (clamped to 1..maxPlayers). */
export function playerFactor(players: number, waves = TUNING.waves): number {
  const p = Math.min(waves.maxPlayers, Math.max(1, Math.floor(players) || 1));
  return 1 + waves.perExtraPlayer * (p - 1);
}

/** Number of minions in wave `wave` (1-based) for `players` players. */
export function waveSize(wave: number, players: number, waves = TUNING.waves): number {
  const w = Math.max(1, Math.floor(wave) || 1);
  return Math.ceil((waves.base + waves.growth * (w - 1)) * playerFactor(players, waves));
}

export interface EnemyStats {
  maxHp: number;
  damage: number;
  speed: number;
  scale: number;
}

/** Minion stats at a level. Level = wave number in stage 1a. HP grows without cap; the rest is capped. */
export function enemyStats(level: number, m = TUNING.minion): EnemyStats {
  const steps = Math.max(1, Math.floor(level) || 1) - 1;
  return {
    maxHp: m.baseHp * (1 + m.levelHpStep * steps),
    damage: m.damage * Math.min(1 + m.levelDamageStep * steps, m.levelDamageCap),
    speed: m.speed * Math.min(1 + m.levelSpeedStep * steps, m.levelSpeedCap),
    scale: Math.min(1 + m.levelScaleStep * steps, m.levelScaleCap),
  };
}
