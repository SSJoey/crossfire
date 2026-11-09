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

  /**
   * The four hero kits (stage 1b; NOTES.md 2026-11-09). Base stats and basic attacks are
   * look-test values; E utilities and passives were agreed with JCCJ. Read them through
   * `heroKit(id, level)` in shared/heroes.ts.
   */
  heroes: {
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
      /** Flame step: blink toward the aim. */
      utility: { cooldownSec: 8, range: 6 },
      /** Kindle: bolt hits burn (a new hit refreshes the timer; no stacking). */
      passive: { burnDps: 4, burnSec: 2 },
    },
    bastion: {
      maxHp: 400,
      speed: 4.8,
      radius: 0.5,
      melee: { damage: 34, intervalSec: 0.8, reach: 2.4 },
      /** Stone skin: damage reduction and a taunt around him. */
      utility: { cooldownSec: 14, durationSec: 4, damageTakenMul: 0.4, tauntRadius: 6, tauntSec: 4 },
      /** Steadfast: always takes less damage. */
      passive: { damageTakenMul: 0.85 },
    },
    tide: {
      maxHp: 400,
      speed: 5.2,
      radius: 0.5,
      bolt: { damage: 16, intervalSec: 0.6, range: 12, speed: 22, hitRadius: 0.15 },
      /** Mending wave: heals self and standing allies around. */
      utility: { cooldownSec: 16, radius: 6, healFrac: 0.3 },
      /** Undertow: bolt hits slow. */
      passive: { slowFrac: 0.3, slowSec: 1.5 },
    },
    gale: {
      maxHp: 400,
      speed: 6.4,
      radius: 0.5,
      melee: { damage: 22, intervalSec: 0.45, reach: 2.2 },
      /**
       * Gust dash: `distance` toward the aim over `durationSec`. Enemies whose circle comes
       * within `pathWidth` of the hero during the dash are knocked `knockback` metres aside.
       */
      utility: { cooldownSec: 7, distance: 7, durationSec: 0.25, knockback: 3, pathWidth: 1 },
      /** Tailwind: every `every`-th swing that hits deals `mult` × damage. */
      passive: { every: 4, mult: 2 },
    },
  },

  /** Melee basic attacks (look test). */
  melee: {
    /** A swing hits enemies whose centre is within reach + this. */
    extraReach: 0.4,
    /** Front arc: cos of the angle between facing and the enemy must be at least this. */
    arcCos: 0.35,
    /** Knockback speed given to each enemy hit (m/s); it decays with `knockbackDecayPerSec`. */
    knockbackSpeed: 2.5,
    /** Aim assist looks this much beyond reach to pick the swing's facing. */
    assistExtra: 1.2,
  },

  /** Exponential decay rate of enemy knockback velocity (1/s). Total slide = speed / rate. */
  knockbackDecayPerSec: 4,

  /** Q zones (stage 1b): shared size, duration, range and cooldown; effects per element. */
  zones: {
    radius: 3,
    durationSec: 4.2,
    castRange: 11,
    cooldownSec: 5,
    /** Most zones alive at once (8 heroes with a 5 s cooldown keep at most 8). */
    cap: 32,
    /** Fire zone. */
    fire: { dps: 14 },
    /** Quake slam: damage and stun when cast, then a weak burn. */
    earth: { dps: 6, impactDamage: 30, stunSec: 1 },
    /** Tidal pool: slow while inside (refreshed each tick for `slowHoldSec`). */
    water: { dps: 6, slowFrac: 0.5, slowHoldSec: 0.2 },
    /** Cyclone: pulls enemies to the centre. */
    air: { dps: 6, pullSpeed: 2 },
  },

  /** Debug hero switch (1–4, only with ?debug=1 and CROSSFIRE_DEBUG=1): at most once per this. */
  heroSwitchSec: 1,

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
    /**
     * Hard cap on raw frames per client per second, of any kind (Colyseus maxMessagesPerSecond).
     * Over it the client is cut off at once. A normal client sends about 20 (audit 1, F3/F4).
     */
    maxFramesPerSec: 240,
    /** Largest matchmaking request body (bytes); join and create options are tiny (audit 1, F2). */
    maxMatchmakeBodyBytes: 16 * 1024,
    /** A client with more than this unsent (it stopped reading) is dropped (audit 1, O1). */
    maxSendBacklogBytes: 1024 * 1024,
  },

  lobby: {
    maxPlayers: 8,
    maxNameLength: 16,
    /** Extra connections allowed beyond the players (host pages). */
    maxHostConnections: 4,
    /** A bot added from the host page must join within this time, or its seat is freed (s). */
    botTicketSec: 10,
    /** A seat reserved over HTTP must be taken by its socket within this time (s). */
    seatReservationSec: 5,
    /** Joins one LAN address may start per seat-reservation window (the host laptop is exempt). */
    maxReservationsPerIp: 2,
    /** A client must acknowledge JOIN within this time, or it is dropped and its seat freed (s). */
    joinAckSec: 5,
    /** Player seats one LAN address may hold at once; the host laptop is exempt (audit 1, R2). */
    maxSeatsPerAddress: 1,
    /** A kicked LAN address cannot rejoin for this long (s). */
    kickCooldownSec: 60,
    /** Combining marks kept per character; more are dropped (audit 1, R3). */
    maxMarksPerGrapheme: 4,
    /** Hard cap on a name's length in UTF-16 units, whatever it is made of. */
    maxNameUnits: 64,
  },

  pause: {
    /** A player can pause again only this long after the resume of their own last pause (s). */
    cooldownSec: 10,
    /** How long the client shows "Pause available in N s" after an Esc during the cooldown (s). */
    hintSec: 2,
  },

  log: {
    /** A perf line (tick time, memory, bandwidth) is written to the match log this often. */
    perfIntervalSec: 10,
    /** Each client reports its tier and fps this often during a run. */
    clientReportSec: 10,
    /** The server accepts at most one report per player in this time; extras are rejected. */
    clientReportMinGapSec: 5,
    /** A report older than this is left out of the perf line. */
    clientReportMaxAgeSec: 20,
    /** Limits of a valid report. */
    maxReportFps: 1000,
    maxCanvasPx: 16384,
    minDpr: 0.25,
    maxDpr: 8,
    /**
     * A frame longer than this is a sleeping or frozen machine, not a frame (ms). Hidden tabs are
     * caught by the visibility event instead (JCCJ, 2026-11-09).
     */
    maxFrameMs: 10_000,
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
