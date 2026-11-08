/**
 * Audit 1, F5 (low): U+2028 / U+2029 (line and paragraph separators) and U+0085 (next line)
 * survived name cleaning and were written raw into match-log names, so a reader that splits on
 * Unicode line breaks saw forged extra lines.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ColyseusTestServer } from '@colyseus/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sanitizeName } from '@crossfire/shared/rules/validation';
import { bootServer, startRun, until } from '../integration/helpers';

describe('audit 1 F5: line separators are stripped from names', () => {
  it('U+2028, U+2029 and U+0085 are removed', () => {
    expect(sanitizeName('a\u2028b\u2029c\u0085d')).toEqual({ ok: true, name: 'abcd' });
  });

  it('a name made only of separators is refused', () => {
    expect(sanitizeName('\u2028\u2029\u0085')).toEqual({ ok: false });
  });

  it('only the plain space survives among separator characters', () => {
    const r = sanitizeName('a b\u2028c\u2029d\u00a0e');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.name.replace(/ /g, '')).not.toMatch(/[\p{Zl}\p{Zp}]/u);
  });
});

describe('audit 1 F5: the match log', () => {
  let colyseus: ColyseusTestServer;
  let dir: string;
  let prevDir: string | undefined;

  beforeAll(async () => {
    prevDir = process.env.LOG_DIR;
    dir = mkdtempSync(join(tmpdir(), 'crossfire-names-'));
    process.env.LOG_DIR = dir;
    colyseus = await bootServer();
  });
  afterAll(async () => {
    await colyseus.shutdown();
    if (prevDir === undefined) delete process.env.LOG_DIR;
    else process.env.LOG_DIR = prevDir;
  });

  it('a name with separators never puts one into a log line', async () => {
    const { code } = await startRun(colyseus, ['Eve\u2028{"ev":"x"}']);
    const file = () =>
      existsSync(dir) ? readdirSync(dir).find((f) => f.endsWith(`_${code}.jsonl`)) : undefined;
    await until(() => file() !== undefined, 3000, 'log file');
    const text = readFileSync(join(dir, file()!), 'utf8');
    expect(text).not.toMatch(/[\u2028\u2029\u0085]/);
    expect(text).toContain('Eve{\\"ev\\":\\"x\\"}');
  });
});
