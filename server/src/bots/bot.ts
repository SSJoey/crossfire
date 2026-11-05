import type { Client, Room } from '@colyseus/sdk';
import { TUNING } from '@crossfire/shared/tuning';
import { MSG, type HeroStatus, type InputMessage, type Phase } from '@crossfire/shared/types';
import { decide, type BotEnemy, type BotUnit, type BotView } from './brain';

const INPUT_MS = 1000 / TUNING.tickHz;
/** A bot sets itself ready again this long after the room returns to the lobby. */
const READY_DELAY_MS = 1000;

/** The part of the synced room state a bot reads (decoded by the SDK, see rooms/state.ts). */
interface SyncMap<T> {
  get(key: string): T | undefined;
  forEach(cb: (value: T, key: string) => void): void;
}
interface BotRoomState {
  phase: Phase;
  players: SyncMap<{ ready: boolean }>;
  heroes: SyncMap<{ x: number; z: number; status: HeroStatus }>;
  enemies: SyncMap<{ x: number; z: number; state: string }>;
}

/**
 * A headless player: joins by room code through the normal protocol, gets ready by itself,
 * and sends one input per server tick decided by the bot brain. Used for the load test and to
 * fill a game (1 player + 7 bots).
 */
export class Bot {
  room: Room | null = null;
  connected = false;
  closeCode: number | undefined;
  private seq = 1;
  private inputTimer: ReturnType<typeof setInterval> | null = null;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private startedMs = 0;
  private state: BotRoomState | null = null;
  private readonly view: BotView;
  private readonly heroPool: BotUnit[] = [];
  private readonly enemyPool: BotEnemy[] = [];

  constructor(
    private readonly sdk: Client,
    readonly code: string,
    readonly name: string,
    readonly seed: number,
    /** One-time ticket from the room, so the server marks this player as a bot (host-added bots). */
    private readonly botTicket?: string,
  ) {
    this.view = { meId: '', heroes: [], enemies: [], timeSec: 0, seed };
  }

  /** Joins the room. Rejects with the server's message if the join is refused. */
  async start(): Promise<void> {
    const room = await this.sdk.joinById(
      this.code,
      this.botTicket ? { name: this.name, botTicket: this.botTicket } : { name: this.name },
    );
    this.room = room;
    this.connected = true;
    this.startedMs = performance.now();
    this.view.meId = room.sessionId;
    room.onLeave((code: number) => {
      this.connected = false;
      this.closeCode = code;
      this.clearTimers();
    });
    room.onStateChange((s: unknown) => this.onState(s as BotRoomState));
    room.send(MSG.ready, { ready: true });
    this.inputTimer = setInterval(() => this.sendInput(), INPUT_MS);
  }

  async stop(): Promise<void> {
    this.clearTimers();
    const room = this.room;
    if (room && this.connected) {
      this.connected = false;
      await room.leave().catch(() => undefined);
    }
  }

  private clearTimers(): void {
    if (this.inputTimer) clearInterval(this.inputTimer);
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.inputTimer = null;
    this.readyTimer = null;
  }

  private onState(s: BotRoomState): void {
    this.state = s;
    if (s.phase !== 'lobby' || this.readyTimer || !this.room) return;
    const me = s.players.get(this.room.sessionId);
    if (!me || me.ready) return;
    this.readyTimer = setTimeout(() => {
      this.readyTimer = null;
      if (this.connected && this.state?.phase === 'lobby') this.room?.send(MSG.ready, { ready: true });
    }, READY_DELAY_MS);
  }

  private sendInput(): void {
    const s = this.state;
    const room = this.room;
    if (!s || !room || !this.connected || s.phase !== 'running') return;
    const v = this.view;
    v.timeSec = (performance.now() - this.startedMs) / 1000;
    v.heroes.length = 0;
    v.enemies.length = 0;
    let i = 0;
    s.heroes.forEach((h, id) => {
      const u = (this.heroPool[i++] ??= { id: '', x: 0, z: 0, status: 'standing' });
      u.id = id;
      u.x = h.x;
      u.z = h.z;
      u.status = h.status;
      v.heroes.push(u);
    });
    let j = 0;
    s.enemies.forEach((e) => {
      const u = (this.enemyPool[j++] ??= { x: 0, z: 0, state: '' });
      u.x = e.x;
      u.z = e.z;
      u.state = e.state;
      v.enemies.push(u);
    });
    const c = decide(v, TUNING);
    const msg: InputMessage = { seq: this.seq++, ...c };
    room.send(MSG.input, msg);
  }
}
