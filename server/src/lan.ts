import type { NetworkInterfaceInfo } from 'node:os';

type Interfaces = NodeJS.Dict<NetworkInterfaceInfo[]>;

/** Rank of a private IPv4 address (lower first), or -1 if it is not private. */
function privateRank(ip: string): number {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return -1;
  if (p[0] === 192 && p[1] === 168) return 0;
  if (p[0] === 10) return 1;
  if (p[0] === 172 && p[1]! >= 16 && p[1]! <= 31) return 2;
  return -1;
}

/**
 * The addresses players on the LAN can use to reach this machine: private IPv4 only,
 * home Wi-Fi ranges (192.168.x.x) first. LAN_HOST overrides detection (needed in Docker).
 */
export function lanAddresses(ifaces: Interfaces, env: NodeJS.ProcessEnv): string[] {
  const override = env.LAN_HOST?.trim();
  if (override) return [override];
  const found: { ip: string; rank: number }[] = [];
  for (const list of Object.values(ifaces)) {
    for (const i of list ?? []) {
      if (i.family !== 'IPv4' || i.internal) continue;
      const rank = privateRank(i.address);
      if (rank >= 0 && !found.some((f) => f.ip === i.address)) found.push({ ip: i.address, rank });
    }
  }
  return found.sort((a, b) => a.rank - b.rank).map((f) => f.ip);
}
