/** Types and protocol constants shared by client and server. */

export const ROOM_NAME = 'hold';
/** Test-only load room, registered only with CROSSFIRE_LOAD_ROOM=1. */
export const LOAD_ROOM_NAME = 'hold_load';

/** Letters used in room codes (4 letters, no I or O to avoid confusion with 1 and 0). */
export const ROOM_CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

export type HeroStatus = 'standing' | 'downed' | 'dead';
export type Phase = 'lobby' | 'running' | 'ended';
export type WaveState = 'spawning' | 'break';

/** The only gameplay message a client sends: its current controls. */
export interface InputMessage {
  /** Increases with every input; older or repeated numbers are ignored. */
  seq: number;
  /** Move vector on the XZ plane, length at most 1. */
  moveX: number;
  moveZ: number;
  /** Aim point on the ground (world coordinates). */
  aimX: number;
  aimZ: number;
  /** Basic attack held. */
  attack: boolean;
  /** F held (revive). */
  revive: boolean;
}

/** Graphics tiers a client can run at. */
export const GFX_TIERS = ['high', 'medium', 'low'] as const;
export type GfxTier = (typeof GFX_TIERS)[number];

/** A player's client performance over the last report interval (logged in the match log). */
export interface PerfReport {
  tier: GfxTier;
  /** Average frames per second over the interval. */
  fps: number;
  /** fps over the slowest 1% of the interval's frames. */
  low1: number;
  /** Canvas drawing-buffer size in device pixels. */
  w: number;
  h: number;
  /** Device pixel ratio the renderer uses. */
  dpr: number;
}

/** Client → server message types. */
export const MSG = {
  input: 'input',
  ready: 'ready',
  start: 'start',
  restart: 'restart',
  kick: 'kick',
  /** Host only: add one bot player (lobby only). */
  addBot: 'addBot',
  /** Host only: remove every bot player (lobby only). */
  removeBots: 'removeBots',
  /** Player only, during a run: a PerfReport. */
  perf: 'perf',
} as const;

/** Server → client message types. */
export const SERVER_MSG = {
  ended: 'ended',
} as const;

export interface RunEndedMessage {
  wave: number;
  durationSec: number;
}

/** Messages shown to a player whose join is refused. */
export const JOIN_ERRORS = {
  full: 'The game is full: 8 players are already in.',
  inProgress: "Run in progress, you'll get in when it ends.",
  emptyName: 'Please enter a name.',
  notHost: 'The host page only works on the host laptop.',
} as const;

/** WebSocket close codes the server uses (Colyseus reserves 4000–4010). */
export const CLOSE = {
  flood: 4020,
  kicked: 4021,
} as const;
