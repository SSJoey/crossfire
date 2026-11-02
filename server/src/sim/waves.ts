import { waveSize } from '@crossfire/shared/rules/scaling';
import type { Tuning } from '@crossfire/shared/tuning';
import type { WaveState } from '@crossfire/shared/types';

/**
 * Endless count-based waves. Wave N spawns waveSize(N, players) minions of level N, one every
 * spawn interval while under the enemy cap. When all are spawned and none are left, a break
 * starts; after it the next wave begins.
 */
export class WaveDirector {
  wave = 1;
  state: WaveState = 'spawning';
  total = 0;
  spawned = 0;
  private spawnTimer = 0;
  private breakTimer = 0;

  constructor(private readonly t: Tuning) {}

  start(players: number): void {
    this.begin(1, players);
  }

  private begin(wave: number, players: number): void {
    this.wave = wave;
    this.state = 'spawning';
    this.total = waveSize(wave, players, this.t.waves);
    this.spawned = 0;
    this.spawnTimer = 0;
  }

  /**
   * Advances the director. `alive` is the number of enemies alive now. Calls `spawn` for each
   * enemy to create (it returns false if the pool is full). Returns 'cleared', 'started' or null.
   */
  step(
    dt: number,
    alive: number,
    players: number,
    spawn: (level: number) => boolean,
  ): 'cleared' | 'started' | null {
    if (this.state === 'break') {
      this.breakTimer -= dt;
      if (this.breakTimer <= 1e-9) {
        this.begin(this.wave + 1, players);
        return 'started';
      }
      return null;
    }
    if (this.spawned < this.total) {
      this.spawnTimer -= dt;
      if (this.spawnTimer <= 1e-9 && alive < this.t.waves.enemyCap) {
        if (spawn(this.wave)) {
          this.spawned++;
          this.spawnTimer = this.t.waves.spawnIntervalSec;
        }
      }
      return null;
    }
    if (alive === 0) {
      this.state = 'break';
      this.breakTimer = this.t.waves.breakSec;
      return 'cleared';
    }
    return null;
  }
}
