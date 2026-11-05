// Bot process: one per room, started by BotSupervisor with child_process.fork. It receives
// "add" messages over IPC from the game server and plays each bot as a normal player that
// connects over loopback. It never reads anything from players: only the room talks to it.
import { Client } from '@colyseus/sdk';
import { Bot } from './bot';
import type { FromBotProcess, ToBotProcess } from './ipc';

const bots: Bot[] = [];
const clients = new Map<string, Client>();

function send(msg: FromBotProcess): void {
  if (process.connected) process.send?.(msg);
}

async function stopAll(): Promise<void> {
  await Promise.all(bots.map((b) => b.stop()));
  process.exit(0);
}

process.on('message', (raw: unknown) => {
  const msg = raw as ToBotProcess;
  if (msg.type === 'stop') {
    void stopAll();
    return;
  }
  if (msg.type !== 'add') return;
  let sdk = clients.get(msg.url);
  if (!sdk) {
    sdk = new Client(msg.url);
    clients.set(msg.url, sdk);
  }
  const bot = new Bot(sdk, msg.code, msg.name, msg.seed, msg.ticket);
  bots.push(bot);
  bot.start().catch((e: unknown) => {
    bots.splice(bots.indexOf(bot), 1);
    send({ type: 'failed', name: msg.name, error: (e as Error).message });
  });
});

// The game server went away (crash, shutdown): never outlive it.
process.on('disconnect', () => void stopAll());
