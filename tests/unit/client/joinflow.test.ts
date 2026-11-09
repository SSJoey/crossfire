import { describe, expect, it } from 'vitest';
import { TUNING } from '@crossfire/shared/tuning';
import { CLOSE, JOIN_ERRORS } from '@crossfire/shared/types';
import {
  classifyJoinError,
  closeMessage,
  parseRoomCode,
  UNREACHABLE_MESSAGE,
} from '../../../client/src/net/joinflow';

/** Shape of the SDK's ServerError / MatchMakeError. */
function serverError(code: number, message: string): Error & { code: number } {
  return Object.assign(new Error(message), { code });
}

describe('room code from the link', () => {
  it('reads ?code=, upper-cased', () => {
    expect(parseRoomCode('?code=abcd')).toBe('ABCD');
    expect(parseRoomCode('?x=1&code=WXYZ')).toBe('WXYZ');
  });

  it('refuses anything that is not 4 code letters (no I or O)', () => {
    expect(parseRoomCode('')).toBeNull();
    expect(parseRoomCode('?code=ABC')).toBeNull();
    expect(parseRoomCode('?code=ABCDE')).toBeNull();
    expect(parseRoomCode('?code=ABIO')).toBeNull();
    expect(parseRoomCode('?code=AB1D')).toBeNull();
    expect(parseRoomCode('?code=<img>')).toBeNull();
  });
});

describe('join errors', () => {
  it('a full game says so and does not retry', () => {
    const f = classifyJoinError(serverError(409, JOIN_ERRORS.full));
    expect(f).toEqual({ kind: 'full', message: JOIN_ERRORS.full, retryMs: null });
  });

  it('a run in progress retries every 5 s', () => {
    const f = classifyJoinError(serverError(409, JOIN_ERRORS.inProgress));
    expect(f.kind).toBe('inProgress');
    expect(f.message).toBe(JOIN_ERRORS.inProgress);
    expect(f.retryMs).toBe(TUNING.client.joinRetryMs);
  });

  it('an empty name asks for a name and does not retry', () => {
    const f = classifyJoinError(serverError(400, JOIN_ERRORS.emptyName));
    expect(f).toEqual({ kind: 'emptyName', message: JOIN_ERRORS.emptyName, retryMs: null });
  });

  it('no host page open (or the host page refused) is shown as is', () => {
    expect(classifyJoinError(serverError(403, JOIN_ERRORS.notHost)).kind).toBe('notHost');
  });

  it('an unknown room code or a dead server reads as "can\'t reach the host" and retries', () => {
    for (const err of [
      serverError(522, 'room "ZZZZ" not found'),
      new TypeError('Failed to fetch'),
      new Error('connect ECONNREFUSED'),
      'weird',
      undefined,
    ]) {
      const f = classifyJoinError(err);
      expect(f.kind).toBe('unreachable');
      expect(f.message).toBe(UNREACHABLE_MESSAGE);
      expect(f.retryMs).toBe(TUNING.client.joinRetryMs);
    }
  });

  it('"this laptop is already in the game" retries (the old socket may still be closing)', () => {
    const f = classifyJoinError(serverError(409, JOIN_ERRORS.oneSeat));
    expect(f).toEqual({ kind: 'oneSeat', message: JOIN_ERRORS.oneSeat, retryMs: TUNING.client.joinRetryMs });
  });

  it('a kicked laptop waits for the player, no retry', () => {
    const f = classifyJoinError(serverError(403, JOIN_ERRORS.kickedWait));
    expect(f).toEqual({ kind: 'kicked', message: JOIN_ERRORS.kickedWait, retryMs: null });
  });

  it('other server errors are shown without retrying', () => {
    const f = classifyJoinError(serverError(500, 'boom'));
    expect(f.kind).toBe('unknown');
    expect(f.retryMs).toBeNull();
  });
});

describe('disconnect messages', () => {
  it('explains a kick and a flood kick', () => {
    expect(closeMessage(CLOSE.kicked)).toMatch(/host removed you/i);
    expect(closeMessage(CLOSE.flood)).toMatch(/too many messages/i);
  });

  it('a consented leave shows nothing; anything else is a lost connection', () => {
    expect(closeMessage(4000)).toBeNull();
    expect(closeMessage(1006)).toMatch(/lost the connection/i);
  });
});
