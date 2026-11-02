import { TUNING } from '@crossfire/shared/tuning';

/** One parsed line of a match log. */
export type LogRecord = Record<string, unknown> & { t: number; ev: string };

export interface VerdictOptions {
  /** Enemy cap the load room was asked to hold. */
  cap: number;
  bots: number;
  /** Bots still connected when the run ended. */
  botsConnected: number;
  /** Override the warm-up for short runs (s). */
  warmupSec?: number;
}

export interface Check {
  name: 'log' | 'tick' | 'memory' | 'load' | 'bots';
  /** null = not measured (the run was too short). */
  pass: boolean | null;
  detail: string;
}

export interface Verdict {
  pass: boolean;
  checks: Check[];
  bandwidth: { avgKBps: number; maxKBps: number };
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

const r1 = (v: number) => Math.round(v * 10) / 10;

/** Judges a load-test match log against the performance budget in BRIEF.md. */
export function verdict(lines: LogRecord[], opts: VerdictOptions): Verdict {
  const b = TUNING.loadTest;
  const warmupMs = (opts.warmupSec ?? b.warmupSec) * 1000;
  const checks: Check[] = [];
  const end = lines.find((l) => l.ev === 'end');
  const perf = lines.filter((l) => l.ev === 'perf');
  const steady = perf.filter((l) => l.t >= warmupMs);

  checks.push({
    name: 'log',
    pass: !!end && perf.length > 0,
    detail: end ? `${perf.length} perf samples, end reason ${String(end.reason)}` : 'no end line in the log',
  });

  // Tick: sim tick + state patch, whole-run 95th percentile.
  const tick = num(end?.tickP95Ms) + num(end?.patchP95Ms);
  checks.push({
    name: 'tick',
    pass: !!end && tick <= b.tickBudgetMs,
    detail: `p95 tick ${num(end?.tickP95Ms)} ms + patch ${num(end?.patchP95Ms)} ms = ${r1(tick)} ms (budget ${b.tickBudgetMs})`,
  });

  // Memory: late median vs early median, heap and RSS.
  const lastT = perf.at(-1)?.t ?? 0;
  const lateFrom = lastT - b.lateSec * 1000;
  const early = perf.filter((l) => l.t >= warmupMs && l.t <= b.earlyEndSec * 1000);
  const late = perf.filter((l) => l.t > lateFrom);
  if (lateFrom < b.earlyEndSec * 1000 || early.length === 0 || late.length === 0) {
    checks.push({ name: 'memory', pass: null, detail: 'run too short to judge memory growth' });
  } else {
    const parts: string[] = [];
    let ok = true;
    for (const key of ['heapMB', 'rssMB'] as const) {
      const e = median(early.map((l) => num(l[key])));
      const lt = median(late.map((l) => num(l[key])));
      const limit = e * b.memoryGrowthFactor + b.memorySlackMB;
      if (lt > limit) ok = false;
      parts.push(`${key} ${r1(e)} → ${r1(lt)} (limit ${r1(limit)})`);
    }
    checks.push({ name: 'memory', pass: ok, detail: parts.join(', ') });
  }

  // Load held: the field stayed near the cap.
  const full = steady.filter((l) => num(l.enemies) >= opts.cap * b.loadShare).length;
  const share = steady.length > 0 ? full / steady.length : 0;
  checks.push({
    name: 'load',
    pass: steady.length > 0 && share >= b.loadSampleShare,
    detail: `${Math.round(share * 100)}% of samples had ≥ ${Math.ceil(opts.cap * b.loadShare)} enemies`,
  });

  checks.push({
    name: 'bots',
    pass: opts.botsConnected === opts.bots,
    detail: `${opts.botsConnected} of ${opts.bots} bots connected at the end`,
  });

  const bw = steady.length > 0 ? steady : perf;
  const bandwidth = {
    avgKBps: r1(bw.reduce((s, l) => s + num(l.kBpsAvg), 0) / Math.max(1, bw.length)),
    maxKBps: r1(bw.reduce((m, l) => Math.max(m, num(l.kBpsMax)), 0)),
  };

  return { pass: checks.every((c) => c.pass !== false), checks, bandwidth };
}
