/** Port the game server listens on during development (Vite serves the page on 5173). */
const DEV_SERVER_PORT = '2567';

/** Base URL of the game server. In production it serves this page, so it is the same origin. */
export function serverUrl(): string {
  const port = import.meta.env.DEV ? DEV_SERVER_PORT : location.port;
  return `${location.protocol}//${location.hostname}${port ? `:${port}` : ''}`;
}
