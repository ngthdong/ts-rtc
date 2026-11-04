import { execSync } from 'node:child_process';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { closePages, join, newPage, openApp, quality } from './helpers.js';

test.afterEach(closePages);

async function room(browser: Browser, names: string[], path = '/'): Promise<Page[]> {
  const pages = [await openApp(browser, path)];
  const roomId = await join(pages[0] as Page, names[0] ?? 'A', null);
  for (const name of names.slice(1)) {
    const page = await openApp(browser, path);
    await join(page, name, roomId);
    pages.push(page);
  }
  return pages;
}

/** The name on the highlighted tile in `page`, or null. */
async function speaker(page: Page): Promise<string | null> {
  const tile = page.locator('figure[data-speaking]');
  return (await tile.count()) === 1
    ? ((await tile.locator('figcaption').textContent()) ?? '')
    : null;
}

test('the speaker highlight follows the one who is not muted, and stays', async ({ browser }) => {
  const [alice, bob] = (await room(browser, ['Alice', 'Bob'])) as [Page, Page];
  await bob.getByRole('button', { name: 'Mute' }).click();
  await expect.poll(() => speaker(bob), { timeout: 10_000 }).toMatch(/^Alice/);
  for (let i = 0; i < 4; i++) {
    await bob.waitForTimeout(1_000);
    expect(await speaker(bob)).toMatch(/^Alice/); // stays: no flicker back and forth
  }
  await expect.poll(() => speaker(alice)).toMatch(/^Alice \(you\)/); // same state everywhere

  await bob.getByRole('button', { name: 'Unmute' }).click();
  await alice.getByRole('button', { name: 'Mute' }).click();
  await expect.poll(() => speaker(alice), { timeout: 10_000 }).toMatch(/^Bob/);
});

test('the camera sends three simulcast layers (Chromium, VP8)', async ({ browser }) => {
  const [alice] = (await room(browser, ['Alice', 'Bob'])) as [Page, Page];
  const layers = () => alice.evaluate(() => window.__tsRtc?.sendLayers() ?? []);
  await expect
    .poll(async () => (await layers()).filter((l) => l.bytes > 0).length, { timeout: 30_000 })
    .toBe(3);
  test.info().annotations.push({ type: 'layers', description: JSON.stringify(await layers()) });
});

/** The widest video `page` receives right now (the layer the SFU forwards to it). */
async function width(page: Page): Promise<number> {
  const widths: Record<string, number> = await page.evaluate(
    () => window.__tsRtc?.receivedWidths() ?? {},
  );
  return Math.max(0, ...Object.values(widths));
}

/** A member whose camera is denied: it only receives video. */
async function audioOnly(browser: Browser, name: string, roomId: string): Promise<Page> {
  const page = await newPage(browser);
  await page.addInitScript(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (constraints) =>
      constraints?.video
        ? Promise.reject(new DOMException('no camera in this test', 'NotAllowedError'))
        : original(constraints);
  });
  await page.goto('/');
  await join(page, name, roomId);
  return page;
}

/**
 * The SFU's point, shown: one receiver's downlink is squeezed to 400 kbit/s (iptables policer on
 * the Worker → browser packets of that one connection); only that receiver drops to a lower
 * layer. Opt-in: LIMIT_RECEIVER=1 (Linux, root or sudo). The rule matches Bob's port only: the
 * room may be on any Worker (MEDIA_PORT_BASE + i), and only that Worker sends to this port.
 */
test('a bandwidth-limited receiver drops to a lower layer; the others keep the top one', async ({
  browser,
}) => {
  test.skip(!process.env.LIMIT_RECEIVER, 'set LIMIT_RECEIVER=1 (Linux, root or sudo)');
  test.setTimeout(150_000);
  const alice = await openApp(browser);
  const roomId = await join(alice, 'Alice', null); // the only camera, sent as 3 layers
  const bob = await audioOnly(browser, 'Bob', roomId);
  const carol = await audioOnly(browser, 'Carol', roomId);
  await expect.poll(() => width(bob), { timeout: 60_000 }).toBe(1280);
  await expect.poll(() => width(carol), { timeout: 60_000 }).toBe(1280);

  const localPort = async () => Object.values(await quality(bob))[0]?.path?.localPort ?? 0;
  await expect.poll(localPort).toBeGreaterThan(0); // Bob's end of his recv transport
  const port = await localPort();
  const sudo = process.getuid?.() === 0 ? '' : 'sudo ';
  const rule =
    `INPUT -i lo -p udp --dport ${String(port)} ` +
    '-m hashlimit --hashlimit-name bob --hashlimit-above 50kb/s --hashlimit-burst 50kb -j DROP';
  execSync(`${sudo}iptables -I ${rule}`);
  try {
    const startedAt = Date.now();
    await expect.poll(() => width(bob), { timeout: 30_000 }).toBeLessThan(1280);
    const seconds = (Date.now() - startedAt) / 1000;
    // Unaffected. If not, say whether Alice still sends the top layer (sender or receiver side).
    const sent = await alice.evaluate(() => window.__tsRtc?.sendLayers() ?? []);
    expect(await width(carol), `Alice sends ${JSON.stringify(sent)}`).toBe(1280);
    test.info().annotations.push({
      type: 'layer drop',
      description: `Bob ${String(await width(bob))} px after ${seconds.toFixed(1)} s; Carol 1280 px`,
    });
  } finally {
    execSync(`${sudo}iptables -D ${rule}`);
  }
});
