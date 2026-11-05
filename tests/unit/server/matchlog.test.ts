import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logFileName, logLine } from '../../../server/src/log/format';
import { DEFAULT_LOG_DIR, logDir, MatchLog } from '../../../server/src/log/MatchLog';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'crossfire-log-'));
}

function readLines(path: string): Record<string, unknown>[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('log format', () => {
  it('one JSON object per line with t and ev first', () => {
    const line = logLine(1234.6, { ev: 'waveStarted', wave: 3 });
    expect(line.endsWith('\n')).toBe(true);
    expect(line.indexOf('\n')).toBe(line.length - 1);
    expect(JSON.parse(line)).toEqual({ t: 1235, ev: 'waveStarted', wave: 3 });
    expect(Object.keys(JSON.parse(line) as object).slice(0, 2)).toEqual(['t', 'ev']);
  });

  it('start line lists the bots; perf line carries client reports by name, one line each', () => {
    const start = logLine(0, {
      ev: 'start',
      at: '2026-11-03T10:00:00.000Z',
      code: 'ABCD',
      seed: 1,
      players: ['Ann', 'Bot 1'],
      bots: ['Bot 1'],
    });
    expect(JSON.parse(start)).toMatchObject({ players: ['Ann', 'Bot 1'], bots: ['Bot 1'] });
    const perf = logLine(10000, {
      ev: 'perf',
      tickP95Ms: 1,
      tickMaxMs: 2,
      patchP95Ms: 1,
      ticks: 200,
      heapMB: 20,
      rssMB: 100,
      enemies: 40,
      bolts: 10,
      players: 2,
      kBpsAvg: 10,
      kBpsMax: 12,
      kBps: { 'An\nn': 10, 'Bot 1': 12 },
      clients: { 'An\nn': { tier: 'low', fps: 59.9, low1: 48, w: 1920, h: 1080, dpr: 1 } },
    });
    expect(perf.indexOf('\n')).toBe(perf.length - 1);
    expect((JSON.parse(perf) as { clients: Record<string, unknown> }).clients['An\nn']).toEqual({
      tier: 'low',
      fps: 59.9,
      low1: 48,
      w: 1920,
      h: 1080,
      dpr: 1,
    });
  });

  it('file name: ISO start time without colons, then the room code', () => {
    const name = logFileName(new Date('2026-11-02T20:15:03.123Z'), 'ABCD');
    expect(name).toBe('2026-11-02T20-15-03.123Z_ABCD.jsonl');
  });

  it('refuses a room code that is not 4 code letters (no path tricks)', () => {
    expect(() => logFileName(new Date(), '../x')).toThrow();
    expect(() => logFileName(new Date(), 'ABIO')).toThrow();
  });

  it.each([
    ['quotes and backslash', 'a"b\\c'],
    ['HTML', '<img src=x onerror'],
    ['emoji', '🔥 Ember 👍🏽'],
    ['right-to-left', 'שלום עולם'],
  ])('names with %s stay one valid line with the text unchanged', (_label, name) => {
    const line = logLine(0, { ev: 'downed', name });
    expect(line.split('\n')).toHaveLength(2);
    expect((JSON.parse(line) as { name: string }).name).toBe(name);
  });
});

describe('log folder', () => {
  it('defaults to logs/ at the repo root; LOG_DIR overrides it, relative to the repo root', () => {
    const root = join(import.meta.dirname, '../../..');
    expect(DEFAULT_LOG_DIR).toBe(join(root, 'logs'));
    expect(logDir({})).toBe(DEFAULT_LOG_DIR);
    expect(logDir({ LOG_DIR: '' })).toBe(DEFAULT_LOG_DIR);
    expect(logDir({ LOG_DIR: '/app/logs' })).toBe('/app/logs');
    expect(logDir({ LOG_DIR: 'logs/load' })).toBe(join(root, 'logs/load'));
  });
});

describe('MatchLog', () => {
  it('writes one file per run in the log folder', async () => {
    const dir = tempDir();
    const start = new Date('2026-11-02T20:15:03.000Z');
    const log = new MatchLog(dir, 'ABCD', start, 1000);
    log.write(1000, {
      ev: 'start',
      at: start.toISOString(),
      code: 'ABCD',
      seed: 7,
      players: ['Ann', 'Bo'],
      bots: [],
    });
    log.write(1500, { ev: 'waveStarted', wave: 1 });
    log.write(9000, {
      ev: 'end',
      reason: 'wiped',
      wave: 1,
      durationSec: 8,
      kills: 3,
      tickP95Ms: 1.2,
      tickMaxMs: 2,
      patchP95Ms: 0.4,
    });
    await log.close();

    expect(readdirSync(dir)).toEqual(['2026-11-02T20-15-03.000Z_ABCD.jsonl']);
    const lines = readLines(log.path);
    expect(lines.map((l) => l.ev)).toEqual(['start', 'waveStarted', 'end']);
    expect(lines.map((l) => l.t)).toEqual([0, 500, 8000]);
    expect(lines[0]!.players).toEqual(['Ann', 'Bo']);
    expect(lines[2]!.reason).toBe('wiped');
  });

  it('creates the log folder if it is missing', async () => {
    const dir = join(tempDir(), 'nested', 'logs');
    const log = new MatchLog(dir, 'WXYZ', new Date(), 0);
    log.write(0, { ev: 'waveStarted', wave: 1 });
    await log.close();
    expect(readLines(log.path)).toHaveLength(1);
  });

  it('ignores writes after close', async () => {
    const log = new MatchLog(tempDir(), 'ABCD', new Date(), 0);
    log.write(0, { ev: 'waveStarted', wave: 1 });
    await log.close();
    log.write(10, { ev: 'waveStarted', wave: 2 });
    await log.close();
    expect(readLines(log.path)).toHaveLength(1);
  });

  it('a folder it cannot write to never throws, and the error is reported once', async () => {
    const blocker = join(tempDir(), 'a-file');
    writeFileSync(blocker, 'x');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = new MatchLog(join(blocker, 'logs'), 'ABCD', new Date(), 0);
    expect(() => {
      for (let i = 0; i < 5; i++) log.write(i, { ev: 'waveStarted', wave: i });
    }).not.toThrow();
    await expect(log.close()).resolves.toBeUndefined();
    expect(err).toHaveBeenCalledTimes(1);
  });
});
