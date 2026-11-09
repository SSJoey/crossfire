import { expect, test, type Page } from '@playwright/test';

interface CrossfireDebug {
  phase: string;
  paused: boolean;
}

async function debugState(page: Page): Promise<CrossfireDebug> {
  return page.evaluate(() => (globalThis as unknown as { __crossfire: CrossfireDebug }).__crossfire);
}

const opened: Page[] = [];
test.afterEach(async () => {
  await Promise.all(opened.splice(0).map((p) => p.close()));
});

test('Esc pauses the run for everyone; the host page resumes it', async ({ browser }) => {
  const hostPage = await browser.newPage();
  const player = await browser.newPage();
  opened.push(hostPage, player);
  await hostPage.goto('/host');
  const code = hostPage.locator('#host-code');
  await expect(code).toHaveText(/^[A-HJ-NP-Z]{4}$/);
  await player.goto(`/?code=${(await code.textContent())!}&gfx=low`);
  await player.locator('#join-name').fill('Pia');
  await player.locator('#join-btn').click();
  await player.locator('#lobby-ready').click();
  await expect(hostPage.locator('#host-start')).toBeEnabled();
  await expect(hostPage.locator('#host-pause')).toBeDisabled();
  await hostPage.locator('#host-start').click();
  await expect(player.locator('#game-canvas')).toBeVisible();
  await expect.poll(async () => (await debugState(player)).phase).toBe('running');
  await expect(hostPage.locator('#host-pause')).toHaveText('Pause');
  await expect(player.locator('#hud-pause')).toBeHidden();

  await player.locator('#game-canvas').focus();
  await player.keyboard.press('Escape');
  await expect(player.locator('#hud-pause')).toBeVisible();
  await expect(player.locator('#hud-pause')).toContainText('Paused by you');
  await expect.poll(async () => (await debugState(player)).paused).toBe(true);
  await expect(hostPage.locator('#host-phase')).toContainText('Paused by Pia');
  await expect(hostPage.locator('#host-pause')).toHaveText('Resume');

  await hostPage.locator('#host-pause').click();
  await expect(player.locator('#hud-pause')).toBeHidden();
  await expect.poll(async () => (await debugState(player)).paused).toBe(false);
  await expect(hostPage.locator('#host-pause')).toHaveText('Pause');

  // Own cooldown: Esc right after the resume only shows the hint.
  await player.keyboard.press('Escape');
  await expect(player.locator('#hud-pause-hint')).toContainText('Pause available in');
  await player.waitForTimeout(300);
  expect((await debugState(player)).paused).toBe(false);

  // The host page pauses too.
  await hostPage.locator('#host-pause').click();
  await expect(player.locator('#hud-pause')).toContainText('Paused by the host');
});
