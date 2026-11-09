import type { Element, HeroId } from '@crossfire/shared/heroes';
import type { HeroStatus, Phase, WaveState } from '@crossfire/shared/types';

/**
 * The synced room state as the client sees it (decoded by the SDK, see
 * server/src/rooms/state.ts). Structural types only: the client does not import server code.
 */
export interface SyncMap<T> {
  get(key: string): T | undefined;
  forEach(cb: (value: T, key: string) => void): void;
  readonly size: number;
}

export interface PlayerView {
  name: string;
  ready: boolean;
  /** Added from the host page. */
  bot: boolean;
  /** Picked hero (stage 1b). */
  hero: HeroId;
}

export interface HeroView {
  name: string;
  x: number;
  z: number;
  facing: number;
  hp: number;
  maxHp: number;
  status: HeroStatus;
  bleedOut: number;
  reviveProgress: number;
  lastSeq: number;
  hero: HeroId;
  /** Q and E cooldowns left (s). */
  qCd: number;
  eCd: number;
  stoneSkin: boolean;
  dashing: boolean;
  /** What the hero last did ('attack', 'q', 'e' or ''), with a counter that changes each time. */
  act: string;
  actSeq: number;
}

export type EnemyStateName = 'spawning' | 'moving' | 'winding';

export interface EnemyView {
  x: number;
  z: number;
  facing: number;
  hp: number;
  maxHp: number;
  level: number;
  scale: number;
  state: EnemyStateName;
  /** ENEMY_FX bits. */
  fx: number;
}

export interface BoltView {
  x: number;
  z: number;
  dirX: number;
  dirZ: number;
  /** `elementIndex` of the firing hero's element. */
  element: number;
}

export interface ZoneView {
  x: number;
  z: number;
  element: Element;
  /** Seconds left. */
  remaining: number;
}

export interface RoomState {
  phase: Phase;
  playerCount: number;
  wave: number;
  waveState: WaveState;
  players: SyncMap<PlayerView>;
  heroes: SyncMap<HeroView>;
  enemies: SyncMap<EnemyView>;
  bolts: SyncMap<BoltView>;
  zones: SyncMap<ZoneView>;
}
