import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { closePages, closeTab, inboundBytes, join, newPage, openApp } from './helpers.js';

test.afterEach(closePages);

// Must match the server's PORT, as in playwright.config.ts.
const apiPort = process.env.PORT ?? '4000';

async function producers(request: APIRequestContext): Promise<number> {
  const response = await request.get(`http://127.0.0.1:${apiPort}/debug/media`);
  return ((await response.json()) as { live: { producers: number } }).live.producers;
}

async function room(browser: Browser, names: string[]): Promise<Page[]> {
  const pages = [await openApp(browser)];
  const roomId = await join(pages[0] as Page, names[0] ?? 'A', null);
  for (const name of names.slice(1)) {
    const page = await openApp(browser);
    await join(page, name, roomId);
    pages.push(page);
  }
  return pages;
}

/** Screen video bytes received by `page` (from whoever shares). */
async function screenBytes(page: Page): Promise<number> {
  const bytes = await inboundBytes(page);
  return Object.entries(bytes).find(([tile]) => tile.endsWith('#screen'))?.[1].video ?? 0;
}

test('share, stop from the app: a separate screen tile appears and goes; the camera stays', async ({
  browser,
  request,
}) => {
  const [alice, bob] = (await room(browser, ['Alice', 'Bob'])) as [Page, Page];
  await expect.poll(() => producers(request)).toBe(4); // two mics, two cameras
  await alice.getByRole('button', { name: 'Share screen' }).click();
  await expect(bob.getByTestId('screen')).toContainText('Alice is sharing their screen');
  await expect.poll(() => screenBytes(bob)).toBeGreaterThan(0);
  const before = await screenBytes(bob);
  await expect.poll(() => screenBytes(bob)).toBeGreaterThan(before); // still flowing
  expect(await producers(request)).toBe(5);

  await alice.getByRole('button', { name: 'Stop sharing' }).click();
  await expect(bob.getByTestId('screen')).toHaveCount(0);
  await expect(bob.getByTestId('remote')).toHaveCount(1); // Alice's camera tile is untouched
  await expect.poll(() => producers(request)).toBe(4);
});

test("the browser's own Stop sharing button closes the Producer everywhere within 1 s", async ({
  browser,
  request,
}) => {
  const [alice, bob] = (await room(browser, ['Alice', 'Bob'])) as [Page, Page];
  await alice.getByRole('button', { name: 'Share screen' }).click();
  await expect(bob.getByTestId('screen')).toHaveCount(1);
  await expect.poll(() => producers(request)).toBe(5);
  await alice.evaluate(() => {
    window.__tsRtc?.endScreenTrack(); // track stopped + 'ended', as the native button does
  });
  await expect.poll(() => producers(request), { timeout: 1_000 }).toBe(4);
  await expect(bob.getByTestId('screen')).toHaveCount(0);
  await expect(alice.getByRole('button', { name: 'Share screen' })).toBeVisible();
});

test('one sharer per room; the lock is released when the sharer leaves', async ({
  browser,
  request,
}) => {
  const [alice, bob, carol] = (await room(browser, ['Alice', 'Bob', 'Carol'])) as [
    Page,
    Page,
    Page,
  ];
  await alice.getByRole('button', { name: 'Share screen' }).click();
  await expect(carol.getByTestId('screen')).toHaveCount(1);
  await bob.getByRole('button', { name: 'Share screen' }).click();
  await expect(bob.getByRole('alert')).toHaveText('Alice is already sharing.');
  await expect(bob.getByRole('button', { name: 'Share screen' })).toBeVisible();

  await closeTab(alice); // the sharer leaves: the Producer and the lock go with it
  await expect(carol.getByTestId('screen')).toHaveCount(0);
  await expect.poll(() => producers(request)).toBe(4);
  await bob.getByRole('button', { name: 'Share screen' }).click();
  await expect(carol.getByTestId('screen')).toContainText('Bob is sharing');
});

test('a denied or cancelled share shows a message and asks the server for nothing', async ({
  browser,
  request,
}) => {
  const alice = await newPage(browser);
  await alice.addInitScript(() => {
    navigator.mediaDevices.getDisplayMedia = () =>
      Promise.reject(new DOMException('denied by test', 'NotAllowedError'));
  });
  await alice.goto('/');
  await join(alice, 'Alice', null);
  await expect.poll(() => producers(request)).toBe(2);
  await alice.getByRole('button', { name: 'Share screen' }).click();
  await expect(alice.getByRole('alert')).toHaveText('Screen sharing was cancelled or not allowed.');
  expect(await producers(request)).toBe(2);
});
