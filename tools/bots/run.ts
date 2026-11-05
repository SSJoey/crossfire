// Fill a game with headless bots: npm run bots -- --code ABCD [--count 7] [--url http://127.0.0.1:2567]
// The bots join the lobby, get ready by themselves and play until Ctrl+C.
import { parseArgs } from 'node:util';
import { Client } from '@colyseus/sdk';
import { normaliseRoomCode } from '../../client/src/net/joinflow';
import { Bot } from '../../server/src/bots/bot';

const { values } = parseArgs({
  options: {
    code: { type: 'string' },
    count: { type: 'string', default: '7' },
    url: { type: 'string', default: 'http://127.0.0.1:2567' },
  },
});

const code = normaliseRoomCode(values.code ?? '');
const count = Math.max(1, Math.min(8, Number(values.count) || 0));
if (!code) {
  console.error('Usage: npm run bots -- --code ABCD [--count 7] [--url http://127.0.0.1:2567]');
  process.exit(2);
}

const sdk = new Client(values.url);
const bots: Bot[] = [];
for (let i = 1; i <= count; i++) {
  const bot = new Bot(sdk, code, `Bot ${i}`, i);
  try {
    await bot.start();
    bots.push(bot);
    console.log(`${bot.name} joined ${code}`);
  } catch (e) {
    console.error(`${bot.name} could not join: ${(e as Error).message}`);
  }
}
if (bots.length === 0) process.exit(1);
console.log(`${bots.length} bot(s) in room ${code}. Ctrl+C to remove them.`);

const watch = setInterval(() => {
  for (const b of bots)
    if (!b.connected && b.closeCode !== undefined) {
      console.log(`${b.name} left (close code ${b.closeCode})`);
      b.closeCode = undefined;
    }
  if (bots.every((b) => !b.connected)) {
    clearInterval(watch);
    process.exit(0);
  }
}, 1000);

process.on('SIGINT', () => {
  void Promise.all(bots.map((b) => b.stop())).then(() => process.exit(0));
});
