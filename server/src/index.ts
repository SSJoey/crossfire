import { createApp } from './app';

/** LAN only: bind to the address in BIND_HOST (default all interfaces of this machine). */
const port = Number(process.env.PORT ?? 2567);
const host = process.env.BIND_HOST ?? '0.0.0.0';

const server = createApp();
await server.listen(port, host);
console.log(`Crossfire server listening on ${host}:${port}`);
