import type { Phase } from '../types';

/** A pause request, as the server sees it (stage 1b.3). */
export interface PauseAsk {
  phase: Phase;
  paused: boolean;
  /** The host page, or a player. */
  role: 'host' | 'player';
  /** The player has a hero in this run (ignored for the host). */
  inRun: boolean;
  nowMs: number;
  /** The player's own cooldown ends here (ms); 0 when none. The host has none. */
  blockedUntilMs: number;
}

/**
 * Any player in the run may pause a running run, whatever their status, once their own cooldown
 * (counted from the resume of their last pause) is over. The host page may pause any time.
 */
export function canPause(a: PauseAsk): boolean {
  if (a.phase !== 'running' || a.paused) return false;
  if (a.role === 'host') return true;
  return a.inRun && a.nowMs >= a.blockedUntilMs;
}

/** Only the host page resumes, and only a paused run. */
export function canResume(a: { phase: Phase; paused: boolean; role: 'host' | 'player' }): boolean {
  return a.phase === 'running' && a.paused && a.role === 'host';
}

/** Whole seconds left on a pause cooldown, rounded up (0 when none). */
export function pauseCooldownLeft(nowMs: number, blockedUntilMs: number): number {
  return Math.max(0, Math.ceil((blockedUntilMs - nowMs) / 1000));
}
