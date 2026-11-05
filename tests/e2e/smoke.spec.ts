import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from '@colyseus/sdk';
import { expect, test, type Page } from '@playwright/test';
import { JOIN_ERRORS } from '@crossfire/shared/types';

/** Read-only debug view the client exposes for this test (see client/src/debug.ts). */
interface CrossfireDebug {
  phase: string;
  me: { x: number; z: number; status: string } | null;
}

/** Same folder as LOG_DIR in playwright.config.ts. */
const LOG_DIR = resolve(import.meta.dirname, '../../test-results/logs');

function logLines(code: string): Record<string, unknown>[] {
  if (!existsSync(LOG_DIR)) return [];
  return readdirSync(LOG_DIR)
    .filter((f) => f.endsWith(`_${code}.jsonl`))
    .flatMap((f) => readFileSync(resolve(LOG_DIR, f), 'utf8').split('\n'))
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

async function debugState(page: Page): Promise<CrossfireDebug> {
  return page.evaluate(() => (globalThis as unknown as { __crossfire: CrossfireDebug }).__crossfire);
}

function failOnDialog(page: Page): void {
  page.on('dialog', (d) => {
    throw new Error(`Unexpected dialog: ${d.message()}`);
  });
}

async function openHost(page: Page): Promise<string> {
  await page.goto('/host');
  const code = page.locator('#host-code');
  await expect(code).toHaveText(/^[A-HJ-NP-Z]{4}$/);
  return (await code.textContent())!;
}

async function joinAs(page: Page, code: string, name: string): Promise<void> {
  await page.goto(`/?code=${code}&gfx=low`);
  await page.locator('#join-name').fill(name);
  await page.locator('#join-btn').click();
}

test('host, join, play, go down, end screen, restart', async ({ browser }) => {
  const hostPage = await browser.newPage();
  const player = await browser.newPage();
  failOnDialog(hostPage);
  failOnDialog(player);

  const code = await openHost(hostPage);
  await expect(hostPage.locator('#host-link')).toContainText(`?code=${code}`);
  await expect(hostPage.locator('#host-qr')).toBeVisible();
  await expect(hostPage.locator('#host-count')).toHaveText('0 / 8');

  // An HTML-looking name is shown as plain text and never runs.
  const evil = '<img src=x onerror=alert(1)>';
  await joinAs(player, code, evil);
  await expect(player.locator('#lobby-players li .nm').first()).toHaveText(evil.slice(0, 16));
  await expect(hostPage.locator('#host-count')).toHaveText('1 / 8');
  await expect(hostPage.locator('#host-players li .nm').first()).toHaveText(evil.slice(0, 16));
  expect(await hostPage.locator('#host-players img').count()).toBe(0);
  expect(await player.locator('#lobby-players img').count()).toBe(0);

  await expect(hostPage.locator('#host-start')).toBeDisabled();
  await player.locator('#lobby-ready').click();
  await expect(hostPage.locator('#host-start')).toBeEnabled();
  await hostPage.locator('#host-start').click();

  // The game view and HUD appear.
  await expect(player.locator('#game-canvas')).toBeVisible();
  await expect(player.locator('#hud-wave')).toHaveText('1');
  await expect.poll(async () => (await debugState(player)).me?.status).toBe('standing');
  // The fps overlay is off unless ?fps=1 is given.
  expect(await player.locator('#fps-overlay').count()).toBe(0);

  // D moves the hero to the right (+X).
  const start = (await debugState(player)).me!;
  await player.locator('#game-canvas').click({ position: { x: 20, y: 20 } });
  await player.keyboard.down('KeyD');
  await expect
    .poll(async () => (await debugState(player)).me!.x, { timeout: 5000 })
    .toBeGreaterThan(start.x + 3);

  // Keep walking out of the ring: the drain downs the hero, bleed-out ends the run.
  await expect.poll(async () => (await debugState(player)).me!.status, { timeout: 45_000 }).toBe('downed');
  await player.keyboard.up('KeyD');
  await expect(player.locator('#end-screen')).toBeVisible({ timeout: 45_000 });
  await expect(player.locator('#end-wave')).toHaveText(/^\d+$/);
  await expect(player.locator('#end-time')).toHaveText(/^\d+:\d\d$/);

  // The browser reported its tier and fps; the perf lines carry it under the player's name.
  const reported = logLines(code)
    .filter((l) => l.ev === 'perf')
    .map((l) => (l.clients as Record<string, { tier: string; fps: number; w: number }>)[evil.slice(0, 16)])
    .find((c) => c !== undefined);
  expect(reported).toMatchObject({ tier: 'low' });
  expect(reported!.fps).toBeGreaterThan(0);
  expect(reported!.w).toBeGreaterThan(0);

  // The host restarts: everyone is back in the lobby.
  await hostPage.locator('#host-restart').click();
  await expect(player.locator('#lobby-ready')).toBeVisible();
  await expect(player.locator('#end-screen')).toBeHidden();
  await expect.poll(async () => (await debugState(player)).phase).toBe('lobby');
});

test('?fps=1 shows the fps overlay in the game', async ({ browser }) => {
  const hostPage = await browser.newPage();
  const player = await browser.newPage();
  const code = await openHost(hostPage);
  await player.goto(`/?code=${code}&gfx=low&fps=1`);
  await player.locator('#join-name').fill('Counter');
  await player.locator('#join-btn').click();
  await player.locator('#lobby-ready').click();
  await expect(hostPage.locator('#host-start')).toBeEnabled();
  await hostPage.locator('#host-start').click();
  const overlay = player.locator('#fps-overlay');
  await expect(overlay).toBeVisible();
  await expect(overlay).toContainText(/\d+ fps/, { timeout: 5000 });
  await expect(overlay).toContainText(/1% low \d+/);
  await expect(overlay).toContainText(/enemies \d+/);
  await expect(overlay).toContainText('low');
});

test('the host page adds and removes bots', async ({ browser }) => {
  const hostPage = await browser.newPage();
  failOnDialog(hostPage);
  await openHost(hostPage);
  await expect(hostPage.locator('#host-remove-bots')).toBeDisabled();
  await hostPage.locator('#host-add-bot').click();
  await hostPage.locator('#host-add-bot').click();
  await expect(hostPage.locator('#host-count')).toHaveText('2 / 8', { timeout: 10_000 });
  await expect(hostPage.locator('#host-players li .nm')).toHaveText(['Bot 1', 'Bot 2']);
  await expect(hostPage.locator('#host-players li .bot')).toHaveText(['(bot)', '(bot)']);
  // Bots get ready by themselves, so the run can start.
  await expect(hostPage.locator('#host-start')).toBeEnabled({ timeout: 5000 });
  await hostPage.locator('#host-remove-bots').click();
  await expect(hostPage.locator('#host-count')).toHaveText('0 / 8');
  await expect(hostPage.locator('#host-remove-bots')).toBeDisabled();
});

test('a 9th player is told the game is full', async ({ browser, baseURL }) => {
  const hostPage = await browser.newPage();
  const code = await openHost(hostPage);
  const sdk = new Client(baseURL!);
  const rooms = await Promise.all(
    Array.from({ length: 8 }, (_, i) => sdk.joinById(code, { name: `Bot ${i + 1}` })),
  );
  await expect(hostPage.locator('#host-count')).toHaveText('8 / 8');

  const ninth = await browser.newPage();
  await joinAs(ninth, code, 'Nine');
  await expect(ninth.locator('#join-error')).toHaveText(JOIN_ERRORS.full);
  await Promise.all(rooms.map((r) => r.leave()));
});

test('a wrong room code says the host cannot be reached', async ({ browser }) => {
  const page = await browser.newPage();
  await joinAs(page, 'ZZZZ', 'Lost');
  await expect(page.locator('#join-error')).toContainText("Can't reach the host");
});
