import { createApp } from './app';

/** LAN only: bind to the address in BIND_HOST (default all interfaces of this machine). */
const port = Number(process.env.PORT ?? 2567);
const host = process.env.BIND_HOST ?? '0.0.0.0';

// The test-only load room exists only when this is set (tools/load-test.ts sets it).
const loadRooms = process.env.CROSSFIRE_LOAD_ROOM === '1';
if (loadRooms)
  console.warn('CROSSFIRE_LOAD_ROOM=1: the test-only load room is enabled. Not for game nights.');

// Host-added bots connect back to this server over loopback (or the bind address, if specific).
const botHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
const botUrl = `http://${botHost.includes(':') ? `[${botHost}]` : botHost}:${port}`;

const server = createApp({ loadRooms, botUrl });
await server.listen(port, host);
console.log(`Crossfire server listening on ${host}:${port}`);
