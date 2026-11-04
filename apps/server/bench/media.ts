// Worker startup, idle Worker memory; Router, WebRtcTransport, Producer, Consumer creation latency.
// Run: pnpm --filter @ts-rtc/server exec tsx bench/media.ts
import { createWorker } from 'mediasoup';
import { MEDIA_CODECS } from '../src/media/mediasoup/codecs.js';

const quantile = (sorted: number[], q: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? NaN;
const ms = (value: number) => `${value.toFixed(2)} ms`;

const startups: number[] = [];
for (let i = 0; i < 10; i++) {
  const startedAt = performance.now();
  const worker = await createWorker({ logLevel: 'warn' });
  startups.push(performance.now() - startedAt);
  worker.close();
}
startups.sort((a, b) => a - b);

const worker = await createWorker({ logLevel: 'warn' });
const idleKb = (await worker.getResourceUsage()).ru_maxrss;

const creations: number[] = [];
for (let i = 0; i < 1000; i++) {
  const startedAt = performance.now();
  const router = await worker.createRouter({ mediaCodecs: MEDIA_CODECS });
  creations.push(performance.now() - startedAt);
  router.close();
}
creations.sort((a, b) => a - b);
const after = (await worker.getResourceUsage()).ru_maxrss;
const router = await worker.createRouter({ mediaCodecs: MEDIA_CODECS });
const webRtcServer = await worker.createWebRtcServer({
  listenInfos: [{ protocol: 'udp', ip: '127.0.0.1', port: 44_444 }],
});
const transports: number[] = [];
for (let i = 0; i < 1000; i++) {
  const startedAt = performance.now();
  const transport = await router.createWebRtcTransport({ webRtcServer });
  transports.push(performance.now() - startedAt);
  transport.close();
}
transports.sort((a, b) => a - b);

// Producer and Consumer creation: RTP-less (no browser), like the integration tests.
const send = await router.createWebRtcTransport({ webRtcServer });
const recv = await router.createWebRtcTransport({ webRtcServer });
const opus = { mimeType: 'audio/opus', payloadType: 111, clockRate: 48_000, channels: 2 };
const producing: number[] = [];
const consuming: number[] = [];
for (let i = 0; i < 1000; i++) {
  let startedAt = performance.now();
  const producer = await send.produce({
    kind: 'audio',
    rtpParameters: { mid: String(i), codecs: [opus], encodings: [{ ssrc: 10_000 + i }] },
  });
  producing.push(performance.now() - startedAt);
  startedAt = performance.now();
  await recv.consume({
    producerId: producer.id,
    rtpCapabilities: router.rtpCapabilities,
    paused: true,
  });
  consuming.push(performance.now() - startedAt);
  producer.close(); // closes its Consumer too
}
producing.sort((a, b) => a - b);
consuming.sort((a, b) => a - b);
worker.close();

console.log(
  `Worker startup (10): p50 ${ms(quantile(startups, 0.5))}, max ${ms(startups.at(-1) ?? NaN)}`,
);
console.log(
  `Idle Worker max RSS: ${(idleKb / 1024).toFixed(1)} MiB (after 1000 Routers: ${(after / 1024).toFixed(1)} MiB)`,
);
console.log(
  `createRouter (1000): p50 ${ms(quantile(creations, 0.5))}, p99 ${ms(quantile(creations, 0.99))}, max ${ms(creations.at(-1) ?? NaN)}`,
);
console.log(
  `createWebRtcTransport (1000): p50 ${ms(quantile(transports, 0.5))}, p99 ${ms(quantile(transports, 0.99))}`,
);
console.log(
  `produce (1000): p50 ${ms(quantile(producing, 0.5))}, p99 ${ms(quantile(producing, 0.99))}`,
);
console.log(
  `consume (1000): p50 ${ms(quantile(consuming, 0.5))}, p99 ${ms(quantile(consuming, 0.99))}`,
);
