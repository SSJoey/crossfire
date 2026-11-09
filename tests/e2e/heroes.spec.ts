import { expect, test, type Browser, type Page } from '@playwright/test';

/** Read-only debug view the client exposes for the tests (see client/src/debug.ts). */
interface CrossfireDebug {
  phase: string;
  me: { x: number; z: number; status: string; hero: string; eCd: number } | null;
  zones: number;
  qPreview: boolean;
}

async function debugState(page: Page): Promise<CrossfireDebug> {
  return page.evaluate(() => (globalThis as unknown as { __crossfire: CrossfireDebug }).__crossfire);
}

async function openHost(page: Page): Promise<string> {
  await page.goto('/host');
  const code = page.locator('#host-code');
  await expect(code).toHaveText(/^[A-HJ-NP-Z]{4}$/);
  return (await code.textContent())!;
}

/** Pages each test opens; closed after it, so earlier games don't slow down later tests. */
const opened: Page[] = [];
test.afterEach(async () => {
  await Promise.all(opened.splice(0).map((p) => p.close()));
});

/** Joins, picks a hero (if given), gets ready and lets the host start the run. */
async function startAs(browser: Browser, name: string, hero: string | null, extra = ''): Promise<Page> {
  const hostPage = await browser.newPage();
  const player = await browser.newPage();
  opened.push(hostPage, player);
  const code = await openHost(hostPage);
  await player.goto(`/?code=${code}&gfx=low${extra}`);
  await player.locator('#join-name').fill(name);
  await player.locator('#join-btn').click();
  await expect(player.locator('#lobby-ready')).toBeVisible();
  if (hero) {
    const card = player.locator(`#pick-${hero}`);
    await card.click();
    await expect(card).toHaveAttribute('aria-pressed', 'true');
    await expect(player.locator('#lobby-players li .hero').first()).toHaveText(
      hero[0]!.toUpperCase() + hero.slice(1),
    );
  }
  await player.locator('#lobby-ready').click();
  await expect(hostPage.locator('#host-start')).toBeEnabled();
  await hostPage.locator('#host-start').click();
  await expect(player.locator('#game-canvas')).toBeVisible();
  await expect.poll(async () => (await debugState(player)).me?.status).toBe('standing');
  return player;
}

/** Points the mouse away from the hold point, so a dash or blink has open ground. */
async function aimOutward(page: Page): Promise<void> {
  const me = (await debugState(page)).me!;
  const len = Math.hypot(me.x, me.z) || 1;
  const box = (await page.locator('#game-canvas').boundingBox())!;
  // The camera never rotates: screen right is +X, screen down is +Z.
  const x = box.x + box.width / 2 + (me.x / len) * box.width * 0.3;
  const y = box.y + box.height / 2 + (me.z / len) * box.height * 0.3;
  await page.mouse.move(x, y);
  await page.locator('#game-canvas').focus();
}

test('pick Gale in the lobby; the HUD shows her kit and E dashes', async ({ browser }) => {
  const player = await startAs(browser, 'Mia', 'gale');
  await expect(player.locator('#hud-hero-name')).toContainText('Gale');
  await expect(player.locator('#hud-slot-basic')).toContainText('Twin daggers');
  await expect(player.locator('#hud-slot-q')).toContainText('Cyclone');
  await expect(player.locator('#hud-slot-e')).toContainText('Gust dash');
  await expect(player.locator('#hud-passive')).toContainText('Tailwind');
  await expect.poll(async () => (await debugState(player)).me?.hero).toBe('gale');

  await aimOutward(player);
  const start = (await debugState(player)).me!;
  await player.keyboard.press('KeyE');
  await expect
    .poll(
      async () => {
        const me = (await debugState(player)).me!;
        return Math.hypot(me.x - start.x, me.z - start.z);
      },
      { timeout: 1000 },
    )
    .toBeGreaterThan(5);
  await expect(player.locator('#hud-slot-e')).toHaveAttribute('data-cooling', '1');
});

test('Bastion: holding Q shows the preview, releasing casts a zone', async ({ browser }) => {
  const player = await startAs(browser, 'Ravi', 'bastion');
  await aimOutward(player);
  await player.keyboard.down('KeyQ');
  await expect.poll(async () => (await debugState(player)).qPreview).toBe(true);
  await expect(player.locator('#hud-slot-q')).toHaveClass(/armed/);
  await player.keyboard.up('KeyQ');
  await expect.poll(async () => (await debugState(player)).zones, { timeout: 2000 }).toBe(1);
  await expect.poll(async () => (await debugState(player)).qPreview).toBe(false);
  await expect(player.locator('#hud-slot-q')).toHaveAttribute('data-cooling', '1');
});

test('with ?debug=1, key 3 switches to Tide', async ({ browser }) => {
  const player = await startAs(browser, 'Dev', null, '&debug=1');
  await expect.poll(async () => (await debugState(player)).me?.hero).toBe('ember');
  await player.locator('#game-canvas').focus();
  await player.keyboard.press('Digit3');
  await expect.poll(async () => (await debugState(player)).me?.hero, { timeout: 3000 }).toBe('tide');
  await expect(player.locator('#hud-hero-name')).toContainText('Tide');
});

test('without ?debug=1, key 3 changes nothing', async ({ browser }) => {
  const player = await startAs(browser, 'Ana', null);
  await player.locator('#game-canvas').focus();
  await player.keyboard.press('Digit3');
  await player.waitForTimeout(1500);
  expect((await debugState(player)).me?.hero).toBe('ember');
});
