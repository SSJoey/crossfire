import { type AuthContext, type Client, Room, ServerError } from '@colyseus/core';
import {
  isLoopbackAddress,
  RateLimiter,
  sanitizeInput,
  sanitizeName,
  uniqueName,
} from '@crossfire/shared/rules/validation';
import { TUNING } from '@crossfire/shared/tuning';
import {
  CLOSE,
  JOIN_ERRORS,
  MSG,
  ROOM_CODE_LETTERS,
  SERVER_MSG,
  type Phase,
  type RunEndedMessage,
} from '@crossfire/shared/types';
import { FixedTicker } from '../sim/tick';
import { World } from '../sim/world';
import { BoltState, EnemyState, HeroState, HoldState, PlayerState } from './state';

type Role = 'host' | 'player';
interface AuthResult {
  role: Role;
  name?: string;
}

export interface NetStats {
  /** Every message received, of any type. */
  received: number;
  /** Passed the rate limit and validation. */
  accepted: number;
  /** Failed validation. */
  rejected: number;
  /** Dropped by the rate limit. */
  dropped: number;
  /** Unknown message types. */
  unknown: number;
}

const CODES_CHANNEL = '$holdcodes';

function now(): number {
  return performance.now();
}

/**
 * One game: a lobby, then a run. The server is authoritative. Clients only send inputs and
 * lobby choices; every message passes a per-client rate limit and validation first.
 */
export class HoldRoom extends Room<{ state: HoldState }> {
  override maxClients = TUNING.lobby.maxPlayers + TUNING.lobby.maxHostConnections;
  override state = new HoldState();
  readonly world = new World({ seed: Date.now() >>> 0 });
  private readonly hosts = new Set<string>();
  private readonly net = new Map<string, NetStats & { limiter: RateLimiter }>();
  private hostSeen = false;
  private readonly ticker = new FixedTicker(TUNING.tickHz, TUNING.maxCatchUpSteps, () => this.tick());
  private readonly enemyStates = new Map<number, EnemyState>();
  private readonly boltStates = new Map<number, BoltState>();
  private readonly seen = new Set<number>();

  /** Which addresses count as the host laptop. Overridden in tests to simulate a LAN client. */
  isHostAddress(ip: string | undefined): boolean {
    return isLoopbackAddress(ip);
  }

  netStats(sessionId: string): NetStats | undefined {
    return this.net.get(sessionId);
  }

  override async onCreate(): Promise<void> {
    this.roomId = await this.generateRoomCode();

    this.onMessage(MSG.input, (client, payload: unknown) => {
      if (!this.guard(client)) return;
      if (this.state.phase !== 'running') return;
      const input = sanitizeInput(payload);
      if (!input) return this.reject(client);
      this.accept(client);
      this.world.setInput(client.sessionId, input, now());
    });

    this.onMessage(MSG.ready, (client, payload: unknown) => {
      if (!this.guard(client)) return;
      const ready =
        typeof payload === 'object' && payload !== null && !Array.isArray(payload)
          ? (payload as Record<string, unknown>).ready
          : undefined;
      if (typeof ready !== 'boolean') return this.reject(client);
      this.accept(client);
      const p = this.state.players.get(client.sessionId);
      if (p && this.state.phase === 'lobby') p.ready = ready;
    });

    this.onMessage(MSG.start, (client) => {
      if (!this.guard(client) || !this.isHost(client)) return;
      this.accept(client);
      this.startRun();
    });

    this.onMessage(MSG.restart, (client) => {
      if (!this.guard(client) || !this.isHost(client)) return;
      this.accept(client);
      this.backToLobby();
    });

    this.onMessage(MSG.kick, (client, payload: unknown) => {
      if (!this.guard(client) || !this.isHost(client)) return;
      const id =
        typeof payload === 'object' && payload !== null && !Array.isArray(payload)
          ? (payload as Record<string, unknown>).sessionId
          : undefined;
      if (typeof id !== 'string') return this.reject(client);
      this.accept(client);
      const target = this.clients.find((c) => c.sessionId === id);
      if (target && !this.hosts.has(id)) target.leave(CLOSE.kicked);
    });

    this.onMessage('*', (client) => {
      if (!this.guard(client)) return;
      const s = this.net.get(client.sessionId);
      if (s) s.unknown++;
    });

    this.setTimestep((deltaMs) => this.ticker.advance(deltaMs));
  }

  override onAuth(_client: Client, options: unknown, context: AuthContext): AuthResult {
    const opts = (typeof options === 'object' && options !== null ? options : {}) as Record<string, unknown>;
    if (opts.role === 'host') {
      if (!this.isHostAddress(context.ip)) throw new ServerError(403, JOIN_ERRORS.notHost);
      return { role: 'host' };
    }
    if (!this.hostSeen) throw new ServerError(403, JOIN_ERRORS.notHost);
    if (this.state.phase !== 'lobby') throw new ServerError(409, JOIN_ERRORS.inProgress);
    const n = sanitizeName(opts.name);
    if (!n.ok) throw new ServerError(400, JOIN_ERRORS.emptyName);
    return { role: 'player', name: n.name };
  }

  override onJoin(client: Client, _options: unknown, auth: AuthResult): void {
    this.net.set(client.sessionId, {
      received: 0,
      accepted: 0,
      rejected: 0,
      dropped: 0,
      unknown: 0,
      limiter: new RateLimiter(),
    });
    if (auth.role === 'host') {
      this.hosts.add(client.sessionId);
      this.hostSeen = true;
      return;
    }
    // Checked again here, synchronously, so simultaneous joins cannot overshoot the cap.
    if (this.state.phase !== 'lobby') throw new ServerError(409, JOIN_ERRORS.inProgress);
    if (this.state.players.size >= TUNING.lobby.maxPlayers) throw new ServerError(409, JOIN_ERRORS.full);
    const names = [...this.state.players.values()].map((p) => p.name);
    const player = new PlayerState();
    player.name = uniqueName(auth.name ?? '', names);
    this.state.players.set(client.sessionId, player);
    this.state.playerCount = this.state.players.size;
  }

  override onLeave(client: Client): void {
    this.net.delete(client.sessionId);
    if (this.hosts.delete(client.sessionId)) return;
    if (!this.state.players.has(client.sessionId)) return;
    this.state.players.delete(client.sessionId);
    this.state.playerCount = this.state.players.size;
    if (this.world.heroes.has(client.sessionId)) {
      this.world.removeHero(client.sessionId);
      this.state.heroes.delete(client.sessionId);
    }
    if (this.state.phase !== 'lobby' && this.state.players.size === 0) this.backToLobby();
  }

  override async onDispose(): Promise<void> {
    await this.presence.srem(CODES_CHANNEL, this.roomId);
  }

  // ---- message guards ----

  /** Counts the message and applies the rate limit. Returns false if it must be dropped. */
  private guard(client: Client): boolean {
    const s = this.net.get(client.sessionId);
    if (!s) return false;
    s.received++;
    const t = now();
    if (s.limiter.allow(t)) return true;
    s.dropped++;
    if (s.limiter.shouldKick(t)) client.leave(CLOSE.flood);
    return false;
  }

  private accept(client: Client): void {
    const s = this.net.get(client.sessionId);
    if (s) s.accepted++;
  }

  private reject(client: Client): void {
    const s = this.net.get(client.sessionId);
    if (s) s.rejected++;
  }

  private isHost(client: Client): boolean {
    return this.hosts.has(client.sessionId);
  }

  // ---- lobby flow ----

  private setPhase(phase: Phase): void {
    this.state.phase = phase;
  }

  private startRun(): void {
    if (this.state.phase !== 'lobby') return;
    const players = [...this.state.players.entries()];
    if (players.length === 0 || !players.every(([, p]) => p.ready)) return;
    for (const id of [...this.world.heroes.keys()]) this.world.removeHero(id);
    this.state.heroes.clear();
    for (const [id, p] of players) {
      this.world.addHero(id, p.name);
      const hs = new HeroState();
      hs.name = p.name;
      this.state.heroes.set(id, hs);
    }
    this.world.start(now());
    this.setPhase('running');
    this.syncState();
  }

  private backToLobby(): void {
    if (this.state.phase === 'lobby') return;
    this.world.stop();
    for (const id of [...this.world.heroes.keys()]) this.world.removeHero(id);
    this.state.heroes.clear();
    this.state.enemies.clear();
    this.state.bolts.clear();
    this.enemyStates.clear();
    this.boltStates.clear();
    for (const p of this.state.players.values()) p.ready = false;
    this.state.wave = 0;
    this.setPhase('lobby');
  }

  // ---- simulation ----

  private tick(): void {
    if (this.state.phase !== 'running') return;
    this.world.step(now());
    for (const ev of this.world.events) {
      if (ev.type === 'runEnded') {
        this.setPhase('ended');
        const msg: RunEndedMessage = { wave: ev.wave, durationSec: ev.durationSec };
        this.broadcast(SERVER_MSG.ended, msg);
      }
    }
    this.syncState();
  }

  /** Mirrors the simulation into the synced state. Schema only sends fields that changed. */
  private syncState(): void {
    const w = this.world;
    this.state.wave = w.wave;
    this.state.waveState = w.waveState;

    for (const h of w.heroes.values()) {
      const s = this.state.heroes.get(h.id);
      if (!s) continue;
      s.x = h.x;
      s.z = h.z;
      s.facing = h.facing;
      s.hp = h.hp;
      s.maxHp = h.maxHp;
      s.status = h.status;
      s.bleedOut = h.bleedOut;
      s.reviveProgress = h.reviveProgress;
      s.lastSeq = Math.max(0, h.input.seq);
    }

    this.seen.clear();
    for (let i = 0; i < w.enemies.count; i++) {
      const e = w.enemies.items[i]!;
      this.seen.add(e.uid);
      let s = this.enemyStates.get(e.uid);
      if (!s) {
        s = new EnemyState();
        this.enemyStates.set(e.uid, s);
        this.state.enemies.set(String(e.uid), s);
      }
      s.x = e.x;
      s.z = e.z;
      s.facing = e.facing;
      s.hp = e.hp;
      s.maxHp = e.maxHp;
      s.level = e.level;
      s.scale = e.scale;
      s.state = e.state;
    }
    for (const uid of this.enemyStates.keys()) {
      if (!this.seen.has(uid)) {
        this.enemyStates.delete(uid);
        this.state.enemies.delete(String(uid));
      }
    }

    this.seen.clear();
    for (let i = 0; i < w.projectiles.count; i++) {
      const p = w.projectiles.items[i]!;
      this.seen.add(p.uid);
      let s = this.boltStates.get(p.uid);
      if (!s) {
        s = new BoltState();
        s.dirX = p.dirX;
        s.dirZ = p.dirZ;
        this.boltStates.set(p.uid, s);
        this.state.bolts.set(String(p.uid), s);
      }
      s.x = p.x;
      s.z = p.z;
    }
    for (const uid of this.boltStates.keys()) {
      if (!this.seen.has(uid)) {
        this.boltStates.delete(uid);
        this.state.bolts.delete(String(uid));
      }
    }
  }

  // ---- room code ----

  private async generateRoomCode(): Promise<string> {
    const taken = await this.presence.smembers(CODES_CHANNEL);
    let code: string;
    do {
      code = '';
      for (let i = 0; i < 4; i++)
        code += ROOM_CODE_LETTERS[Math.floor(Math.random() * ROOM_CODE_LETTERS.length)];
    } while (taken.includes(code));
    await this.presence.sadd(CODES_CHANNEL, code);
    return code;
  }
}

/** Test-only variant: every client looks like it comes from another laptop on the LAN. */
export class RemoteOnlyHoldRoom extends HoldRoom {
  override isHostAddress(): boolean {
    return false;
  }
}
