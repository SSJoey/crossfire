import { boot, type ColyseusTestServer } from '@colyseus/testing';
import type { Room as ClientRoom } from '@colyseus/sdk';
import { MSG, ROOM_NAME, type InputMessage } from '@crossfire/shared/types';
import { createApp } from '../../server/src/app';
import type { HoldRoom } from '../../server/src/rooms/HoldRoom';

export const REMOTE_ROOM = 'hold_remote';

export async function bootServer(): Promise<ColyseusTestServer> {
  return boot(createApp({ testRooms: true }));
}

/** Polls until the condition holds or the timeout passes. */
export async function until(cond: () => boolean, timeoutMs = 3000, label = 'condition'): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

export interface Lobby {
  host: ClientRoom;
  room: HoldRoom;
  code: string;
}

export async function openLobby(colyseus: ColyseusTestServer, name = ROOM_NAME): Promise<Lobby> {
  const host = await colyseus.sdk.create(name, { role: 'host' });
  const room = colyseus.getRoomById<HoldRoom>(host.roomId);
  return { host, room, code: host.roomId };
}

export async function joinPlayer(
  colyseus: ColyseusTestServer,
  code: string,
  name: string,
): Promise<ClientRoom> {
  return colyseus.sdk.joinById(code, { name });
}

/** Opens a lobby with the given players, readies them and starts the run. */
export async function startRun(
  colyseus: ColyseusTestServer,
  names: string[],
): Promise<Lobby & { players: ClientRoom[] }> {
  const lobby = await openLobby(colyseus);
  const players: ClientRoom[] = [];
  for (const n of names) players.push(await joinPlayer(colyseus, lobby.code, n));
  for (const p of players) p.send(MSG.ready, { ready: true });
  await until(() => [...lobby.room.state.players.values()].every((p) => p.ready), 3000, 'all ready');
  lobby.host.send(MSG.start, {});
  await until(() => lobby.room.state.phase === 'running', 3000, 'run start');
  return { ...lobby, players };
}

export function input(seq: number, patch: Partial<InputMessage> = {}): InputMessage {
  return { seq, moveX: 0, moveZ: 0, aimX: 0, aimZ: 5, attack: false, revive: false, ...patch };
}
