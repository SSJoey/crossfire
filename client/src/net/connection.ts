import { Client, type Room } from '@colyseus/sdk';
import { ROOM_NAME } from '@crossfire/shared/types';
import { serverUrl } from '../config';
import type { RoomState } from './state';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the client has no server room type
export type GameRoom = Room<any, RoomState>;

let client: Client | null = null;

function sdk(): Client {
  client ??= new Client(serverUrl());
  return client;
}

/** Joins a lobby as a player. Throws the SDK's error on refusal (see joinflow.ts). */
export async function joinAsPlayer(code: string, name: string): Promise<GameRoom> {
  return sdk().joinById<RoomState>(code, { name });
}

/** Opens a new room as the host page (only allowed from the host laptop). */
export async function openAsHost(): Promise<GameRoom> {
  return sdk().create<RoomState>(ROOM_NAME, { role: 'host' });
}

/** Asks the server which LAN addresses players can use. */
export async function lanAddresses(): Promise<string[]> {
  try {
    const res = await fetch('/api/lan');
    if (!res.ok) return [];
    const body = (await res.json()) as { addresses?: unknown };
    return Array.isArray(body.addresses)
      ? body.addresses.filter((a): a is string => typeof a === 'string')
      : [];
  } catch {
    return [];
  }
}
