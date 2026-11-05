import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import {
  closePages,
  expectConnected,
  expectMediaFlowing,
  join,
  openApp,
  signedIn,
} from './helpers.js';

test.afterEach(closePages);

// Must match the server's PORT, as in playwright.config.ts.
const debug = `http://127.0.0.1:${process.env.PORT ?? '4000'}/debug/media`;

/** The app's dev-only test hook (window.__tsRtc), one call per page. */
const hook = {
  me: (page: Page) => page.evaluate(() => window.__tsRtc?.participantId() ?? null),
  log: (page: Page) => page.evaluate(() => window.__tsRtc?.recoveryLog() ?? []),
  drop: (page: Page, ms: number) =>
    page.evaluate((outage) => window.__tsRtc?.dropSignaling(outage), ms),
  transportIds: (page: Page) => page.evaluate(() => window.__tsRtc?.transportIds() ?? []),
  routerId: (page: Page) => page.evaluate(() => window.__tsRtc?.routerId() ?? null),
};

async function media(request: APIRequestContext) {
  const response = await request.get(debug);
  return (await response.json()) as {
    live: Record<string, number>;
    workers: { pid: number; routerIds: string[] }[];
  };
}

/** mic + camera from each of 3 members, received by the 2 others. */
const THREE = { transports: 6, producers: 6, consumers: 12 };

/** Alice, Bob and Carol in a new SFU room, everyone receiving everyone. */
async function call(browser: Browser): Promise<Page[]> {
  const alice = await openApp(browser);
  const roomId = await join(alice, 'Alice', null);
  const pages = [alice];
  for (const name of ['Bob', 'Carol']) {
    const page = await openApp(browser);
    await join(page, name, roomId);
    pages.push(page);
  }
  for (const page of pages) await expectConnected(page, 2);
  for (const page of pages) await expectMediaFlowing(page, 2);
  return pages;
}

test('signaling drops for 3 s: media keeps flowing, the same member resumes', async ({
  browser,
}) => {
  const [alice, bob] = await call(browser);
  if (!alice || !bob) throw new Error('unreachable');
  const before = await hook.me(bob);
  await hook.drop(bob, 3_000);
  await expect(bob.getByTestId('status')).toHaveText('reconnecting');
  await expect(alice.getByTestId('reconnecting')).toHaveCount(1); // others are told
  await expectMediaFlowing(bob, 2); // the media plane does not care: same ICE, same Worker
  await expect(bob.getByTestId('status')).toHaveText('ready', { timeout: 20_000 });
  await expect.poll(() => hook.log(bob)).toEqual(['none (reconnected)']);
  expect(await hook.me(bob)).toBe(before); // resumed, not rejoined: no duplicate tile
  await expect(alice.getByTestId('reconnecting')).toHaveCount(0);
  await expectMediaFlowing(alice, 2);
});

test('while signaling is down, Carol leaves and Dave joins: the resume catches up', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const [alice, bob, carol] = await call(browser);
  if (!alice || !bob || !carol) throw new Error('unreachable');
  const dave = await openApp(browser);
  await signedIn(dave, 'Dave');
  const roomId = (await alice.getByTestId('room-id').textContent()) ?? '';
  await hook.drop(bob, 15_000);
  await expect(bob.getByTestId('status')).toHaveText('reconnecting');
  await carol.getByRole('button', { name: 'Leave' }).click();
  await expect(carol.getByTestId('room-id')).toHaveCount(0);
  await join(dave, 'Dave', roomId);
  await expectMediaFlowing(dave, 2); // Dave receives Bob too: Bob's media never stopped
  await expect(bob.getByTestId('status')).toHaveText('reconnecting'); // all of it in the gap
  await expect(bob.getByTestId('status')).toHaveText('ready', { timeout: 25_000 });
  await expect.poll(() => hook.log(bob)).toEqual(['none (reconnected)']);
  // The newProducer and consumerClosed Bob missed: reconciled from the resume snapshot.
  await expect(bob.getByTestId('remote')).toHaveCount(2);
  await expect(bob.locator('figcaption')).toContainText(['Bob (you)', 'Alice', 'Dave']);
  await expectMediaFlowing(bob, 2);
});

test('signaling down past the 30 s grace: Bob joins afresh, no stale tile is left', async ({
  browser,
  request,
}) => {
  test.setTimeout(150_000);
  const [alice, bob] = await call(browser);
  if (!alice || !bob) throw new Error('unreachable');
  const before = await hook.me(bob);
  await hook.drop(bob, 35_000);
  await expect(alice.getByTestId('reconnecting')).toHaveCount(1);
  // Grace over: the old Bob is removed (tile gone), before the new one arrives.
  await expect(alice.getByTestId('remote')).toHaveCount(1, { timeout: 40_000 });
  await expect(bob.getByTestId('status')).toHaveText('ready', { timeout: 30_000 });
  await expect.poll(() => hook.log(bob), { timeout: 15_000 }).toContain('rejoin (reconnected)');
  expect(await hook.me(bob)).not.toBe(before);
  for (const page of [alice, bob]) await expectConnected(page, 2);
  for (const page of [alice, bob]) await expectMediaFlowing(page, 2);
  await expect(alice.getByTestId('reconnecting')).toHaveCount(0);
  await expect.poll(async () => (await media(request)).live).toEqual(THREE); // nothing leaked
});

test("the room's Worker dies: everyone rebuilds on a new Router, the call goes on", async ({
  browser,
  request,
}) => {
  test.setTimeout(90_000);
  const pages = await call(browser);
  const routerId = await hook.routerId(pages[0] as Page);
  const { workers } = await media(request);
  const worker = workers.find((w) => routerId !== null && w.routerIds.includes(routerId));
  if (!worker) throw new Error(`no Worker hosts router ${String(routerId)}`);
  process.kill(worker.pid, 'SIGKILL'); // as a crash or the OOM killer would
  for (const page of pages) {
    await expect.poll(() => hook.log(page), { timeout: 15_000 }).toEqual(['rebuild (media_reset)']);
  }
  for (const page of pages) await expectConnected(page, 2);
  for (const page of pages) await expectMediaFlowing(page, 2);
  expect(await hook.routerId(pages[0] as Page)).not.toBe(routerId);
  await expect.poll(async () => (await media(request)).live).toEqual(THREE);
});

test("the server closes Bob's send transport: only Bob rebuilds; everyone has his media back", async ({
  browser,
  request,
}) => {
  const pages = await call(browser);
  const [alice, bob] = pages;
  if (!alice || !bob) throw new Error('unreachable');
  const [send] = await hook.transportIds(bob);
  expect((await request.post(`${debug}/transports/${String(send)}/close`)).status()).toBe(204);
  await expect.poll(() => hook.log(bob)).toEqual(['rebuild (transport_closed)']);
  for (const page of pages) await expectMediaFlowing(page, 2);
  expect(await hook.log(alice)).toEqual([]);
  expect(await hook.transportIds(bob)).not.toContain(send);
  await expect.poll(async () => (await media(request)).live).toEqual(THREE); // old ones closed
});

test('another connection resumes Bob: the old one is told, closes with 4409, does not retry', async ({
  browser,
}) => {
  const [alice, bob] = await call(browser);
  if (!alice || !bob) throw new Error('unreachable');
  const member = await hook.me(bob);
  const resumed = await bob.evaluate(async () => {
    const { resumeToken, accessToken } = window.__tsRtc?.tokens() ?? {};
    const ws = new WebSocket(new URL('/ws', location.href).href.replace(/^http/, 'ws'));
    const replies = new Map<string, { ok: boolean; payload?: { participantId: string } }>();
    ws.onmessage = ({ data }) => {
      const message = JSON.parse(String(data)) as { kind: string; id: string; ok: boolean };
      if (message.kind === 'res') replies.set(message.id, message);
    };
    await new Promise((resolve) => (ws.onopen = resolve));
    const ask = async (id: string, type: string, payload: object) => {
      ws.send(JSON.stringify({ v: 1, kind: 'req', id, type, payload }));
      while (!replies.has(id)) await new Promise((resolve) => setTimeout(resolve, 20));
      return replies.get(id);
    };
    await ask('1', 'session.hello', { protocolVersions: [1], accessToken });
    const reply = await ask('2', 'room.resume', { resumeToken });
    Object.assign(window, { takeover: ws }); // keep it open: it is Bob now
    return reply?.ok ? reply.payload?.participantId : null;
  });
  expect(resumed).toBe(member); // the same participant, now on the other socket
  await expect(bob.getByTestId('close-info')).toContainText('4409');
  await expect(bob.getByTestId('call-ended')).toContainText('continued elsewhere');
  await bob.waitForTimeout(3_000);
  await expect(bob.getByTestId('status')).toHaveText('closed'); // final: no reconnect
  await expect(alice.getByTestId('remote')).toHaveCount(2); // still one Bob, on the other socket
  await expect(alice.getByTestId('reconnecting')).toHaveCount(0);
});
