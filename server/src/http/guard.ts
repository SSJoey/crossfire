import { type IncomingMessage, Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { isLoopbackAddress, matchmakeGate, ReservationLimiter } from '@crossfire/shared/rules/validation';
import { JOIN_ERRORS } from '@crossfire/shared/types';

/**
 * Headers Colyseus prefers over the real socket address when it resolves a client's IP.
 * Crossfire has no proxy in front of it, so a client that sends one is forging it (audit 1, F1).
 */
export const FORGEABLE_IP_HEADERS = ['x-real-ip', 'x-forwarded-for', 'x-client-ip'] as const;

/** Exactly POST /matchmake/<method>/<room>, the only shape the SDK sends. */
const MATCHMAKE = /^\/matchmake\/([^/]+)\/[^/]+$/;

/** http.Server's own emit, without its per-event overloads. */
const baseEmit = Server.prototype.emit as (
  this: Server,
  event: string | symbol,
  ...args: unknown[]
) => boolean;

export interface GuardOptions {
  /** Tests only: treat every caller as a LAN laptop, even over loopback. Never in production. */
  lanClients?: boolean;
}

/**
 * The game's HTTP server, guarding the LAN boundary before Colyseus or Express sees a request:
 * forged IP headers are removed from every request and WebSocket upgrade, and the matchmaking
 * route only takes what the game needs (audit 1, F1 and F2).
 */
export class GuardedServer extends Server {
  private readonly lanClients: boolean;
  private readonly reservations = new ReservationLimiter();

  constructor(opts: GuardOptions = {}) {
    super();
    this.lanClients = opts.lanClients === true;
  }

  override emit(event: string | symbol, ...args: unknown[]): boolean {
    if (event === 'upgrade') {
      stripForgedIp(args[0] as IncomingMessage);
    } else if (event === 'request') {
      const req = args[0] as IncomingMessage;
      stripForgedIp(req);
      if (!this.admit(req, args[1] as ServerResponse)) return true;
    }
    return baseEmit.call(this, event, ...args);
  }

  /** False when the request was refused (and answered here). */
  private admit(req: IncomingMessage, res: ServerResponse): boolean {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return true;
    // The game's only write route is the matchmaking POST, so nothing else gets a body in.
    if (req.method !== 'POST') return refuse(req, res, 405, JOIN_ERRORS.notAllowed);
    const m = MATCHMAKE.exec((req.url ?? '').split('?')[0]!);
    if (!m) return refuse(req, res, 404, JOIN_ERRORS.notAllowed);
    const ip = req.socket.remoteAddress ?? '';
    const loopback = !this.lanClients && isLoopbackAddress(ip);
    const verdict = matchmakeGate({
      method: m[1]!,
      contentLength: req.headers['content-length'],
      chunked: req.headers['transfer-encoding'] !== undefined,
      loopback,
    });
    if (!verdict.ok) return refuse(req, res, verdict.status, verdict.error);
    if (m[1] === 'joinById' && !loopback && !this.reservations.allow(ip, performance.now()))
      return refuse(req, res, 429, JOIN_ERRORS.tooManyJoins);
    return true;
  }
}

/** Removes every header in FORGEABLE_IP_HEADERS (Node keeps the parsed headers object). */
function stripForgedIp(req: IncomingMessage): void {
  delete req.headers['x-real-ip'];
  delete req.headers['x-forwarded-for'];
  delete req.headers['x-client-ip'];
}

/** Answers like Colyseus' own matchmaking errors ({ code, error }), without reading the body. */
function refuse(req: IncomingMessage, res: ServerResponse, status: number, error: string): false {
  const body = JSON.stringify({ code: status, error });
  res.writeHead(status, {
    // Same as Colyseus' matchmaking replies, so the dev client (Vite, another port) can read it.
    'access-control-allow-origin': req.headers.origin ?? '*',
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    connection: 'close',
  });
  res.end(body);
  // Don't drain an oversized or endless body: drop the connection once the reply is out.
  res.on('finish', () => (req.socket as Duplex).destroy());
  return false;
}
