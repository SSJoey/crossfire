import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { logFileName, logLine, type LogEvent } from './format';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
/** Default log folder: `logs/` at the repo root. */
export const DEFAULT_LOG_DIR = resolve(REPO_ROOT, 'logs');

/** `LOG_DIR` overrides the folder (Docker, tests); a relative path is taken from the repo root. */
export function logDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.LOG_DIR && env.LOG_DIR.length > 0 ? resolve(REPO_ROOT, env.LOG_DIR) : DEFAULT_LOG_DIR;
}

/**
 * The JSON Lines log of one run. Writing is buffered by the stream, so the game loop never
 * waits on the disk. A failing disk is reported once on the console and never stops the game.
 */
export class MatchLog {
  readonly path: string;
  private stream: WriteStream | null = null;
  private failed = false;
  private closed = false;

  constructor(
    dir: string,
    code: string,
    start: Date,
    private readonly startMs: number,
  ) {
    this.path = join(dir, logFileName(start, code));
    try {
      mkdirSync(dir, { recursive: true });
      this.stream = createWriteStream(this.path, { flags: 'a', encoding: 'utf8' });
      this.stream.on('error', (e) => this.fail(e));
    } catch (e) {
      this.fail(e);
    }
  }

  write(nowMs: number, event: LogEvent): void {
    if (this.closed || this.failed || !this.stream) return;
    this.stream.write(logLine(nowMs - this.startMs, event));
  }

  /** Flushes and closes the file. Safe to call more than once. */
  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    const s = this.stream;
    this.stream = null;
    if (!s || s.destroyed) return Promise.resolve();
    return new Promise((done) => {
      s.once('error', () => done());
      s.end(() => done());
    });
  }

  private fail(e: unknown): void {
    if (this.failed) return;
    this.failed = true;
    console.error(`Match log disabled, cannot write ${this.path}: ${(e as Error)?.message ?? e}`);
  }
}
