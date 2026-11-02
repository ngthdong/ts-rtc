import type { FastifyBaseLogger } from 'fastify';
import { createWorker, type types } from 'mediasoup';

export interface WorkerPoolOptions {
  count: number;
  /** Where the WebRtcServers listen, and the address put in ICE candidates (behind NAT). */
  listenIp: string;
  announcedAddress: string | undefined;
  /** Worker i listens on portBase + i, UDP and TCP: one fixed port per Worker to open. */
  portBase: number;
  restartDelayMs: number;
  maxRestartsPerMinute: number;
}

export interface PoolWorker {
  index: number;
  worker: types.Worker;
  webRtcServer: types.WebRtcServer;
  routers: number;
}

const LOG_TAGS: types.WorkerLogTag[] = [
  'info',
  'ice',
  'dtls',
  'rtp',
  'srtp',
  'rtcp',
  'bwe',
  'score',
  'simulcast',
];

/** mediasoup-worker subprocesses, one WebRtcServer each, restarted when they die. */
export class WorkerPool {
  healthy = true;
  private readonly slots: (PoolWorker | undefined)[] = [];
  private restarts: number[] = [];
  private closed = false;

  constructor(
    private readonly options: WorkerPoolOptions,
    private readonly log: FastifyBaseLogger,
    private readonly onDied: (dead: PoolWorker) => void,
  ) {}

  async start(): Promise<void> {
    await Promise.all(Array.from({ length: this.options.count }, (_, i) => this.spawn(i)));
  }

  get workers(): PoolWorker[] {
    return this.slots.filter((slot) => slot !== undefined);
  }

  /** The live Worker with the fewest Routers; the lowest index wins a tie. */
  pick(): PoolWorker | undefined {
    return this.workers.reduce<PoolWorker | undefined>(
      (best, slot) => (!best || slot.routers < best.routers ? slot : best),
      undefined,
    );
  }

  close(): void {
    this.closed = true;
    for (const slot of this.workers) slot.worker.close(); // a deliberate close emits no 'died'
  }

  private async spawn(index: number): Promise<void> {
    const startedAt = performance.now();
    const worker = await createWorker({ logLevel: 'warn', logTags: LOG_TAGS });
    const { listenIp: ip, announcedAddress, portBase } = this.options;
    const listen = { ip, port: portBase + index, ...(announcedAddress && { announcedAddress }) };
    const webRtcServer = await worker.createWebRtcServer({
      listenInfos: [
        { protocol: 'udp', ...listen },
        { protocol: 'tcp', ...listen },
      ],
    });
    const slot: PoolWorker = { index, worker, webRtcServer, routers: 0 };
    this.slots[index] = slot;
    worker.on('died', (err) => {
      this.died(slot, err);
    });
    const ms = Math.round(performance.now() - startedAt);
    this.log.info({ workerPid: worker.pid, index, port: listen.port, ms }, 'worker.started');
  }

  private died(slot: PoolWorker, err: Error): void {
    this.slots[slot.index] = undefined;
    this.log.error({ workerPid: slot.worker.pid, index: slot.index, err }, 'worker.died');
    this.onDied(slot);
    if (this.closed) return;
    const now = Date.now();
    this.restarts = this.restarts.filter((at) => now - at < 60_000);
    if (this.restarts.length >= this.options.maxRestartsPerMinute) {
      this.healthy = false; // a crash loop: stop restarting, let the orchestrator replace us
      this.log.error({ restarts: this.restarts.length }, 'worker.restart_storm');
      return;
    }
    this.restarts.push(now);
    setTimeout(() => {
      if (this.closed) return;
      this.spawn(slot.index).catch((spawnErr: unknown) => {
        this.healthy = false;
        this.log.error({ err: spawnErr, index: slot.index }, 'worker.restart_failed');
      });
    }, this.options.restartDelayMs);
  }
}
