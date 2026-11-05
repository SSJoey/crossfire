import { randomUUID } from 'node:crypto';

/** The lowest free "Bot N" name (names compare case-insensitively, like uniqueName). */
export function nextBotName(taken: Iterable<string>): string {
  const lower = new Set<string>();
  for (const t of taken) lower.add(t.toLowerCase());
  for (let n = 1; ; n++) if (!lower.has(`bot ${n}`)) return `Bot ${n}`;
}

/**
 * One-time join tickets for bots the host page adds. The room gives a ticket to its bot
 * process; the bot joins with it, and the room marks that player as a bot at join time.
 * A ticket is a random UUID, works once and expires. The store never holds more than `max`.
 */
export class BotTickets {
  private readonly tickets = new Map<string, { name: string; expiresMs: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly max: number,
  ) {}

  /** A new ticket for a bot called `name`, or null when `max` tickets are already pending. */
  issue(name: string, nowMs: number): string | null {
    if (this.pending(nowMs) >= this.max) return null;
    const ticket = randomUUID();
    this.tickets.set(ticket, { name, expiresMs: nowMs + this.ttlMs });
    return ticket;
  }

  /** Uses up a ticket. Returns the bot's name, or null for anything unknown, used or expired. */
  consume(ticket: unknown, nowMs: number): string | null {
    if (typeof ticket !== 'string') return null;
    this.prune(nowMs);
    const t = this.tickets.get(ticket);
    if (!t) return null;
    this.tickets.delete(ticket);
    return t.name;
  }

  /** Tickets issued but not yet used or expired. */
  pending(nowMs: number): number {
    this.prune(nowMs);
    return this.tickets.size;
  }

  /** Names of the pending tickets (their seats are taken). */
  names(nowMs: number): string[] {
    this.prune(nowMs);
    return [...this.tickets.values()].map((t) => t.name);
  }

  clear(): void {
    this.tickets.clear();
  }

  private prune(nowMs: number): void {
    for (const [k, t] of this.tickets) if (t.expiresMs < nowMs) this.tickets.delete(k);
  }
}
