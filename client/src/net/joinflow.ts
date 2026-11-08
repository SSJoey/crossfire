import { TUNING } from '@crossfire/shared/tuning';
import { CLOSE, JOIN_ERRORS, ROOM_CODE_LETTERS } from '@crossfire/shared/types';

export const UNREACHABLE_MESSAGE =
  "Can't reach the host. Check that you're on the same Wi-Fi as the host laptop and that the code is right.";

export type JoinFailureKind =
  'full' | 'inProgress' | 'emptyName' | 'notHost' | 'oneSeat' | 'kicked' | 'unreachable' | 'unknown';

export interface JoinFailure {
  kind: JoinFailureKind;
  message: string;
  /** Retry after this many ms, or null to wait for the player. */
  retryMs: number | null;
}

const CODE_RE = new RegExp(`^[${ROOM_CODE_LETTERS}]{4}$`);

/** Room code from the join link (`?code=ABCD`), or null if missing or malformed. */
export function parseRoomCode(search: string): string | null {
  return normaliseRoomCode(new URLSearchParams(search).get('code') ?? '');
}

export function normaliseRoomCode(raw: string): string | null {
  const code = raw.trim().toUpperCase();
  return CODE_RE.test(code) ? code : null;
}

/** Colyseus error codes meaning "no such room" (wrong or expired code). */
const NO_ROOM_CODES = new Set([522, 524]);

/** Turns whatever the SDK threw into something to show the player. */
export function classifyJoinError(err: unknown): JoinFailure {
  const message = err instanceof Error ? err.message : '';
  const code =
    typeof err === 'object' && err !== null && typeof (err as { code?: unknown }).code === 'number'
      ? (err as { code: number }).code
      : undefined;
  const retry = TUNING.client.joinRetryMs;

  if (message === JOIN_ERRORS.full) return { kind: 'full', message, retryMs: null };
  if (message === JOIN_ERRORS.inProgress) return { kind: 'inProgress', message, retryMs: retry };
  if (message === JOIN_ERRORS.emptyName) return { kind: 'emptyName', message, retryMs: null };
  if (message === JOIN_ERRORS.notHost) return { kind: 'notHost', message, retryMs: null };
  if (message === JOIN_ERRORS.oneSeat) return { kind: 'oneSeat', message, retryMs: null };
  if (message === JOIN_ERRORS.kickedWait) return { kind: 'kicked', message, retryMs: null };
  if (code === undefined || code === 0 || NO_ROOM_CODES.has(code)) {
    return { kind: 'unreachable', message: UNREACHABLE_MESSAGE, retryMs: retry };
  }
  return { kind: 'unknown', message: message || `Join failed (${code}).`, retryMs: null };
}

/** What to tell a player whose connection closed, or null for a normal leave. */
export function closeMessage(code: number): string | null {
  if (code === CLOSE.kicked) return 'The host removed you from the game.';
  if (code === CLOSE.flood) return 'Disconnected: your browser sent too many messages.';
  if (code === 4000 || code === 1000) return null;
  return 'Lost the connection to the host.';
}
