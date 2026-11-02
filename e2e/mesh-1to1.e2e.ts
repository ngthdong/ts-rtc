import { expect, test } from '@playwright/test';
import { closePages, expectConnected, expectMediaFlowing, join, openApp } from './helpers.js';

test.afterEach(closePages);

for (const relay of [false, true]) {
  const name = relay ? 'through TURN only (relay-relay)' : 'directly';
  test(`two browsers exchange audio and video ${name}, then hang up`, async ({ browser }) => {
    test.skip(
      relay && !process.env.TURN_SECRET,
      'needs coturn: set TURN_SECRET, docker compose up',
    );
    const path = relay ? '/?relay' : '/';
    const alice = await openApp(browser, path);
    const roomId = await join(alice, 'Alice', null);
    const bob = await openApp(browser, path);
    await join(bob, 'Bob', roomId);

    for (const page of [alice, bob]) await expectConnected(page, 1);
    await expectMediaFlowing(alice, 1);
    await expectMediaFlowing(bob, 1);

    // Record which path the call took, so CI history shows it.
    const paths = await alice.evaluate(() => window.__tsRtc?.paths());
    const selected = Object.values(paths ?? {})[0];
    expect(selected).toBeTruthy();
    if (relay) expect(selected).toMatchObject({ local: 'relay', remote: 'relay' });
    test.info().annotations.push({ type: 'selected-path', description: JSON.stringify(selected) });

    await bob.getByRole('button', { name: 'Leave' }).click();
    await expect(alice.getByTestId('remote')).toHaveCount(0);
  });
}
