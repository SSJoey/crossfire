/**
 * Every tunable number in the game. These are starting values for playtesting
 * (look-test values unless NOTES.md says otherwise). Change numbers only here.
 */
export const TUNING = {
  /** Server simulation rate. */
  tickHz: 20,
  /** Max simulation steps the server runs to catch up after a stall. */
  maxCatchUpSteps: 5,

  ring: {
    /** Soft-edge radius of the hold area (metres). */
    radius: 14,
    /** HP lost per second outside the ring. */
    drainPerSec: 26,
    /** HP regained per second inside the ring. */
    regenPerSec: 7,
    /** Heroes cannot move further than this from the centre. */
    mapRadius: 40,
    /** Radius of the hold-point platform that heroes and enemies cannot enter. */
    holdRadius: 2.6,
    /** Radius at which heroes are placed around the hold point at run start. */
    heroStartRadius: 3.6,
  },

  ember: {
    maxHp: 400,
    speed: 5.4,
    /** Collision circle radius. */
    radius: 0.5,
    bolt: {
      damage: 20,
      intervalSec: 0.55,
      range: 12,
      /** Not in the look test: starting value. */
      speed: 22,
      /** Extra hit radius of the bolt point against an enemy circle. */
      hitRadius: 0.15,
    },
  },

  minion: {
    baseHp: 42,
    /** HP added per level above 1, as a fraction of base HP (look test: +12% per wave). */
    levelHpStep: 0.12,
    damage: 6,
    levelDamageStep: 0.05,
    levelDamageCap: 2,
    speed: 1.75,
    levelSpeedStep: 0.02,
    levelSpeedCap: 1.4,
    levelScaleStep: 0.015,
    levelScaleCap: 1.3,
    radius: 0.45,
    /** Starts a swing when the target is this close (centre to centre). */
    attackReach: 1.35,
    /** The swing lands only if the target is still this close. */
    hitReach: 2.1,
    swingIntervalSec: 1.6,
    swingWindupSec: 0.42,
    /** Time a newly spawned minion spends rising from the ground (untargetable, harmless). */
    spawnSec: 0.6,
  },

  waves: {
    base: 6,
    growth: 3,
    /** Extra share of a wave per player beyond the first. */
    perExtraPlayer: 0.5,
    maxPlayers: 8,
    breakSec: 5,
    enemyCap: 120,
    spawnIntervalSec: 0.3,
    spawnRadiusMin: 21,
    spawnRadiusMax: 26,
  },

  revive: {
    bleedOutSec: 20,
    downedReviveSec: 3,
    deadReviveSec: 5,
    radius: 2,
    downedReviveHpFrac: 0.5,
    deadReviveHpFrac: 0.5,
  },

  aim: {
    assistOn: true,
    /** Half-angle of the aim-assist cone (radians). */
    assistCone: 0.45,
  },

  net: {
    ratePerSec: 60,
    burst: 120,
    floodKickMs: 3000,
    /** A flood streak ends after this long without a dropped message. */
    floodQuietMs: 1000,
    staleInputMs: 250,
    maxAbsNumber: 1e4,
  },

  lobby: {
    maxPlayers: 8,
    maxNameLength: 16,
    /** Extra connections allowed beyond the players (host pages). */
    maxHostConnections: 4,
  },

  log: {
    /** A perf line (tick time, memory, bandwidth) is written to the match log this often. */
    perfIntervalSec: 10,
  },

  /** The test-only load room (CROSSFIRE_LOAD_ROOM=1). Never used in a real game. */
  loadTest: {
    /** Wave size so large that the spawner never runs out: the field stays at the cap. */
    waveBase: 1_000_000,
    /** Budget: sim tick + state patch, 95th percentile over the run (ms). */
    tickBudgetMs: 10,
    /** Samples before this are warm-up and ignored for memory and load (s). */
    warmupSec: 120,
    /** Memory: median of the last `lateSec` vs the median from warm-up to `earlyEndSec`. */
    earlyEndSec: 300,
    lateSec: 180,
    memoryGrowthFactor: 1.1,
    memorySlackMB: 5,
    /** Load held: enemies ≥ this share of the cap ... */
    loadShare: 0.95,
    /** ... in at least this share of the samples. */
    loadSampleShare: 0.9,
  },

  client: {
    /** Remote entities render this far behind the newest snapshot (ms). */
    interpDelayMs: 100,
    /** Snapshots kept per entity for interpolation. */
    snapshotBuffer: 8,
    /** Unacknowledged inputs kept for prediction replay. */
    pendingInputCap: 64,
    /** Prediction errors above this snap instead of smoothing (m). */
    snapDistance: 2,
    /** Time constant of the prediction error smoothing (s). */
    smoothingSec: 0.1,
    /** Retry interval on the join screen (run in progress, host unreachable) (ms). */
    joinRetryMs: 5000,
    /** A killed enemy stays visible this long for its death animation (s). */
    deathAnimSec: 3,
    /** Extra enemy views beyond the enemy cap, for enemies still playing their death. */
    deathViewSlack: 40,
    /** Camera offset from the followed hero (look test). */
    cameraOffset: { x: 0, y: 17, z: 12.5 },
    cameraFov: 42,
  },
};

export type Tuning = typeof TUNING;
