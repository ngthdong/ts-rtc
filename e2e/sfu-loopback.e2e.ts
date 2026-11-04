import { execSync } from 'node:child_process';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { closePages, expectConnected, expectMediaFlowing, openApp, quality } from './helpers.js';

test.afterEach(closePages);

// Must match the server's PORT, as in playwright.config.ts.
const apiPort = process.env.PORT ?? '4000';

/** Live mediasoup objects on the dev server (GET /debug/media, dev builds only). */
async function live(request: APIRequestContext) {
  const response = await request.get(`http://127.0.0.1:${apiPort}/debug/media`);
  return ((await response.json()) as { live: Record<string, number> }).live;
}

/** Joins a fresh SFU room alone, sends camera + mic to the SFU and receives them back. */
async function loopback(page: Page) {
  await page.getByLabel('Your name').fill('Solo');
  await page.getByRole('button', { name: 'SFU loopback test' }).click();
  await expectConnected(page, 1);
  await expectMediaFlowing(page, 1); // audio and video bytes rising on the recv transport
  await expect.poll(async () => Object.values(await quality(page))[0]?.path).toBeTruthy();
  return Object.values(await quality(page))[0]?.path;
}

async function leaveAndExpectNothingLeft(page: Page, request: APIRequestContext) {
  await page.getByRole('button', { name: 'Leave' }).click();
  await expect.poll(() => live(request)).toEqual({ transports: 0, producers: 0, consumers: 0 });
}

test('SFU loopback, direct: UDP to the Worker; 2 transports, then nothing left', async ({
  browser,
  request,
}) => {
  const page = await openApp(browser);
  const path = await loopback(page);
  expect(path).toMatchObject({ remote: 'host', protocol: 'udp' });
  // One send + one recv transport; camera and mic produced and consumed back.
  expect(await live(request)).toEqual({ transports: 2, producers: 2, consumers: 2 });
  test.info().annotations.push({ type: 'selected-path', description: JSON.stringify(path) });
  await leaveAndExpectNothingLeft(page, request);
});

test('SFU loopback through TURN only (relay → Worker)', async ({ browser, request }) => {
  test.skip(!process.env.TURN_SECRET, 'needs coturn: set TURN_SECRET, docker compose up');
  const page = await openApp(browser, '/?relay');
  const path = await loopback(page);
  expect(path).toMatchObject({ local: 'relay' });
  test.info().annotations.push({ type: 'selected-path', description: JSON.stringify(path) });
  await leaveAndExpectNothingLeft(page, request);
});

/** Drops UDP to the Workers' ports with iptables: Linux, root or sudo. Opt-in. */
test('SFU loopback with UDP blocked: ICE-TCP to the WebRtcServer', async ({ browser, request }) => {
  test.skip(!process.env.BLOCK_UDP, 'set BLOCK_UDP=1 (Linux, root or sudo)');
  const sudo = process.getuid?.() === 0 ? '' : 'sudo ';
  const rule = 'INPUT -i lo -p udp --dport 40000:40015 -j DROP';
  execSync(`${sudo}iptables -I ${rule}`);
  try {
    const page = await openApp(browser);
    const path = await loopback(page);
    expect(path).toMatchObject({ remote: 'host', protocol: 'tcp' });
    test.info().annotations.push({ type: 'selected-path', description: JSON.stringify(path) });
    await leaveAndExpectNothingLeft(page, request);
  } finally {
    execSync(`${sudo}iptables -D ${rule}`);
  }
});
