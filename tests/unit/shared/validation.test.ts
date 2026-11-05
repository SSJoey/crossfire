import { describe, expect, it } from 'vitest';
import {
  acceptSeq,
  graphemeLength,
  isLoopbackAddress,
  isStale,
  RateLimiter,
  sanitizeInput,
  sanitizeName,
  sanitizePerfReport,
  uniqueName,
} from '@crossfire/shared/rules/validation';
import { TUNING } from '@crossfire/shared/tuning';

const good = { seq: 1, moveX: 0.5, moveZ: -0.5, aimX: 3, aimZ: 4, attack: true, revive: false };

describe('sanitizeInput', () => {
  it('accepts a valid input', () => {
    expect(sanitizeInput(good)).toEqual(good);
  });

  it('clamps the move vector to length 1', () => {
    const r = sanitizeInput({ ...good, moveX: 3, moveZ: 4 });
    expect(r).not.toBeNull();
    expect(r!.moveX).toBeCloseTo(0.6);
    expect(r!.moveZ).toBeCloseTo(0.8);
  });

  it('clamps the aim point to the map', () => {
    const r = sanitizeInput({ ...good, aimX: 9000, aimZ: 0 });
    expect(r!.aimX).toBeCloseTo(TUNING.ring.mapRadius);
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    1e308,
    -1e5,
    '1',
    null,
    undefined,
    {},
  ])('rejects %s in any numeric field', (bad) => {
    for (const k of ['moveX', 'moveZ', 'aimX', 'aimZ'] as const) {
      expect(sanitizeInput({ ...good, [k]: bad })).toBeNull();
    }
  });

  it('rejects non-boolean buttons', () => {
    expect(sanitizeInput({ ...good, attack: 1 })).toBeNull();
    expect(sanitizeInput({ ...good, revive: 'yes' })).toBeNull();
  });

  it('rejects bad sequence numbers', () => {
    for (const seq of [-1, 1.5, Number.NaN, 2 ** 31, '3']) expect(sanitizeInput({ ...good, seq })).toBeNull();
    expect(sanitizeInput({ ...good, seq: 2 ** 31 - 1 })).not.toBeNull();
  });

  it.each([null, undefined, 42, 'input', [], [1, 2], true])('rejects non-object payload %s', (bad) => {
    expect(sanitizeInput(bad)).toBeNull();
  });

  it('rejects missing and unknown keys', () => {
    const { attack: _a, ...missing } = good;
    expect(sanitizeInput(missing)).toBeNull();
    expect(sanitizeInput({ ...good, extra: 1 })).toBeNull();
    expect(sanitizeInput({ ...good, __proto__: { attack: true } })).not.toBeNull();
  });

  it('does not throw on nested junk', () => {
    expect(sanitizeInput({ ...good, moveX: { valueOf: () => 1 } })).toBeNull();
    expect(sanitizeInput({ ...good, aimX: [1] })).toBeNull();
  });
});

describe('acceptSeq and isStale', () => {
  it('only accepts newer sequence numbers', () => {
    expect(acceptSeq(-1, 0)).toBe(true);
    expect(acceptSeq(5, 6)).toBe(true);
    expect(acceptSeq(5, 5)).toBe(false);
    expect(acceptSeq(5, 3)).toBe(false);
  });

  it('input older than 250 ms is stale', () => {
    expect(TUNING.net.staleInputMs).toBe(250);
    expect(isStale(1000, 1250)).toBe(false);
    expect(isStale(1000, 1251)).toBe(true);
  });
});

describe('names', () => {
  it('trims and keeps a normal name', () => {
    expect(sanitizeName('  Joey ')).toEqual({ ok: true, name: 'Joey' });
  });

  it('refuses empty and whitespace-only names', () => {
    for (const n of ['', '   ', '\t\n', '​', '‮']) expect(sanitizeName(n).ok).toBe(false);
  });

  it('refuses non-strings', () => {
    for (const n of [undefined, null, 5, {}, ['a']]) expect(sanitizeName(n).ok).toBe(false);
  });

  it('caps names at 16 characters', () => {
    const r = sanitizeName('abcdefghijklmnopqrstuvwxyz');
    expect(r).toEqual({ ok: true, name: 'abcdefghijklmnop' });
  });

  it('keeps HTML as plain text, capped', () => {
    const r = sanitizeName('<img src=x onerror=alert(1)>');
    expect(r).toEqual({ ok: true, name: '<img src=x onerr' });
  });

  it('counts an emoji as one character and never splits one', () => {
    const family = '👨‍👩‍👧‍👦';
    const r = sanitizeName(family.repeat(20));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(graphemeLength(r.name)).toBe(16);
      expect(r.name).toBe(family.repeat(16));
    }
    expect(sanitizeName('🔥Ember🔥')).toEqual({ ok: true, name: '🔥Ember🔥' });
  });

  it('keeps right-to-left letters but strips bidi overrides and control characters', () => {
    expect(sanitizeName('مرحبا')).toEqual({ ok: true, name: 'مرحبا' });
    expect(sanitizeName('ab‮cd⁦e\u0000f\u0007')).toEqual({ ok: true, name: 'abcdef' });
  });

  it('suffixes duplicates and stays within 16 characters', () => {
    expect(uniqueName('Joey', [])).toBe('Joey');
    expect(uniqueName('Joey', ['Joey'])).toBe('Joey 2');
    expect(uniqueName('Joey', ['Joey', 'Joey 2'])).toBe('Joey 3');
    const long = 'abcdefghijklmnop';
    const u = uniqueName(long, [long]);
    expect(u).toBe('abcdefghijklmn 2');
    expect(graphemeLength(u)).toBe(16);
  });

  it('treats duplicates case-insensitively', () => {
    expect(uniqueName('joey', ['Joey'])).toBe('joey 2');
  });
});

describe('RateLimiter', () => {
  it('allows the burst, then refills at the rate', () => {
    const rl = new RateLimiter(60, 120, 3000);
    let allowed = 0;
    for (let i = 0; i < 1000; i++) if (rl.allow(0)) allowed++;
    expect(allowed).toBe(120);
    expect(rl.allow(0)).toBe(false);
    let later = 0;
    for (let i = 0; i < 1000; i++) if (rl.allow(1000)) later++;
    expect(later).toBe(60);
  });

  it('1,000 messages in one second: at most burst + rate applied', () => {
    const rl = new RateLimiter(60, 120, 3000);
    let allowed = 0;
    for (let i = 0; i < 1000; i++) if (rl.allow(i)) allowed++;
    expect(allowed).toBeLessThanOrEqual(180);
    expect(allowed).toBeGreaterThanOrEqual(120);
  });

  it('flags a client that keeps flooding for 3 s, not a short burst', () => {
    const rl = new RateLimiter(60, 120, 3000);
    for (let t = 0; t < 1000; t++) rl.allow(t);
    expect(rl.shouldKick(1000)).toBe(false);
    // Drops start once the 120-message burst is spent (~130 ms in), so 3 s of flooding ends near 3.13 s.
    for (let t = 1000; t <= 3300; t++) rl.allow(t);
    expect(rl.shouldKick(3300)).toBe(true);
  });

  it('forgets a flood after a quiet second', () => {
    const rl = new RateLimiter(60, 120, 3000);
    for (let t = 0; t < 2000; t++) rl.allow(t);
    for (let t = 3500; t < 5000; t += 50) rl.allow(t);
    expect(rl.shouldKick(5000)).toBe(false);
  });
});

describe('isLoopbackAddress', () => {
  it.each(['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1'])('%s is loopback', (ip) => {
    expect(isLoopbackAddress(ip)).toBe(true);
  });
  it.each(['192.168.1.10', '10.0.0.5', '::ffff:192.168.1.2', '', undefined, '128.0.0.1', 'fe80::1'])(
    '%s is not loopback',
    (ip) => {
      expect(isLoopbackAddress(ip)).toBe(false);
    },
  );
});

describe('sanitizePerfReport', () => {
  const report = { tier: 'medium', fps: 58.37, low1: 41.04, w: 1920, h: 1080, dpr: 1 };

  it('accepts a valid report and rounds fps to 1 decimal', () => {
    expect(sanitizePerfReport(report)).toEqual({
      tier: 'medium',
      fps: 58.4,
      low1: 41,
      w: 1920,
      h: 1080,
      dpr: 1,
    });
    expect(sanitizePerfReport({ ...report, tier: 'high', fps: 0, low1: 0, dpr: 1.25 })).not.toBeNull();
    expect(
      sanitizePerfReport({ ...report, tier: 'low', fps: 1000, w: 1, h: 16384, dpr: 0.25 }),
    ).not.toBeNull();
  });

  it('rejects an unknown tier', () => {
    for (const tier of ['ultra', 'HIGH', '', 1, null])
      expect(sanitizePerfReport({ ...report, tier })).toBeNull();
  });

  it('rejects NaN, Infinity, negative and huge numbers', () => {
    for (const k of ['fps', 'low1', 'w', 'h', 'dpr'] as const)
      for (const v of [Number.NaN, Infinity, -Infinity, -1, 1e9, '60'])
        expect(sanitizePerfReport({ ...report, [k]: v }), `${k}=${String(v)}`).toBeNull();
    expect(sanitizePerfReport({ ...report, fps: 1000.1 })).toBeNull();
    expect(sanitizePerfReport({ ...report, dpr: 0.2 })).toBeNull();
    expect(sanitizePerfReport({ ...report, dpr: 8.5 })).toBeNull();
  });

  it('rejects canvas sizes that are not whole pixels from 1 to 16384', () => {
    for (const v of [0, 1.5, 16385]) {
      expect(sanitizePerfReport({ ...report, w: v })).toBeNull();
      expect(sanitizePerfReport({ ...report, h: v })).toBeNull();
    }
  });

  it('rejects missing and extra keys, and non-objects', () => {
    const { dpr: _dpr, ...missing } = report;
    expect(sanitizePerfReport(missing)).toBeNull();
    expect(sanitizePerfReport({ ...report, name: 'x' })).toBeNull();
    for (const v of [null, undefined, 'perf', 42, [], [report]]) expect(sanitizePerfReport(v)).toBeNull();
    expect(sanitizePerfReport(JSON.parse('{"__proto__":{"x":1},"tier":"low"}'))).toBeNull();
  });
});
