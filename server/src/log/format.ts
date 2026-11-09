import { ROOM_CODE_LETTERS, type PerfReport } from '@crossfire/shared/types';

/**
 * Match log events. One JSON object per line, `t` (ms since the run started) and `ev` first.
 * Names only: never an IP address or a session id.
 */
export type EndReason = 'wiped' | 'aborted' | 'empty';
/** `protocol`: Colyseus cut the client off (over the frame cap or a protocol error). */
export type LeaveReason = 'left' | 'kicked' | 'flooded' | 'protocol';

export type LogEvent =
  | {
      ev: 'start';
      at: string;
      code: string;
      seed: number;
      players: string[];
      bots: string[];
      /** Hero per player name (stage 1b). */
      heroes: Record<string, string>;
    }
  | { ev: 'waveStarted'; wave: number }
  | { ev: 'waveCleared'; wave: number }
  | { ev: 'downed'; name: string }
  | { ev: 'died'; name: string }
  | { ev: 'revived'; name: string }
  | { ev: 'left'; name: string; reason: LeaveReason }
  /** Stage 1b.3: a player (by name) or the host page paused the run. */
  | { ev: 'paused'; name: string }
  | { ev: 'paused'; host: true }
  /** The host resumed; how long this pause lasted. */
  | { ev: 'resumed'; pausedSec: number }
  | {
      ev: 'perf';
      tickP95Ms: number;
      tickMaxMs: number;
      /** State encoding + send (Colyseus broadcastPatch), timed separately from the tick. */
      patchP95Ms: number;
      ticks: number;
      heapMB: number;
      rssMB: number;
      enemies: number;
      bolts: number;
      players: number;
      kBpsAvg: number;
      kBpsMax: number;
      kBps: Record<string, number>;
      /** Each player's latest client report (tier, fps, 1% low, canvas), by name. Bots send none. */
      clients: Record<string, PerfReport>;
    }
  | {
      ev: 'end';
      reason: EndReason;
      wave: number;
      /** Run time, paused time excluded. */
      durationSec: number;
      /** Total paused time, an open pause included (stage 1b.3). */
      pausedSec: number;
      kills: number;
      tickP95Ms: number;
      tickMaxMs: number;
      patchP95Ms: number;
    };

/** One log line, newline included. JSON escaping keeps any name on a single line. */
export function logLine(t: number, event: LogEvent): string {
  return JSON.stringify({ t: Math.round(t), ...event }) + '\n';
}

const CODE_RE = new RegExp(`^[${ROOM_CODE_LETTERS}]{4}$`);

/** `2026-11-02T20-15-03.123Z_ABCD.jsonl`: sortable, no colons (safe on every filesystem). */
export function logFileName(start: Date, code: string): string {
  if (!CODE_RE.test(code)) throw new Error(`Invalid room code for a log file: ${JSON.stringify(code)}`);
  return `${start.toISOString().replace(/:/g, '-')}_${code}.jsonl`;
}

/** Rounds to 1 decimal (paused seconds). */
export function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/** Rounds to 2 decimals for compact perf lines. */
export function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
