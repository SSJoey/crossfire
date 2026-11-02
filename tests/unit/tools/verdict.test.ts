import { describe, expect, it } from 'vitest';
import { verdict, type LogRecord } from '../../../tools/load/verdict';

interface RunShape {
  minutes?: number;
  cap?: number;
  heap?: (sec: number) => number;
  rss?: (sec: number) => number;
  enemies?: (sec: number) => number;
  tickP95?: number;
  patchP95?: number;
  end?: boolean;
}

/** A synthetic load-test log: start, a perf line every 10 s, end. */
function run(shape: RunShape = {}): LogRecord[] {
  const minutes = shape.minutes ?? 15;
  const cap = shape.cap ?? 120;
  const lines: LogRecord[] = [{ t: 0, ev: 'start', players: ['Bot 1', 'Bot 2'] }];
  for (let sec = 10; sec <= minutes * 60; sec += 10) {
    lines.push({
      t: sec * 1000,
      ev: 'perf',
      tickP95Ms: 2,
      tickMaxMs: 4,
      heapMB: shape.heap ? shape.heap(sec) : 60,
      rssMB: shape.rss ? shape.rss(sec) : 180,
      enemies: shape.enemies ? shape.enemies(sec) : cap,
      bolts: 20,
      players: 2,
      kBpsAvg: 12,
      kBpsMax: 14,
      kBps: { 'Bot 1': 12, 'Bot 2': 14 },
    });
  }
  if (shape.end !== false)
    lines.push({
      t: minutes * 60_000,
      ev: 'end',
      reason: 'aborted',
      wave: 1,
      durationSec: minutes * 60,
      kills: 900,
      tickP95Ms: shape.tickP95 ?? 2.5,
      tickMaxMs: 6,
      patchP95Ms: shape.patchP95 ?? 1,
    });
  return lines;
}

const OPTS = { cap: 120, bots: 2, botsConnected: 2 };

function check(r: ReturnType<typeof verdict>, name: string) {
  const c = r.checks.find((x) => x.name === name);
  if (!c) throw new Error(`no check ${name}`);
  return c;
}

describe('load-test verdict', () => {
  it('passes a healthy 15-minute run and reports bandwidth', () => {
    const r = verdict(run(), OPTS);
    expect(r.pass).toBe(true);
    for (const c of r.checks) expect(c.pass).toBe(true);
    expect(r.bandwidth).toEqual({ avgKBps: 12, maxKBps: 14 });
  });

  it('fails when the whole-run tick p95 is above 10 ms', () => {
    const r = verdict(run({ tickP95: 10.5, patchP95: 0 }), OPTS);
    expect(r.pass).toBe(false);
    expect(check(r, 'tick').pass).toBe(false);
    expect(verdict(run({ tickP95: 10, patchP95: 0 }), OPTS).pass).toBe(true);
  });

  it('the budget covers the sim tick and the state patch together', () => {
    expect(verdict(run({ tickP95: 6, patchP95: 4 }), OPTS).pass).toBe(true);
    const r = verdict(run({ tickP95: 6, patchP95: 4.5 }), OPTS);
    expect(check(r, 'tick').pass).toBe(false);
  });

  it('fails on steady heap growth', () => {
    const r = verdict(run({ heap: (s) => 60 + s * 0.05 }), OPTS);
    expect(check(r, 'memory').pass).toBe(false);
    expect(r.pass).toBe(false);
  });

  it('fails on steady RSS growth', () => {
    const r = verdict(run({ rss: (s) => 180 + s * 0.1 }), OPTS);
    expect(check(r, 'memory').pass).toBe(false);
  });

  it('allows 10% + 5 MB above the early median', () => {
    // Early median 60 MB, late median 70 MB: limit is 60 * 1.1 + 5 = 71.
    const r = verdict(run({ heap: (s) => (s < 600 ? 60 : 70) }), OPTS);
    expect(check(r, 'memory').pass).toBe(true);
  });

  it('ignores the first two minutes (warm-up) for memory and load', () => {
    const r = verdict(run({ heap: (s) => (s < 120 ? 400 : 60), enemies: (s) => (s < 120 ? 10 : 120) }), OPTS);
    expect(r.pass).toBe(true);
  });

  it('fails when the field was not kept near the cap', () => {
    const r = verdict(run({ enemies: (s) => (s % 20 === 0 ? 120 : 80) }), OPTS);
    expect(check(r, 'load').pass).toBe(false);
  });

  it('fails when a bot dropped out', () => {
    const r = verdict(run(), { ...OPTS, botsConnected: 1 });
    expect(check(r, 'bots').pass).toBe(false);
    expect(r.pass).toBe(false);
  });

  it('fails when the log has no end line', () => {
    expect(verdict(run({ end: false }), OPTS).pass).toBe(false);
  });

  it('a run too short for the memory windows marks memory as not measured, not failed', () => {
    const r = verdict(run({ minutes: 1 }), { ...OPTS, warmupSec: 15 });
    expect(check(r, 'memory').pass).toBeNull();
    expect(r.pass).toBe(true);
  });
});
