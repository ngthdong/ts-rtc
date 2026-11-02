import { execSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';
import { closePages, expectConnected, join, openApp, quality, type Quality } from './helpers.js';

test.afterEach(closePages);

const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;

async function call(browser: Parameters<typeof openApp>[0]): Promise<[Page, Page]> {
  const alice = await openApp(browser);
  const roomId = await join(alice, 'Alice', null);
  const bob = await openApp(browser);
  await join(bob, 'Bob', roomId);
  for (const page of [alice, bob]) await expectConnected(page, 1);
  return [alice, bob];
}

/** The 2 s sample for the only peer, once it has rates (the first sample cannot). */
async function sample(page: Page): Promise<Quality> {
  let q: Quality | undefined;
  await expect
    .poll(async () => (q = Object.values(await quality(page))[0])?.inKbps ?? null)
    .not.toBeNull();
  return q as Quality;
}

test('the overlay shows plausible quality on a local call', async ({ browser }) => {
  const [alice] = await call(browser);
  await expect(alice.getByTestId('quality')).toContainText('kbps');
  await expect.poll(async () => (await sample(alice)).video?.fps ?? 0).toBeGreaterThan(5);
  const q = await sample(alice);
  expect(q.rttMs).toBeLessThan(50); // one machine
  expect(q.lossPct ?? 0).toBeLessThan(1);
  expect(q.inKbps).toBeGreaterThan(30); // at least the audio
  expect(q.outKbps).toBeGreaterThan(30);
  expect(q.video?.width).toBeGreaterThan(0);
  test.info().annotations.push({ type: 'quality', description: JSON.stringify(q) });
});

/**
 * Drops LOSS_INJECTION % (e.g. 5) of all UDP on loopback with iptables: Linux, root or sudo.
 * (tc-netem needs the sch_netem kernel module, which containers often lack.) Opt-in.
 */
const lossPct = Number(process.env.LOSS_INJECTION ?? 0);
test(`injected packet loss shows up at the receiver (${String(lossPct)} %)`, async ({
  browser,
}) => {
  test.skip(!lossPct, 'set LOSS_INJECTION=5 (percent; Linux, root or sudo)');
  test.setTimeout(90_000);
  const sudo = process.getuid?.() === 0 ? '' : 'sudo ';
  const probability = String(lossPct / 100);
  // INPUT, not OUTPUT: a drop in OUTPUT fails sendmsg() with EPERM, which the sender notices.
  const rule = `INPUT -i lo -p udp -m statistic --mode random --probability ${probability} -j DROP`;
  const [alice, bob] = await call(browser);
  await alice.waitForTimeout(10_000); // let bandwidth estimation ramp up first
  const before = await sample(bob);
  execSync(`${sudo}iptables -I ${rule}`);
  try {
    const losses: number[] = [];
    for (let i = 0; i < 8; i++) {
      await alice.waitForTimeout(2_000);
      losses.push((await sample(bob)).lossPct ?? 0);
    }
    const after = await sample(alice);
    test
      .info()
      .annotations.push(
        { type: 'before', description: JSON.stringify(before) },
        { type: 'receiver loss % per 2 s', description: losses.map((l) => l.toFixed(1)).join(' ') },
        { type: 'sender after 16 s', description: JSON.stringify(after) },
      );
    // Audio has no retransmission, so its loss shows; video recovers most of it with NACK/RTX.
    expect(mean(losses)).toBeGreaterThan(lossPct * 0.3);
  } finally {
    execSync(`${sudo}iptables -D ${rule}`);
  }
});
