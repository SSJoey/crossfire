import { defineRoom, defineServer } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { ROOM_NAME } from '@crossfire/shared/types';
import { HoldRoom, RemoteOnlyHoldRoom } from './rooms/HoldRoom';

export interface AppOptions {
  /** Registers test-only rooms. Never set in production. */
  testRooms?: boolean;
}

export function createApp(opts: AppOptions = {}) {
  return defineServer({
    rooms: {
      [ROOM_NAME]: defineRoom(HoldRoom),
      ...(opts.testRooms ? { hold_remote: defineRoom(RemoteOnlyHoldRoom) } : {}),
    },
    transport: new WebSocketTransport({ maxPayload: 16 * 1024 }),
    greet: false,
  });
}
