import { type ChildProcess, fork } from 'node:child_process';
import { resolve } from 'node:path';
import type { FromBotProcess, ToBotProcess } from './ipc';

const ENTRY = resolve(import.meta.dirname, 'process.ts');
/** Where `--import tsx` is resolved from (the server package; tsx is one of its dependencies). */
const SERVER_DIR = resolve(import.meta.dirname, '../..');

/**
 * Owns one room's bot process. It starts the process on the first bot and stops it on request.
 * Bot CPU and memory stay out of the game server process (and its perf numbers).
 */
export class BotSupervisor {
  private child: ChildProcess | null = null;

  constructor(private readonly onFailed: (name: string, error: string) => void = () => undefined) {}

  /** The bot process id while it runs. */
  get pid(): number | undefined {
    return this.child?.pid;
  }

  add(msg: Omit<Extract<ToBotProcess, { type: 'add' }>, 'type'>): void {
    const child = (this.child ??= this.start());
    child.send({ type: 'add', ...msg } satisfies ToBotProcess);
  }

  /** Stops the bot process (its bots leave the room as it exits). */
  stop(): void {
    const child = this.child;
    if (!child) return;
    this.child = null;
    if (child.connected) child.send({ type: 'stop' } satisfies ToBotProcess);
    // If it does not exit by itself soon, kill it.
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
    timer.unref();
    child.once('exit', () => clearTimeout(timer));
  }

  private start(): ChildProcess {
    const child = fork(ENTRY, [], {
      cwd: SERVER_DIR,
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      serialization: 'json',
    });
    child.on('message', (raw: unknown) => {
      const m = raw as FromBotProcess;
      if (m.type === 'failed') this.onFailed(m.name, m.error);
    });
    child.on('exit', () => {
      if (this.child === child) this.child = null;
    });
    child.on('error', (e) => console.error('Bot process error:', e.message));
    return child;
  }
}
