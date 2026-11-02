import { schema, t, type SchemaType } from '@colyseus/schema';

/** A person in the lobby (not the host page). */
export const PlayerState = schema(
  {
    name: t.string().default(''),
    ready: t.boolean().default(false),
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
  },
  'HoldState',
);
export type HoldState = SchemaType<typeof HoldState>;
