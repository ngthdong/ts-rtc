import { expect, test, type Browser, type Page } from '@playwright/test';

type Bytes = Record<string, { audio: number; video: number }>;

declare global {
  interface Window {
    __tsRtc?: {
      inboundBytes(): Promise<Bytes>;
      paths(): Promise<Record<string, { local: string; remote: string; protocol: string } | null>>;
    };
  }
}

async function openApp(browser: Browser): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto('/');
  await expect(page.getByTestId('status')).toHaveText('ready');
  return page;
}

function inboundBytes(page: Page): Promise<Bytes> {
  return page.evaluate(async () => {
    if (!window.__tsRtc) throw new Error('test hook missing (dev build only)');
    return window.__tsRtc.inboundBytes();
  });
}

// The point of the test: media must actually flow, not just signaling complete.
async function expectMediaFlowing(page: Page): Promise<void> {
  const before = await inboundBytes(page);
  await page.waitForTimeout(2_000);
  const after = await inboundBytes(page);
  const peers = Object.keys(after);
  expect(peers).toHaveLength(1);
  for (const id of peers) {
    expect(after[id]?.audio ?? 0).toBeGreaterThan(before[id]?.audio ?? 0);
    expect(after[id]?.video ?? 0).toBeGreaterThan(before[id]?.video ?? 0);
  }
}

test('two browsers exchange audio and video, and hang up cleanly', async ({ browser }) => {
  const alice = await openApp(browser);
  await alice.getByLabel('Your name').fill('Alice');
  await alice.getByRole('button', { name: 'Create room' }).click();
  const roomId = (await alice.getByTestId('room-id').textContent()) ?? '';

  const bob = await openApp(browser);
  await bob.getByLabel('Your name').fill('Bob');
  await bob.getByLabel('Room ID').fill(roomId);
  await bob.getByRole('button', { name: 'Join' }).click();

  for (const page of [alice, bob]) {
    await expect(page.getByTestId('peer-state')).toHaveText('connected', { timeout: 10_000 });
  }
  await expectMediaFlowing(alice);
  await expectMediaFlowing(bob);

  const paths = await alice.evaluate(() => window.__tsRtc?.paths());
  const path = Object.values(paths ?? {})[0];
  expect(path).toBeTruthy();
  test.info().annotations.push({ type: 'selected-path', description: JSON.stringify(path) });

  await bob.getByRole('button', { name: 'Leave' }).click();
  await expect(alice.getByTestId('remote')).toHaveCount(0);
});
