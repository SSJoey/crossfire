// Load test: npm run load-test -- [--minutes 15] [--bots 8] [--cap 120] [--url http://127.0.0.1:2567 --log-dir logs]
//
// Starts a server with the test-only load room (unless --url is given), fills it with bots,
// runs for the given time, then judges the run's match log against the performance budget.
// With --bots 7 a person can take the 8th slot in a browser and read the ?fps=1 overlay.
import { spawn, type ChildProcess } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Client } from '@colyseus/sdk';
import { TUNING } from '@crossfire/shared/tuning';
import { LOAD_ROOM_NAME, MSG } from '@crossfire/shared/types';
import type { RoomState } from '../client/src/net/state';
import { Bot } from '../server/src/bots/bot';
import { verdict, type LogRecord } from './load/verdict';

const ROOT = resolve(import.meta.dirname, '..');
const { values } = parseArgs({
  options: {
    minutes: { type: 'string', default: '15' },
    bots: { type: 'string', default: '8' },
    cap: { type: 'string', default: String(TUNING.waves.enemyCap) },
    port: { type: 'string', default: '2597' },
    url: { type: 'string' },
    'log-dir': { type: 'string' },
  },
});

const minutes = Number(values.minutes);
const botCount = Math.max(1, Math.min(TUNING.lobby.maxPlayers, Math.floor(Number(values.bots))));
const cap = Math.max(1, Math.min(TUNING.waves.enemyCap, Math.floor(Number(values.cap))));
if (!(minutes > 0) || !Number.isFinite(botCount) || !Number.isFinite(cap)) {
  console.error('Usage: npm run load-test -- [--minutes 15] [--bots 8] [--cap 120]');
  process.exit(2);
}
const port = Number(values.port);
const url = values.url ?? `http://127.0.0.1:${port}`;
const logDir = resolve(ROOT, values['log-dir'] ?? (values.url ? 'logs' : 'logs/load'));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean | Promise<boolean>, ms: number, label: string): Promise<void> {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error(`Timed out waiting for ${label}`);
    await sleep(200);
  }
}

let server: ChildProcess | null = null;
function startServer(): ChildProcess {
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/src/index.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      BIND_HOST: '127.0.0.1',
      CROSSFIRE_LOAD_ROOM: '1',
      LOG_DIR: logDir,
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  child.on('exit', (code) => {
    if (code !== null && code !== 0) console.error(`Server exited with code ${code}`);
  });
  return child;
}

function newestLogFor(code: string): string | null {
  const files = readdirSync(logDir)
    .filter((f) => f.endsWith(`_${code}.jsonl`))
    .map((f) => join(logDir, f));
  files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return files[0] ?? null;
}

function readLog(path: string): LogRecord[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as LogRecord);
}

const bots: Bot[] = [];
let exitCode = 1;
try {
  if (!values.url) {
    server = startServer();
    await waitFor(
      () =>
        fetch(`${url}/api/lan`).then(
          (r) => r.ok,
          () => false,
        ),
      30_000,
      'the server',
    );
  }

  const sdk = new Client(url);
  const host = await sdk.create(LOAD_ROOM_NAME, { role: 'host', enemyCap: cap });
  const code = host.roomId;
  const state = () => host.state as unknown as RoomState;
  console.log(`Load room ${code}: ${botCount} bots, enemy cap ${cap}, ${minutes} min. Logs in ${logDir}`);

  for (let i = 1; i <= botCount; i++) {
    const bot = new Bot(sdk, code, `Bot ${i}`, i);
    await bot.start();
    bots.push(bot);
  }
  if (botCount < TUNING.lobby.maxPlayers)
    console.log(
      `Join in a browser and press Ready: ${url.replace('127.0.0.1', 'localhost')}/?code=${code}&fps=1`,
    );
  await waitFor(
    () => {
      let all = state().players.size > 0;
      state().players.forEach((p) => (all &&= p.ready));
      return all;
    },
    10 * 60_000,
    'everyone ready',
  );
  host.send(MSG.start, {});
  await waitFor(() => state().phase === 'running', 10_000, 'the run to start');

  const t0 = Date.now();
  const endAt = t0 + minutes * 60_000;
  let nextReport = t0;
  while (Date.now() < endAt) {
    if (Date.now() >= nextReport) {
      const s = state();
      const min = ((Date.now() - t0) / 60_000).toFixed(1);
      const live = bots.filter((b) => b.connected).length;
      console.log(`${min} min: ${s.enemies.size} enemies, ${s.bolts.size} bolts, ${live}/${botCount} bots`);
      nextReport += 30_000;
    }
    if (state().phase !== 'running') throw new Error(`The run left 'running' (phase ${state().phase})`);
    await sleep(1000);
  }

  const botsConnected = bots.filter((b) => b.connected).length;
  host.send(MSG.restart, {});
  await waitFor(() => state().phase === 'lobby', 10_000, 'the run to end');
  await sleep(500);

  const file = newestLogFor(code);
  if (!file) throw new Error(`No match log for ${code} in ${logDir}`);
  const result = verdict(readLog(file), {
    cap,
    bots: botCount,
    botsConnected,
    warmupSec: Math.min(TUNING.loadTest.warmupSec, minutes * 60 * 0.25),
  });

  console.log(`\nMatch log: ${file}`);
  for (const c of result.checks) {
    const mark = c.pass === null ? 'n/a ' : c.pass ? 'PASS' : 'FAIL';
    console.log(`  ${mark}  ${c.name.padEnd(6)} ${c.detail}`);
  }
  console.log(
    `  info  bandwidth per client: avg ${result.bandwidth.avgKBps} kB/s, max ${result.bandwidth.maxKBps} kB/s`,
  );
  console.log(result.pass ? '\nLoad test PASSED' : '\nLoad test FAILED');
  exitCode = result.pass ? 0 : 1;
  await host.leave().catch(() => undefined);
} catch (e) {
  console.error(`Load test error: ${(e as Error).message}`);
} finally {
  await Promise.all(bots.map((b) => b.stop()));
  server?.kill('SIGTERM');
}
process.exit(exitCode);
