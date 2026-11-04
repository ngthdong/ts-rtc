import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import {
  closePages,
  expectConnected,
  expectMediaFlowing,
  inboundBytes,
  join,
  newPage,
  openApp,
  receivedTracks,
  resources,
} from './helpers.js';

test.afterEach(closePages);

// Must match the server's PORT, as in playwright.config.ts.
const apiPort = process.env.PORT ?? '4000';

/** Live mediasoup objects on the dev server (GET /debug/media, dev builds only). */
async function live(request: APIRequestContext) {
  const response = await request.get(`http://127.0.0.1:${apiPort}/debug/media`);
  return ((await response.json()) as { live: Record<string, number> }).live;
}

/** Everyone sends mic + camera once and receives both from everyone else. */
const expected = (members: number) => ({
  transports: 2 * members,
  producers: 2 * members,
  consumers: 2 * members * (members - 1),
});
const NONE = { transports: 0, producers: 0, consumers: 0 };

async function sfuCall(browser: Browser, size: number): Promise<Page[]> {
  const pages = [await openApp(browser)]; // new rooms are SFU rooms by default
  const roomId = await join(pages[0] as Page, 'S0', null);
  for (let i = 1; i < size; i++) {
    const page = await openApp(browser);
    await join(page, `S${String(i)}`, roomId);
    pages.push(page);
  }
  return pages;
}

for (const size of [3, 6]) {
  test(`${String(size)} browsers through the SFU: everyone receives everyone`, async ({
    browser,
    request,
  }) => {
    test.setTimeout(120_000);
    const pages = await sfuCall(browser, size);
    for (const page of pages) await expectConnected(page, size - 1);
    for (const page of pages) await expectMediaFlowing(page, size - 1);
    expect(await live(request)).toEqual(expected(size));
    for (const page of pages) await page.getByRole('button', { name: 'Leave' }).click();
    await expect.poll(() => live(request)).toEqual(NONE);
  });
}

test('mute pauses the Producer: receivers get no more audio from it, and see "muted"', async ({
  browser,
}) => {
  const [alice, bob] = (await sfuCall(browser, 2)) as [Page, Page];
  await expectMediaFlowing(bob, 1);
  await alice.getByRole('button', { name: 'Mute' }).click();
  await expect(bob.getByTestId('muted')).toHaveCount(1);
  await bob.waitForTimeout(1_000); // packets already in flight
  const audio = async () => Object.values(await inboundBytes(bob))[0]?.audio ?? 0;
  const before = await audio();
  await bob.waitForTimeout(2_000);
  expect(await audio()).toBe(before);
  await alice.getByRole('button', { name: 'Unmute' }).click();
  await expect.poll(audio, { timeout: 5_000 }).toBeGreaterThan(before);
});

test('a camera turned on mid-call becomes a new Producer that the others consume', async ({
  browser,
}) => {
  const alice = await openApp(browser);
  const roomId = await join(alice, 'Alice', null);
  const bob = await newPage(browser);
  await bob.addInitScript(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    let denied = false;
    navigator.mediaDevices.getUserMedia = (constraints) => {
      if (!denied && constraints?.video) {
        denied = true;
        return Promise.reject(new DOMException('denied by test', 'NotAllowedError'));
      }
      return original(constraints);
    };
  });
  await bob.goto('/');
  await join(bob, 'Bob', roomId);
  await expectMediaFlowing(alice, 1, ['audio']);
  await bob.getByRole('button', { name: 'Camera on' }).click();
  await expect(alice.getByTestId('camera-off')).toHaveCount(0);
  await expectMediaFlowing(alice, 1, ['video']);
});

test('churn: random joins, leaves and mutes leave exactly the expected mediasoup objects', async ({
  browser,
  request,
}) => {
  test.setTimeout(240_000);
  const seed = Number(process.env.CHURN_SEED ?? Date.now() % 100_000);
  test.info().annotations.push({ type: 'churn-seed', description: String(seed) });
  let state = seed;
  const random = () => (state = (state * 48_271) % 2_147_483_647) / 2_147_483_647;

  const host = await openApp(browser);
  const roomId = await join(host, 'Host', null); // stays, so the room never empties
  const pages = await Promise.all([1, 2, 3, 4].map(() => openApp(browser)));
  const inRoom = new Set<Page>();
  for (let step = 0; step < 24; step++) {
    const page = pages[Math.floor(random() * pages.length)] as Page;
    if (!inRoom.has(page)) {
      await join(page, `C${String(step)}`, roomId);
      inRoom.add(page);
    } else if (random() < 0.3) {
      await page.getByRole('button', { name: /^(Mute|Unmute)$/ }).click();
    } else {
      await page.getByRole('button', { name: 'Leave' }).click();
      await expect(page.getByTestId('room-id')).toHaveCount(0);
      inRoom.delete(page);
    }
    await page.waitForTimeout(random() * 800);
  }

  const members = inRoom.size + 1;
  await expect.poll(() => live(request), { timeout: 15_000 }).toEqual(expected(members));
  for (const page of [host, ...inRoom]) {
    await expectConnected(page, members - 1);
    expect((await resources(page))?.liveLocalTracks).toBe(2);
    // No orphan remote tracks: exactly audio + video of each other member.
    await expect.poll(() => receivedTracks(page)).toBe(2 * (members - 1));
  }
  for (const page of pages.filter((p) => !inRoom.has(p))) {
    expect((await resources(page))?.liveLocalTracks).toBe(0);
  }
  for (const page of [host, ...inRoom]) await page.getByRole('button', { name: 'Leave' }).click();
  await expect.poll(() => live(request)).toEqual(NONE);
});
