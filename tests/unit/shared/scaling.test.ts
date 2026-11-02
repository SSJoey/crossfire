import { describe, expect, it } from 'vitest';
import { enemyStats, playerFactor, waveSize } from '@crossfire/shared/rules/scaling';
import { TUNING } from '@crossfire/shared/tuning';

describe('wave scaling', () => {
  it('player factor at 1, 4 and 8 players', () => {
    expect(playerFactor(1)).toBe(1);
    expect(playerFactor(4)).toBe(2.5);
    expect(playerFactor(8)).toBe(4.5);
  });

  it('clamps player count to 1..8', () => {
    expect(playerFactor(0)).toBe(1);
    expect(playerFactor(-3)).toBe(1);
    expect(playerFactor(20)).toBe(4.5);
  });

  it.each([
    [1, 1, 6],
    [5, 1, 18],
    [10, 1, 33],
    [1, 4, 15],
    [5, 4, 45],
    [10, 4, 83],
    [1, 8, 27],
    [5, 8, 81],
    [10, 8, 149],
  ])('wave %i with %i players spawns %i minions', (wave, players, expected) => {
    expect(waveSize(wave, players)).toBe(expected);
  });

  it('grows monotonically with wave and with players', () => {
    for (let w = 1; w < 50; w++) expect(waveSize(w + 1, 4)).toBeGreaterThan(waveSize(w, 4));
    for (let p = 1; p < 8; p++) expect(waveSize(3, p + 1)).toBeGreaterThan(waveSize(3, p));
  });
});

describe('enemy level', () => {
  const m = TUNING.minion;

  it('level 1 is the base minion', () => {
    const s = enemyStats(1);
    expect(s.maxHp).toBe(m.baseHp);
    expect(s.damage).toBe(m.damage);
    expect(s.speed).toBe(m.speed);
    expect(s.scale).toBe(1);
  });

  it('HP grows 12% of base per level', () => {
    expect(enemyStats(5).maxHp).toBeCloseTo(42 * 1.48);
    expect(enemyStats(10).maxHp).toBeCloseTo(42 * 2.08);
  });

  it('damage, speed and size grow but are capped', () => {
    const s10 = enemyStats(10);
    expect(s10.damage).toBeGreaterThan(m.damage);
    expect(s10.speed).toBeGreaterThan(m.speed);
    expect(s10.scale).toBeGreaterThan(1);
    const s100 = enemyStats(100);
    expect(s100.damage).toBeCloseTo(m.damage * m.levelDamageCap);
    expect(s100.speed).toBeCloseTo(m.speed * m.levelSpeedCap);
    expect(s100.scale).toBeCloseTo(m.levelScaleCap);
  });

  it('treats levels below 1 as 1', () => {
    expect(enemyStats(0)).toEqual(enemyStats(1));
  });
});
