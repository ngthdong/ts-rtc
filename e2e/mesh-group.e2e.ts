import { expect, test, type Page } from '@playwright/test';
import {
  closePages,
  expectConnected,
  expectMediaFlowing,
  join,
  newPage,
  openApp,
  resources,
} from './helpers.js';

test.afterEach(closePages);

const MESH = '/?mode=mesh'; // new rooms default to the SFU

test('four browsers in a full mesh: everyone receives everyone; mute is visible', async ({
  browser,
}) => {
  const pages = [await openApp(browser, MESH)];
  const roomId = await join(pages[0] as Page, 'P0', null);
  for (let i = 1; i < 4; i++) {
    const page = await openApp(browser, MESH);
    await join(page, `P${String(i)}`, roomId);
    pages.push(page);
  }
  for (const page of pages) await expectConnected(page, 3);
  for (const page of pages) await expectMediaFlowing(page, 3);
  for (const page of pages) {
    expect(await resources(page)).toEqual({ openConnections: 3, liveLocalTracks: 2 });
  }

  const [p0, p1] = pages as [Page, Page];
  await p0.getByRole('button', { name: 'Mute' }).click();
  await expect(p1.getByTestId('muted')).toHaveCount(1);
});

test('three browsers joining at the same moment all connect', async ({ browser }) => {
  const host = await openApp(browser, MESH);
  const roomId = await join(host, 'Host', null);
  const others = await Promise.all([1, 2, 3].map(() => openApp(browser, MESH)));
  await Promise.all(others.map((page, i) => join(page, `J${String(i)}`, roomId)));
  for (const page of [host, ...others]) await expectConnected(page, 3);
});

test('turning the camera on mid-call renegotiates and video starts flowing', async ({
  browser,
}) => {
  const alice = await openApp(browser, MESH);
  const roomId = await join(alice, 'Alice', null);
  // Bob's first getUserMedia with video fails, so he joins audio-only.
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
  await bob.goto(MESH);
  await join(bob, 'Bob', roomId);
  await expectConnected(alice, 1);
  await expect(alice.getByTestId('camera-off')).toHaveCount(1);

  await bob.getByRole('button', { name: 'Camera on' }).click();
  await expect(alice.getByTestId('camera-off')).toHaveCount(0);
  await expectMediaFlowing(alice, 1, ['video']);
});

test('churn: random joins and leaves leave no peer connection or track behind', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const seed = Number(process.env.CHURN_SEED ?? Date.now() % 100_000);
  test.info().annotations.push({ type: 'churn-seed', description: String(seed) });
  let state = seed;
  const random = () => (state = (state * 48_271) % 2_147_483_647) / 2_147_483_647;

  const host = await openApp(browser, MESH);
  const roomId = await join(host, 'Host', null); // stays, so the room never empties
  const pages = await Promise.all([1, 2, 3].map(() => openApp(browser, MESH)));
  const inRoom = new Set<Page>();
  for (let step = 0; step < 20; step++) {
    const page = pages[Math.floor(random() * pages.length)] as Page;
    if (inRoom.has(page)) {
      await page.getByRole('button', { name: 'Leave' }).click();
      await expect(page.getByTestId('room-id')).toHaveCount(0);
      inRoom.delete(page);
    } else {
      await join(page, `C${String(step)}`, roomId);
      inRoom.add(page);
    }
    await page.waitForTimeout(random() * 800);
  }

  const members = inRoom.size + 1;
  for (const page of [host, ...inRoom]) {
    await expectConnected(page, members - 1);
    expect(await resources(page)).toEqual({ openConnections: members - 1, liveLocalTracks: 2 });
  }
  for (const page of pages.filter((p) => !inRoom.has(p))) {
    expect(await resources(page)).toEqual({ openConnections: 0, liveLocalTracks: 0 });
  }
});
