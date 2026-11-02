import { Client } from '@colyseus/sdk';
import { expect, test, type Page } from '@playwright/test';
import { JOIN_ERRORS } from '@crossfire/shared/types';

/** Read-only debug view the client exposes for this test (see client/src/debug.ts). */
interface CrossfireDebug {
  phase: string;
  me: { x: number; z: number; status: string } | null;
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

  // The host restarts: everyone is back in the lobby.
  await hostPage.locator('#host-restart').click();
  await expect(player.locator('#lobby-ready')).toBeVisible();
  await expect(player.locator('#end-screen')).toBeHidden();
  await expect.poll(async () => (await debugState(player)).phase).toBe('lobby');
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
