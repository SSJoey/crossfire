import { schema, t, type SchemaType } from '@colyseus/schema';

/** A person in the lobby (not the host page). */
export const PlayerState = schema(
  {
    name: t.string().default(''),
    ready: t.boolean().default(false),
    /** Added from the host page (marked by the server, never by the client). */
    bot: t.boolean().default(false),
    /** Picked hero id (stage 1b). */
    hero: t.string().default('ember'),
  },
  'PlayerState',
);
export type PlayerState = SchemaType<typeof PlayerState>;

export const HeroState = schema(
  {
    name: t.string().default(''),
    x: t.float32().default(0),
    z: t.float32().default(0),
    facing: t.angle(),
    hp: t.float32().default(0),
    maxHp: t.float32().default(0),
    status: t.string().default('standing'),
    bleedOut: t.float32().default(0),
    reviveProgress: t.float32().default(0),
    /** Last input applied, for the owner's prediction reconciliation. */
    lastSeq: t.uint32().default(0),
    /** Hero id (stage 1b). */
    hero: t.string().default('ember'),
    /** Q and E cooldowns left (s), for the HUD. */
    qCd: t.float32().default(0),
    eCd: t.float32().default(0),
    /** Bastion's Stone skin is up. */
    stoneSkin: t.boolean().default(false),
    /** Gale is dashing. */
    dashing: t.boolean().default(false),
    /** What the hero last did ('attack', 'q', 'e'), with a counter that changes each time. */
    act: t.string().default(''),
    actSeq: t.uint8().default(0),
  },
  'HeroState',
);
export type HeroState = SchemaType<typeof HeroState>;

export const EnemyState = schema(
  {
    x: t.float32().default(0),
    z: t.float32().default(0),
    facing: t.angle(),
    hp: t.float32().default(0),
    maxHp: t.float32().default(0),
    level: t.uint16().default(1),
    scale: t.float32().default(1),
    state: t.string().default('spawning'),
    /** Status effects for visuals: ENEMY_FX bits (slowed, stunned, burning). */
    fx: t.uint8().default(0),
  },
  'EnemyState',
);
export type EnemyState = SchemaType<typeof EnemyState>;

export const BoltState = schema(
  {
    x: t.float32().default(0),
    z: t.float32().default(0),
    dirX: t.float32().default(0),
    dirZ: t.float32().default(0),
  },
  'BoltState',
);
export type BoltState = SchemaType<typeof BoltState>;

/** A Q zone on the ground (stage 1b). */
export const ZoneState = schema(
  {
    x: t.float32().default(0),
    z: t.float32().default(0),
    element: t.string().default('fire'),
    /** Seconds left. */
    remaining: t.float32().default(0),
  },
  'ZoneState',
);
export type ZoneState = SchemaType<typeof ZoneState>;

export const HoldState = schema(
  {
    phase: t.string().default('lobby'),
    playerCount: t.uint8().default(0),
    wave: t.uint16().default(0),
    waveState: t.string().default('spawning'),
    players: t.map(PlayerState),
    heroes: t.map(HeroState),
    enemies: t.map(EnemyState),
    bolts: t.map(BoltState),
    zones: t.map(ZoneState),
  },
  'HoldState',
);
export type HoldState = SchemaType<typeof HoldState>;
