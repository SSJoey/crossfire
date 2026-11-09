import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const ROOT = resolve(import.meta.dirname, '../../..');
const read = (f: string) => readFileSync(resolve(ROOT, f), 'utf8');

interface Service {
  build?: unknown;
  network_mode?: string;
  ports?: unknown;
  volumes?: string[];
  environment?: Record<string, string>;
  read_only?: boolean;
  init?: boolean;
  security_opt?: string[];
  cap_drop?: string[];
  user?: string;
}

const compose = parse(read('docker-compose.yml')) as { services: Record<string, Service> };
const services = Object.values(compose.services);
const server = compose.services.crossfire!;
const dockerfile = read('Dockerfile');

describe('docker compose', () => {
  it('one crossfire service on the host network (keeps 127.0.0.1 for the host check)', () => {
    expect(services).toHaveLength(1);
    expect(server.network_mode).toBe('host');
  });

  it('publishes no ports (host networking, nothing forwarded)', () => {
    expect(server.ports).toBeUndefined();
  });

  it('keeps match logs on the host in ./logs', () => {
    expect(server.volumes).toContain('./logs:/app/logs');
    expect(server.environment?.LOG_DIR).toBe('/app/logs');
  });

  it('never enables the load-test room or overrides LAN detection', () => {
    expect(server.environment?.CROSSFIRE_LOAD_ROOM).toBeUndefined();
    expect(server.environment?.LAN_HOST).toBeUndefined();
    expect(dockerfile).not.toMatch(/CROSSFIRE_LOAD_ROOM/);
  });

  it('no no-new-privileges: under snap Docker AppArmor it blocks every exec in the container', () => {
    expect((server.security_opt ?? []).some((o) => o.startsWith('no-new-privileges'))).toBe(false);
  });

  it('drops all Linux capabilities (so setuid binaries cannot gain root powers)', () => {
    expect(server.cap_drop).toEqual(['ALL']);
  });

  it('runs with a read-only root filesystem', () => {
    expect(server.read_only).toBe(true);
  });
});

/**
 * Runs tools/docker-check.sh with a fake `sudo` that only allows `sudo -v` and
 * `docker compose down` and logs every call; anything after that stops the script, so no real Docker command runs.
 * The port is overridden with CHECK_PORT, so the user's own 2567 is never touched.
 */
function runCheckScript(port: number): Promise<{ code: number | null; out: string; sudo: string }> {
  const bin = mkdtempSync(join(tmpdir(), 'crossfire-sudo-'));
  const fake = join(bin, 'sudo');
  const calls = join(bin, 'calls.log');
  writeFileSync(
    fake,
    [
      '#!/usr/bin/env bash',
      'echo "$*" >> "$FAKE_SUDO_LOG"',
      'case "$*" in',
      '  "-v"|"docker compose down") exit 0 ;;',
      '  *) kill -TERM $PPID; exit 1 ;;',
      'esac',
      '',
    ].join('\n'),
  );
  chmodSync(fake, 0o755);
  return new Promise((done) => {
    const p = spawn('bash', [resolve(ROOT, 'tools/docker-check.sh')], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        CHECK_PORT: String(port),
        FAKE_SUDO_LOG: calls,
      },
    });
    let out = '';
    p.stdout.on('data', (d: Buffer) => (out += d.toString()));
    p.stderr.on('data', (d: Buffer) => (out += d.toString()));
    p.on('close', (code) => done({ code, out, sudo: existsSync(calls) ? readFileSync(calls, 'utf8') : '' }));
  });
}

describe('docker-check.sh', () => {
  it('refuses to run when something else already listens on the port (2026-11-09)', async () => {
    const busy = createServer();
    await new Promise<void>((ok) => busy.listen(0, '0.0.0.0', ok));
    const port = (busy.address() as AddressInfo).port;
    try {
      const { code, out, sudo } = await runCheckScript(port);
      expect(out).toContain(`FAIL  port ${port} is already in use`);
      expect(sudo).not.toContain('compose up');
      expect(code).not.toBe(0);
    } finally {
      busy.close();
    }
  });

  it('goes on to start the container when the port is free', async () => {
    const probe = createServer();
    await new Promise<void>((ok) => probe.listen(0, '127.0.0.1', ok));
    const port = (probe.address() as AddressInfo).port;
    await new Promise((ok) => probe.close(ok));
    const { out, sudo } = await runCheckScript(port);
    expect(out).not.toContain('already in use');
    expect(sudo).toContain('docker compose up');
  });
});

describe('Dockerfile', () => {
  it('pins the Node image to an exact version', () => {
    const froms = [...dockerfile.matchAll(/^FROM\s+(\S+)/gm)].map((m) => m[1]!);
    expect(froms.length).toBeGreaterThanOrEqual(2);
    for (const f of froms) expect(f).toMatch(/^node:\d+\.\d+\.\d+-bookworm-slim/);
  });

  it('runs as the unprivileged node user', () => {
    const users = [...dockerfile.matchAll(/^USER\s+(\S+)/gm)].map((m) => m[1]);
    expect(users.at(-1)).toBe('node');
  });

  it('.dockerignore keeps dependencies, logs and sources out of the build context', () => {
    const ignore = read('.dockerignore')
      .split('\n')
      .map((l) => l.trim());
    for (const e of ['node_modules', 'logs', 'assets/kaykit', 'test-results', '.git'])
      expect(ignore).toContain(e);
  });
});
