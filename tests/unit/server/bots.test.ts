import { describe, expect, it } from 'vitest';
import { BotTickets, nextBotName } from '../../../server/src/bots/tickets';

describe('nextBotName', () => {
  it('takes the lowest free number', () => {
    expect(nextBotName([])).toBe('Bot 1');
    expect(nextBotName(['Bot 1', 'Bot 2'])).toBe('Bot 3');
    expect(nextBotName(['Bot 1', 'Bot 3'])).toBe('Bot 2');
  });

  it('skips a name a human already uses (case-insensitive)', () => {
    expect(nextBotName(['bot 1', 'Ann'])).toBe('Bot 2');
  });
});

describe('BotTickets', () => {
  it('a ticket works once and gives back its name', () => {
    const t = new BotTickets(10_000, 8);
    const ticket = t.issue('Bot 1', 0)!;
    expect(ticket).toMatch(/^[0-9a-f-]{36}$/);
    expect(t.pending(1)).toBe(1);
    expect(t.consume(ticket, 1)).toBe('Bot 1');
    expect(t.consume(ticket, 2)).toBeNull();
    expect(t.pending(2)).toBe(0);
  });

  it('unknown and non-string tickets give nothing', () => {
    const t = new BotTickets(10_000, 8);
    t.issue('Bot 1', 0);
    for (const v of ['x', '', undefined, null, 42, {}, ['a']]) expect(t.consume(v, 1)).toBeNull();
    expect(t.pending(1)).toBe(1);
  });

  it('tickets expire', () => {
    const t = new BotTickets(10_000, 8);
    const ticket = t.issue('Bot 1', 0)!;
    expect(t.pending(10_001)).toBe(0);
    expect(t.consume(ticket, 10_001)).toBeNull();
  });

  it('never holds more than the cap', () => {
    const t = new BotTickets(10_000, 3);
    expect([1, 2, 3].map((i) => t.issue(`Bot ${i}`, 0))).not.toContain(null);
    expect(t.issue('Bot 4', 0)).toBeNull();
    expect(t.pending(0)).toBe(3);
    t.clear();
    expect(t.pending(0)).toBe(0);
  });

  it('names of pending tickets count as taken', () => {
    const t = new BotTickets(10_000, 8);
    t.issue('Bot 1', 0);
    expect(t.names(0)).toEqual(['Bot 1']);
  });
});
