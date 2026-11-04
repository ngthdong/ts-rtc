import { cpus } from 'node:os';
import { test, type Page } from '@playwright/test';
import { closePages, expectConnected, join, openApp, quality } from './helpers.js';

test.afterEach(closePages);

/** Busy fraction of all host cores between two calls: browsers, server and Vite together. */
function cpuMeter() {
  const read = () =>
    cpus().reduce(
      (acc, { times }) => {
        const total = times.user + times.nice + times.sys + times.idle + times.irq;
        return { busy: acc.busy + total - times.idle, total: acc.total + total };
      },
      { busy: 0, total: 0 },
    );
  const start = read();
  return () => {
    const end = read();
    return (100 * (end.busy - start.busy)) / (end.total - start.total);
  };
}

const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / (values.length || 1);

/**
 * Mesh vs SFU baseline (Stage 19 compares). Opt-in: BENCH=1; 6 Mesh participants also need
 * MESH_MAX_PARTICIPANTS=6 on the server. Numbers are per participant, averaged over 10 s.
 */
for (const mode of ['mesh', 'sfu'] as const)
  for (const size of [2, 4, 6]) {
    test(`${mode} baseline: ${String(size)} participants`, async ({ browser }) => {
      test.skip(!process.env.BENCH, 'set BENCH=1');
      test.setTimeout(120_000);
      const pages: Page[] = [await openApp(browser, `/?mode=${mode}`)];
      const roomId = await join(pages[0] as Page, 'B0', null);
      for (let i = 1; i < size; i++) {
        const page = await openApp(browser, `/?mode=${mode}`);
        await join(page, `B${String(i)}`, roomId);
        pages.push(page);
      }
      for (const page of pages) await expectConnected(page, size - 1);
      await pages[0]?.waitForTimeout(30_000); // past the bandwidth-estimation ramp-up

      const cpu = cpuMeter();
      const out: number[] = [];
      const inbound: number[] = [];
      const fps: number[] = [];
      const height: number[] = [];
      const limited: Record<string, number> = {};
      for (let round = 0; round < 5; round++) {
        await pages[0]?.waitForTimeout(2_000);
        for (const page of pages) {
          const peers = Object.values(await quality(page));
          out.push(peers.reduce((sum, q) => sum + (q.outKbps ?? 0), 0));
          inbound.push(peers.reduce((sum, q) => sum + (q.inKbps ?? 0), 0));
          for (const q of peers) {
            if (q.video) fps.push(q.video.fps);
            if (q.video) height.push(q.video.height);
            const reason = q.limitation ?? 'n/a';
            limited[reason] = (limited[reason] ?? 0) + 1;
          }
        }
      }
      const result = {
        mode,
        participants: size,
        encodersPerBrowser: mode === 'mesh' ? size - 1 : 1,
        outKbpsPerBrowser: Math.round(mean(out)),
        inKbpsPerBrowser: Math.round(mean(inbound)),
        receivedHeight: Math.round(mean(height)),
        receivedFps: Math.round(mean(fps)),
        limitation: limited,
        hostCpuPct: Math.round(cpu()),
        hostCores: cpus().length,
      };
      test.info().annotations.push({ type: 'baseline', description: JSON.stringify(result) });
      console.log(JSON.stringify(result));
    });
  }
