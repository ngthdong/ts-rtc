import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

type Bytes = Record<string, { audio: number; video: number }>;

/** Mirrors PeerQuality in apps/web/src/stats/quality.ts. */
export interface Quality {
  rttMs: number | null;
  lossPct: number | null;
  jitterMs: number | null;
  inKbps: number | null;
  outKbps: number | null;
  video: { width: number; height: number; fps: number } | null;
  limitation: string | null;
  path: { local: string; remote: string; protocol: string; rttMs: number | null } | null;
}

declare global {
  interface Window {
    __tsRtc?: {
      inboundBytes(): Promise<Bytes>;
      quality(): Record<string, Quality>;
      resources(): { openConnections: number; liveLocalTracks: number };
    };
  }
}

const contexts: BrowserContext[] = [];

/** Each simulated user gets its own context (own cookies, own fake devices). */
export async function newPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  contexts.push(context);
  return context.newPage();
}

/** Call from test.afterEach: a call left running would eat the CPU of the next test. */
export async function closePages(): Promise<void> {
  await Promise.all(contexts.splice(0).map((context) => context.close()));
}

export async function openApp(browser: Browser, path = '/'): Promise<Page> {
  const page = await newPage(browser);
  await page.goto(path);
  await expect(page.getByTestId('status')).toHaveText('ready');
  return page;
}

/** Joins `roomId`, or creates a room when it is null; returns the room id. */
export async function join(page: Page, name: string, roomId: string | null): Promise<string> {
  await page.getByLabel('Your name').fill(name);
  if (roomId) {
    await page.getByLabel('Room ID').fill(roomId);
    await page.getByRole('button', { name: 'Join' }).click();
  } else {
    await page.getByRole('button', { name: 'Create room' }).click();
  }
  return (await page.getByTestId('room-id').textContent()) ?? '';
}

export function inboundBytes(page: Page): Promise<Bytes> {
  return page.evaluate(async () => {
    if (!window.__tsRtc) throw new Error('test hook missing (dev build only)');
    return window.__tsRtc.inboundBytes();
  });
}

export function resources(page: Page) {
  return page.evaluate(() => window.__tsRtc?.resources());
}

export function quality(page: Page): Promise<Record<string, Quality>> {
  return page.evaluate(() => window.__tsRtc?.quality() ?? {});
}

/** All `peers` tiles connected: the page has a working connection to every other member. */
export async function expectConnected(page: Page, peers: number): Promise<void> {
  await expect(page.getByTestId('remote')).toHaveCount(peers, { timeout: 15_000 });
  const states = page.getByTestId('peer-state');
  for (let i = 0; i < peers; i++) {
    await expect(states.nth(i)).toHaveText('connected', { timeout: 15_000 });
  }
}

/** The point of the tests: media must actually flow from every peer, not just signaling. */
export async function expectMediaFlowing(
  page: Page,
  peers: number,
  kinds: ('audio' | 'video')[] = ['audio', 'video'],
): Promise<void> {
  const before = await inboundBytes(page);
  await page.waitForTimeout(2_000);
  const after = await inboundBytes(page);
  expect(Object.keys(after)).toHaveLength(peers);
  for (const [id, bytes] of Object.entries(after)) {
    for (const kind of kinds) expect(bytes[kind]).toBeGreaterThan(before[id]?.[kind] ?? 0);
  }
}
