import { execSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';
import {
  closePages,
  expectConnected,
  expectMediaFlowing,
  openApp,
  PASSWORD,
  signUp,
} from './helpers.js';

test.afterEach(closePages);

/** Alice creates a private room and adds Bob; Bob joins; both see and hear each other. */
async function privateCall(alice: Page, bob: Page, bobEmail: string): Promise<string> {
  await alice.getByLabel('Private').check();
  await alice.getByRole('button', { name: 'Create room' }).click();
  const roomId = (await alice.getByTestId('room-id').textContent()) ?? '';
  await alice.getByLabel('Member email').fill(bobEmail);
  await alice.getByRole('button', { name: 'Add member' }).click();
  await expect(alice.getByRole('status')).toContainText('can join now');
  await bob.getByLabel('Room ID').fill(roomId);
  await bob.getByRole('button', { name: 'Join' }).click();
  for (const page of [alice, bob]) {
    await expectConnected(page, 1);
    await expectMediaFlowing(page, 1);
  }
  return roomId;
}

async function tryJoin(page: Page, roomId: string, error: RegExp): Promise<void> {
  await page.getByLabel('Room ID').fill(roomId);
  await page.getByRole('button', { name: 'Join' }).click();
  await expect(page.getByRole('alert')).toContainText(error);
  await expect(page.getByTestId('room-id')).toHaveCount(0);
}

test('a private room admits the members its owner adds, and nobody else', async ({ browser }) => {
  const [alice, bob, carol] = await Promise.all([1, 2, 3].map(() => openApp(browser)));
  if (!alice || !bob || !carol) throw new Error('unreachable');
  await signUp(alice, 'Alice');
  const bobEmail = await signUp(bob, 'Bob');
  await signUp(carol, 'Carol');
  const roomId = await privateCall(alice, bob, bobEmail);
  await tryJoin(carol, roomId, /private room/);
  await expect(bob.locator('figcaption').first()).toContainText('Bob (you)'); // account name
});

test('a reload keeps the session (sessionStorage); signing out ends it', async ({ browser }) => {
  const page = await openApp(browser);
  await signUp(page, 'Rita');
  await page.reload();
  await expect(page.getByTestId('status')).toHaveText('ready');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});

/**
 * Failure injection, opt-in: PG_STOP / PG_START are the commands that stop and start this
 * environment's Postgres, e.g. `docker compose stop postgres` / `docker compose start postgres`.
 */
test('Postgres down: the call goes on; sign-in and joins fail, then recover', async ({
  browser,
}) => {
  const { PG_STOP, PG_START } = process.env;
  test.skip(!PG_STOP || !PG_START, 'set PG_STOP and PG_START to stop and start Postgres');
  test.setTimeout(120_000);
  const [alice, bob, carol, late] = await Promise.all([1, 2, 3, 4].map(() => openApp(browser)));
  if (!alice || !bob || !carol || !late) throw new Error('unreachable');
  await signUp(alice, 'Alice');
  const bobEmail = await signUp(bob, 'Bob');
  await signUp(carol, 'Carol');
  const roomId = await privateCall(alice, bob, bobEmail);

  execSync(PG_STOP ?? '');
  try {
    await alice.waitForTimeout(5_000);
    for (const page of [alice, bob]) await expectMediaFlowing(page, 1); // no database on the media path
    await tryJoin(carol, roomId, /database unavailable/); // fails closed, and says why
    await late.getByLabel('Email').fill(bobEmail);
    await late.getByLabel('Password').fill(PASSWORD);
    await late.getByRole('button', { name: 'Sign in' }).click();
    await expect(late.getByRole('alert')).toContainText('database unavailable');
  } finally {
    execSync(PG_START ?? '');
  }
  await expect(async () => {
    await late.getByRole('button', { name: 'Sign in' }).click();
    await expect(late.getByTestId('status')).toHaveText('ready', { timeout: 2_000 });
  }).toPass({ timeout: 30_000 }); // the pool reconnects by itself
  await tryJoin(carol, roomId, /private room/); // back to the normal answer
});
