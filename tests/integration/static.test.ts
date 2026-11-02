import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NetworkInterfaceInfo } from 'node:os';
import { boot, type ColyseusTestServer } from '@colyseus/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../server/src/app';
import { lanAddresses } from '../../server/src/lan';

const BASE = 'http://localhost:2568';

function iface(address: string, family: 'IPv4' | 'IPv6' = 'IPv4', internal = false): NetworkInterfaceInfo {
  return {
    address,
    family,
    internal,
    netmask: '255.255.255.0',
    mac: '00:00:00:00:00:00',
    cidr: null,
    ...(family === 'IPv6' ? { scopeid: 0 } : {}),
  } as NetworkInterfaceInfo;
}

describe('LAN address list', () => {
  it('keeps private IPv4 addresses only, home Wi-Fi ranges first', () => {
    const list = lanAddresses(
      {
        lo: [iface('127.0.0.1', 'IPv4', true)],
        docker0: [iface('172.17.0.1')],
        wlp0s20f3: [iface('192.168.1.23'), iface('fe80::1', 'IPv6')],
        vpn: [iface('10.8.0.2')],
        weird: [iface('8.8.8.8')],
      },
      {},
    );
    expect(list).toEqual(['192.168.1.23', '10.8.0.2', '172.17.0.1']);
  });

  it('LAN_HOST overrides the detected list', () => {
    expect(lanAddresses({ wlan: [iface('192.168.1.23')] }, { LAN_HOST: '192.168.50.5' })).toEqual([
      '192.168.50.5',
    ]);
  });
});

describe('static client and HTTP routes', () => {
  let colyseus: ColyseusTestServer;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crossfire-client-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Crossfire test build</title>');
    writeFileSync(join(dir, 'app.js'), 'console.log(1)');
    colyseus = await boot(createApp({ testRooms: true, clientDir: dir }));
  });

  afterAll(async () => {
    await colyseus.shutdown();
  });

  it('serves the client at / and the same page at /host', async () => {
    for (const path of ['/', '/host']) {
      const res = await fetch(BASE + path);
      expect(res.status, path).toBe(200);
      expect(await res.text(), path).toContain('Crossfire test build');
    }
  });

  it('serves built files', async () => {
    const res = await fetch(`${BASE}/app.js`);
    expect(res.status).toBe(200);
  });

  it('lists LAN addresses as JSON', async () => {
    const res = await fetch(`${BASE}/api/lan`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { addresses: unknown };
    expect(Array.isArray(body.addresses)).toBe(true);
    for (const a of body.addresses as string[]) expect(a).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  });

  it('unknown paths are 404, not the page', async () => {
    const res = await fetch(`${BASE}/nope/nothing.txt`);
    expect(res.status).toBe(404);
  });
});
