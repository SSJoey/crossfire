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
}

export interface BoltView {
  x: number;
  z: number;
  dirX: number;
  dirZ: number;
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
}
