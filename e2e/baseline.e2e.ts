import { cpus } from 'node:os';
import { test, type APIRequestContext, type Page } from '@playwright/test';
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

// Must match the server's PORT, as in playwright.config.ts.
const apiPort = process.env.PORT ?? '4000';

/**
 * CPU of all mediasoup Workers between two calls, in % of one core (GET /debug/media, dev
 * builds only): ru_utime + ru_stime are milliseconds of CPU time per Worker.
 */
async function workerCpuMeter(request: APIRequestContext) {
  const read = async () => {
    const response = await request.get(`http://127.0.0.1:${apiPort}/debug/media`);
    const { workers } = (await response.json()) as {
      workers: { usage: Record<string, number> }[];
    };
    const cpuMs = workers.reduce(
      (sum, w) => sum + (w.usage.ru_utime ?? 0) + (w.usage.ru_stime ?? 0),
      0,
    );
    return { cpuMs, at: Date.now() };
  };
  const start = await read();
  return async () => {
    const end = await read();
    return (100 * (end.cpuMs - start.cpuMs)) / (end.at - start.at);
  };
}

/** The camera layers `page` sends, by rid, with bytes sent so far (SFU rooms; Mesh: none). */
function sendLayers(page: Page) {
  return page.evaluate(() => window.__tsRtc?.sendLayers() ?? []);
}

const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / (values.length || 1);

/** How each mode opens the app: sfu-single-layer is the SFU with simulcast off. */
const PATHS = {
  mesh: '/?mode=mesh',
  sfu: '/?mode=sfu',
  'sfu-single-layer': '/?mode=sfu&simulcast=off',
} as const;

/**
 * Mesh vs SFU baseline, the SFU with and without simulcast. Opt-in: BENCH=1;
 * 6 Mesh participants also need MESH_MAX_PARTICIPANTS=6 on the server. Numbers are per
 * participant, averaged over 10 s.
 */
for (const mode of ['mesh', 'sfu', 'sfu-single-layer'] as const)
  for (const size of [2, 4, 6]) {
    test(`${mode} baseline: ${String(size)} participants`, async ({ browser, request }) => {
      test.skip(!process.env.BENCH, 'set BENCH=1');
      test.setTimeout(120_000);
      const pages: Page[] = [await openApp(browser, PATHS[mode])];
      const roomId = await join(pages[0] as Page, 'B0', null);
      for (let i = 1; i < size; i++) {
        const page = await openApp(browser, PATHS[mode]);
        await join(page, `B${String(i)}`, roomId);
        pages.push(page);
      }
      for (const page of pages) await expectConnected(page, size - 1);
      await pages[0]?.waitForTimeout(30_000); // past the bandwidth-estimation ramp-up

      const cpu = cpuMeter();
      const workerCpu = await workerCpuMeter(request);
      const layersBefore = await sendLayers(pages[0] as Page);
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
      // Layers actually being sent: bytes still rising over the window (the first browser's).
      const layersAfter = await sendLayers(pages[0] as Page);
      const sentLayers = layersAfter.filter(
        (l) => l.bytes > (layersBefore.find((b) => b.rid === l.rid)?.bytes ?? 0),
      ).length;
      const result = {
        mode,
        participants: size,
        encodersPerBrowser: mode === 'mesh' ? size - 1 : 1,
        outKbpsPerBrowser: Math.round(mean(out)),
        inKbpsPerBrowser: Math.round(mean(inbound)),
        receivedHeight: Math.round(mean(height)),
        receivedFps: Math.round(mean(fps)),
        limitation: limited,
        sentLayers: mode === 'mesh' ? null : sentLayers,
        hostCpuPct: Math.round(cpu()),
        workerCpuPct: Math.round(await workerCpu()),
        hostCores: cpus().length,
      };
      test.info().annotations.push({ type: 'baseline', description: JSON.stringify(result) });
      console.log(JSON.stringify(result));
    });
  }
