import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
