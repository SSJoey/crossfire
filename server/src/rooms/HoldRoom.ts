import { type AuthContext, type Client, Room, ServerError } from '@colyseus/core';
import { loadTuning } from '@crossfire/shared/rules/loadtest';
import {
  isLoopbackAddress,
  RateLimiter,
  sanitizeInput,
  sanitizeName,
  sanitizePerfReport,
  uniqueName,
} from '@crossfire/shared/rules/validation';
import { TUNING } from '@crossfire/shared/tuning';
import {
  CLOSE,
  JOIN_ERRORS,
  MSG,
  ROOM_CODE_LETTERS,
  SERVER_MSG,
  type PerfReport,
  type Phase,
  type RunEndedMessage,
} from '@crossfire/shared/types';
import { BotSupervisor } from '../bots/supervisor';
import { BotTickets, nextBotName } from '../bots/tickets';
import type { EndReason, LeaveReason } from '../log/format';
import { round2 } from '../log/format';
import { logDir, MatchLog } from '../log/MatchLog';
import { kBps, memoryMB, socketBytesWritten, TickStats } from '../log/perf';
import { FixedTicker } from '../sim/tick';
import { World, type WorldOptions } from '../sim/world';
import { BoltState, EnemyState, HeroState, HoldState, PlayerState } from './state';

type Role = 'host' | 'player';
interface AuthResult {
  role: Role;
  name?: string;
  /** Joined with a valid bot ticket from this room. */
  bot?: boolean;
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
  /**
   * Where host-added bots connect (this server, over loopback). Set by createApp from the
   * server's own listen address, never from anything a client sends. Unset: no bots.
   */
  static botUrl: string | undefined;

  override maxClients = TUNING.lobby.maxPlayers + TUNING.lobby.maxHostConnections;
  override state = new HoldState();
  /** Created in onCreate, from worldOptions(). */
  world!: World;
  private seed = 0;
  private readonly hosts = new Set<string>();
  private readonly net = new Map<string, NetStats & { limiter: RateLimiter }>();
  private hostSeen = false;
  private readonly ticker = new FixedTicker(TUNING.tickHz, TUNING.maxCatchUpSteps, () => this.tick());
  private readonly enemyStates = new Map<number, EnemyState>();
  private readonly boltStates = new Map<number, BoltState>();
  private readonly seen = new Set<number>();

  // ---- match log and perf ----
  private log: MatchLog | null = null;
  private runStartMs = 0;
  /** A perf line is written this often during a run (tests shorten it). */
  perfIntervalMs = TUNING.log.perfIntervalSec * 1000;
  private lastPerfMs = 0;
  private readonly runTicks = new TickStats();
  private readonly windowTicks = new TickStats();
  private readonly runPatches = new TickStats();
  private readonly windowPatches = new TickStats();
  private readonly bytesAtPerf = new Map<string, number>();
  private readonly leaveReasons = new Map<string, LeaveReason>();
  /** At most one client report per player in this time (tests shorten it). */
  clientReportMinGapMs = TUNING.log.clientReportMinGapSec * 1000;
  /** Reports older than this are left out of the perf line (tests shorten it). */
  clientReportMaxAgeMs = TUNING.log.clientReportMaxAgeSec * 1000;
  private readonly reports = new Map<string, { report: PerfReport; atMs: number }>();

  // ---- host-added bots ----
  private bots: BotSupervisor | null = null;
  private botSeed = 0;
  private readonly botTickets = new BotTickets(TUNING.lobby.botTicketSec * 1000, TUNING.lobby.maxPlayers);

  /** The bot process id while this room has one (for tests). */
  get botProcessPid(): number | undefined {
    return this.bots?.pid;
  }

  /** Which addresses count as the host laptop. Overridden in tests to simulate a LAN client. */
  isHostAddress(ip: string | undefined): boolean {
    return isLoopbackAddress(ip);
  }

  netStats(sessionId: string): NetStats | undefined {
    return this.net.get(sessionId);
  }

  /** Simulation settings for this room. The load-test room overrides it. */
  protected worldOptions(_options: unknown): WorldOptions {
    return {};
  }

  override async onCreate(options: unknown): Promise<void> {
    this.seed = Date.now() >>> 0;
    this.world = new World({ ...this.worldOptions(options), seed: this.seed });
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
      this.backToLobby('aborted');
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
      if (target && !this.hosts.has(id)) {
        this.leaveReasons.set(id, 'kicked');
        target.leave(CLOSE.kicked);
      }
    });

    this.onMessage(MSG.addBot, (client) => {
      if (!this.guard(client) || !this.isHost(client)) return;
      if (!this.addBot()) return this.reject(client);
      this.accept(client);
    });

    this.onMessage(MSG.removeBots, (client) => {
      if (!this.guard(client) || !this.isHost(client)) return;
      if (this.state.phase !== 'lobby') return this.reject(client);
      this.accept(client);
      this.removeBots();
    });

    this.onMessage(MSG.perf, (client, payload: unknown) => {
      if (!this.guard(client)) return;
      const id = client.sessionId;
      if (this.state.phase !== 'running' || !this.state.players.has(id)) return this.reject(client);
      const report = sanitizePerfReport(payload);
      if (!report) return this.reject(client);
      const t = now();
      const prev = this.reports.get(id);
      if (prev && t - prev.atMs < this.clientReportMinGapMs) return this.reject(client);
      this.accept(client);
      this.reports.set(id, { report, atMs: t });
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
    if (opts.botTicket !== undefined) {
      const botName = this.botTickets.consume(opts.botTicket, now());
      if (botName !== null) return { role: 'player', name: botName, bot: true };
    }
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
    // Seats promised to bots that are still on their way count as taken for humans.
    const reserved = auth.bot ? 0 : this.botTickets.pending(now());
    if (this.state.players.size + reserved >= TUNING.lobby.maxPlayers)
      throw new ServerError(409, JOIN_ERRORS.full);
    const names = [...this.state.players.values()].map((p) => p.name);
    const player = new PlayerState();
    player.name = uniqueName(auth.name ?? '', names);
    player.bot = auth.bot === true;
    this.state.players.set(client.sessionId, player);
    this.state.playerCount = this.state.players.size;
  }

  override onLeave(client: Client): void {
    const id = client.sessionId;
    const reason = this.leaveReasons.get(id) ?? 'left';
    this.leaveReasons.delete(id);
    this.net.delete(id);
    this.bytesAtPerf.delete(id);
    this.reports.delete(id);
    if (this.hosts.delete(id)) {
      // No host page left: nobody can remove the bots any more, so they go now.
      if (this.hosts.size === 0) this.removeBots();
      return;
    }
    const player = this.state.players.get(id);
    if (!player) return;
    this.state.players.delete(id);
    this.state.playerCount = this.state.players.size;
    if (player.bot) this.stopBotsIfIdle();
    if (this.world.heroes.has(id)) {
      this.log?.write(now(), { ev: 'left', name: player.name, reason });
      this.world.removeHero(id);
      this.state.heroes.delete(id);
    }
    if (this.state.phase !== 'lobby' && this.state.players.size === 0) this.backToLobby('empty');
  }

  override async onDispose(): Promise<void> {
    this.botTickets.clear();
    this.bots?.stop();
    this.bots = null;
    if (this.log) await this.endLog('aborted');
    await this.presence.srem(CODES_CHANNEL, this.roomId);
  }

  /** Times the state encoding and send, for the perf lines. */
  override broadcastPatch(): boolean {
    if (this.state.phase !== 'running') return super.broadcastPatch();
    const t0 = now();
    const sent = super.broadcastPatch();
    const ms = now() - t0;
    this.runPatches.add(ms);
    this.windowPatches.add(ms);
    return sent;
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
    if (s.limiter.shouldKick(t)) {
      this.leaveReasons.set(client.sessionId, 'flooded');
      client.leave(CLOSE.flood);
    }
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

  // ---- host-added bots ----

  /** Adds one bot (lobby only, while a seat is free). Returns false if refused. */
  private addBot(): boolean {
    const url = HoldRoom.botUrl;
    if (!url || this.state.phase !== 'lobby') return false;
    const t = now();
    if (this.state.players.size + this.botTickets.pending(t) >= TUNING.lobby.maxPlayers) return false;
    const taken = [...this.state.players.values()].map((p) => p.name).concat(this.botTickets.names(t));
    const name = nextBotName(taken);
    const ticket = this.botTickets.issue(name, t);
    if (!ticket) return false;
    this.bots ??= new BotSupervisor((botName, error) => {
      console.warn(`Bot "${botName}" could not join room ${this.roomId}: ${error}`);
      this.stopBotsIfIdle();
    });
    this.bots.add({ url, code: this.roomId, name, seed: ++this.botSeed, ticket });
    return true;
  }

  /** Every bot leaves; the bot process stops. */
  private removeBots(): void {
    this.botTickets.clear();
    for (const c of this.clients) {
      if (!this.state.players.get(c.sessionId)?.bot) continue;
      this.leaveReasons.set(c.sessionId, 'kicked');
      c.leave(CLOSE.kicked);
    }
    this.stopBotsIfIdle();
  }

  /** Stops the bot process once no bot is in the room or on its way. */
  private stopBotsIfIdle(): void {
    if (!this.bots) return;
    if (this.botTickets.pending(now()) > 0) return;
    for (const p of this.state.players.values()) if (p.bot) return;
    this.bots.stop();
    this.bots = null;
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
    const t = now();
    this.world.start(t);
    this.setPhase('running');
    this.syncState();
    this.openLog(
      t,
      players.map(([, p]) => p.name),
      players.filter(([, p]) => p.bot).map(([, p]) => p.name),
    );
  }

  private backToLobby(reason: EndReason = 'aborted'): void {
    if (this.state.phase === 'lobby') return;
    if (this.log) void this.endLog(reason);
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
    const t0 = now();
    this.world.step(t0);
    let ended = false;
    for (const ev of this.world.events) {
      switch (ev.type) {
        case 'runEnded': {
          this.setPhase('ended');
          const msg: RunEndedMessage = { wave: ev.wave, durationSec: ev.durationSec };
          this.broadcast(SERVER_MSG.ended, msg);
          ended = true;
          break;
        }
        case 'waveStarted':
        case 'waveCleared':
          this.log?.write(t0, { ev: ev.type, wave: ev.wave });
          break;
        case 'heroDowned':
        case 'heroDied':
        case 'heroRevived': {
          const name = this.world.heroes.get(ev.id)?.name;
          const kind = ev.type === 'heroDowned' ? 'downed' : ev.type === 'heroDied' ? 'died' : 'revived';
          if (name !== undefined) this.log?.write(t0, { ev: kind, name });
          break;
        }
      }
    }
    this.syncState();
    const ms = now() - t0;
    this.runTicks.add(ms);
    this.windowTicks.add(ms);
    if (ended) void this.endLog('wiped');
    else if (t0 - this.lastPerfMs >= this.perfIntervalMs) this.writePerf(t0);
  }

  // ---- match log ----

  private openLog(t: number, names: string[], bots: string[]): void {
    if (this.log) void this.endLog('aborted');
    this.runStartMs = t;
    this.lastPerfMs = t;
    this.runTicks.reset();
    this.windowTicks.reset();
    this.runPatches.reset();
    this.windowPatches.reset();
    this.bytesAtPerf.clear();
    this.reports.clear();
    for (const c of this.clients)
      if (this.state.players.has(c.sessionId)) this.bytesAtPerf.set(c.sessionId, socketBytesWritten(c.ref));
    this.log = new MatchLog(logDir(), this.roomId, new Date(), t);
    this.log.write(t, {
      ev: 'start',
      at: new Date().toISOString(),
      code: this.roomId,
      seed: this.seed,
      players: names,
      bots,
    });
    this.log.write(t, { ev: 'waveStarted', wave: this.world.wave });
  }

  private writePerf(t: number): void {
    const log = this.log;
    if (!log) return;
    const elapsed = t - this.lastPerfMs;
    const perClient: Record<string, number> = {};
    let sum = 0;
    let max = 0;
    let n = 0;
    for (const c of this.clients) {
      const p = this.state.players.get(c.sessionId);
      if (!p) continue;
      const bytes = socketBytesWritten(c.ref);
      const rate = kBps(bytes, this.bytesAtPerf.get(c.sessionId) ?? bytes, elapsed);
      this.bytesAtPerf.set(c.sessionId, bytes);
      perClient[p.name] = round2(rate);
      sum += rate;
      if (rate > max) max = rate;
      n++;
    }
    const clients: Record<string, PerfReport> = {};
    for (const [id, r] of this.reports) {
      const p = this.state.players.get(id);
      if (p && t - r.atMs <= this.clientReportMaxAgeMs) clients[p.name] = r.report;
    }
    const mem = memoryMB();
    log.write(t, {
      ev: 'perf',
      tickP95Ms: round2(this.windowTicks.percentile(0.95)),
      tickMaxMs: round2(this.windowTicks.max),
      patchP95Ms: round2(this.windowPatches.percentile(0.95)),
      ticks: this.windowTicks.count,
      heapMB: round2(mem.heapMB),
      rssMB: round2(mem.rssMB),
      enemies: this.world.enemies.count,
      bolts: this.world.projectiles.count,
      players: n,
      kBpsAvg: round2(n > 0 ? sum / n : 0),
      kBpsMax: round2(max),
      kBps: perClient,
      clients,
    });
    this.windowTicks.reset();
    this.windowPatches.reset();
    this.lastPerfMs = t;
  }

  private endLog(reason: EndReason): Promise<void> {
    const log = this.log;
    if (!log) return Promise.resolve();
    this.log = null;
    const t = now();
    log.write(t, {
      ev: 'end',
      reason,
      wave: this.world.wave,
      durationSec: Math.round((t - this.runStartMs) / 1000),
      kills: this.world.kills,
      tickP95Ms: round2(this.runTicks.percentile(0.95)),
      tickMaxMs: round2(this.runTicks.max),
      patchP95Ms: round2(this.runPatches.percentile(0.95)),
    });
    return log.close();
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

/**
 * Test-only load room (`hold_load`), registered only when the server runs with
 * CROSSFIRE_LOAD_ROOM=1. Heroes take no damage and the field stays at the enemy cap the host
 * asks for (`enemyCap` create option, at most the game cap). Everything else is a normal room.
 */
export class LoadHoldRoom extends HoldRoom {
  protected override worldOptions(options: unknown): WorldOptions {
    const cap =
      typeof options === 'object' && options !== null
        ? (options as Record<string, unknown>).enemyCap
        : undefined;
    return { tuning: loadTuning(TUNING, cap) };
  }
}
