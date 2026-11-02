import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join, resolve } from 'node:path';
import { defineRoom, defineServer } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { ROOM_NAME } from '@crossfire/shared/types';
import express from 'express';
import { lanAddresses } from './lan';
import { HoldRoom, RemoteOnlyHoldRoom } from './rooms/HoldRoom';

/** The production client build. */
const DEFAULT_CLIENT_DIR = resolve(import.meta.dirname, '../../client/dist');

export interface AppOptions {
  /** Registers test-only rooms. Never set in production. */
  testRooms?: boolean;
  /** Folder with the built client to serve. Skipped when it does not exist (development). */
  clientDir?: string;
}

export function createApp(opts: AppOptions = {}) {
  const clientDir = opts.clientDir ?? DEFAULT_CLIENT_DIR;
  return defineServer({
    rooms: {
      [ROOM_NAME]: defineRoom(HoldRoom),
      ...(opts.testRooms ? { hold_remote: defineRoom(RemoteOnlyHoldRoom) } : {}),
    },
    transport: new WebSocketTransport({ maxPayload: 16 * 1024 }),
    greet: false,
    express: (app) => {
      app.disable('x-powered-by');
      app.get('/api/lan', (_req, res) => {
        res.json({ addresses: lanAddresses(networkInterfaces(), process.env) });
      });
      if (existsSync(join(clientDir, 'index.html'))) {
        const index = join(clientDir, 'index.html');
        app.get(['/', '/host'], (_req, res) => res.sendFile(index));
        app.use(express.static(clientDir, { index: false }));
      }
    },
  });
}
