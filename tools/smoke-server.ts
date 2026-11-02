// Manual check (slice 1a.1): run the server with PORT=2599, then `npx tsx tools/smoke-server.ts`.
// lobby -> running -> ended with two SDK clients against a real server.
import { Client } from '@colyseus/sdk';

const url = process.env.URL ?? 'http://127.0.0.1:2599';
const c = new Client(url);
const host = await c.create('hold', { role: 'host' });
console.log('room code', host.roomId);
const a = await c.joinById(host.roomId, { name: 'Alice' });
const b = await c.joinById(host.roomId, { name: 'Bob' });
const phases: string[] = [];
host.onStateChange((s: { phase: string }) => {
  if (phases.at(-1) !== s.phase) phases.push(s.phase);
});
a.onMessage('ended', (m) => console.log('ended message', JSON.stringify(m)));
a.send('ready', { ready: true });
b.send('ready', { ready: true });
await new Promise((r) => setTimeout(r, 200));
host.send('start', {});
// Both heroes walk far outside the ring so the soft-edge drain downs them, then they bleed out.
let seq = 1;
const timer = setInterval(() => {
  for (const p of [a, b])
    p.send('input', { seq, moveX: 1, moveZ: 0, aimX: 0, aimZ: 5, attack: true, revive: false });
  seq++;
}, 50);
const t0 = Date.now();
while (phases.at(-1) !== 'ended' && Date.now() - t0 < 60000) await new Promise((r) => setTimeout(r, 100));
clearInterval(timer);
const st = host.state as unknown as {
  wave: number;
  enemies: Map<string, unknown>;
  heroes: Map<string, { status: string }>;
};
console.log(
  'phases',
  phases.join(' -> '),
  'after',
  ((Date.now() - t0) / 1000).toFixed(1),
  's; wave',
  st.wave,
);
await Promise.all([a.leave(), b.leave(), host.leave()]);
process.exit(phases.at(-1) === 'ended' ? 0 : 1);
