import { describe, expect, it } from 'vitest';
import { canPause, canResume, pauseCooldownLeft, type PauseAsk } from '@crossfire/shared/rules/pause';
import { TUNING } from '@crossfire/shared/tuning';

const base: PauseAsk = {
  phase: 'running',
  paused: false,
  role: 'player',
  inRun: true,
  nowMs: 100_000,
  blockedUntilMs: 0,
};

describe('pause rule (1b.3)', () => {
  it('a player in a running, unpaused run may pause', () => {
    expect(canPause(base)).toBe(true);
  });

  it('refused in the lobby, after the run ended, and while already paused', () => {
    expect(canPause({ ...base, phase: 'lobby' })).toBe(false);
    expect(canPause({ ...base, phase: 'ended' })).toBe(false);
    expect(canPause({ ...base, paused: true })).toBe(false);
    expect(canPause({ ...base, role: 'host', paused: true })).toBe(false);
  });

  it('a player who is not in the run may not pause', () => {
    expect(canPause({ ...base, inRun: false })).toBe(false);
  });

  it('own cooldown: refused before blockedUntil, allowed exactly at it', () => {
    expect(canPause({ ...base, blockedUntilMs: base.nowMs + 1 })).toBe(false);
    expect(canPause({ ...base, blockedUntilMs: base.nowMs })).toBe(true);
    expect(canPause({ ...base, blockedUntilMs: base.nowMs - 1 })).toBe(true);
  });

  it('the host page has no cooldown and needs no hero', () => {
    expect(canPause({ ...base, role: 'host', inRun: false, blockedUntilMs: base.nowMs + 5000 })).toBe(true);
    expect(canPause({ ...base, role: 'host', phase: 'lobby' })).toBe(false);
  });

  it('only the host resumes, and only a paused run', () => {
    expect(canResume({ phase: 'running', paused: true, role: 'host' })).toBe(true);
    expect(canResume({ phase: 'running', paused: true, role: 'player' })).toBe(false);
    expect(canResume({ phase: 'running', paused: false, role: 'host' })).toBe(false);
    expect(canResume({ phase: 'lobby', paused: true, role: 'host' })).toBe(false);
  });

  it('cooldown left is whole seconds, rounded up, never negative', () => {
    expect(pauseCooldownLeft(1000, 0)).toBe(0);
    expect(pauseCooldownLeft(1000, 1000)).toBe(0);
    expect(pauseCooldownLeft(1000, 1001)).toBe(1);
    expect(pauseCooldownLeft(1000, 10_999)).toBe(10);
    expect(pauseCooldownLeft(1000, 11_000)).toBe(10);
  });

  it('the starting cooldown is 10 s', () => {
    expect(TUNING.pause.cooldownSec).toBe(10);
  });
});
