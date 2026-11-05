// Opens a room as the host page, presses "Add bot" and waits until a bot player is in the lobby.
// Used by tools/docker-check.sh: proves the server can start its bot process (e.g. in Docker).
// URL=http://127.0.0.1:2567 npx tsx tools/host-bot-check.ts
import { Client } from '@colyseus/sdk';
import { MSG, ROOM_NAME } from '@crossfire/shared/types';

const url = process.env.URL ?? 'http://127.0.0.1:2567';
const host = await new Client(url).create(ROOM_NAME, { role: 'host' });
const timeout = setTimeout(() => {
  console.log('no bot joined within 15 s');
  process.exit(1);
}, 15_000);
host.onStateChange((s: { players: { forEach(cb: (p: { name: string; bot: boolean }) => void): void } }) => {
  s.players.forEach((p) => {
    if (!p.bot) return;
    console.log(`bot joined: ${p.name}`);
    clearTimeout(timeout);
    void host.leave().then(() => process.exit(0));
  });
});
host.send(MSG.addBot, {});
