import { SignalingError } from '@ts-rtc/protocol';
import type { FastifyBaseLogger } from 'fastify';
import type { types } from 'mediasoup';
import type { MediaController, RtpCapabilities, WorkerInfo } from '../media-controller.js';
import { MEDIA_CODECS } from './codecs.js';
import { WorkerPool, type PoolWorker, type WorkerPoolOptions } from './worker-pool.js';

interface RouterEntry {
  router: types.Router;
  slot: PoolWorker;
}

/** One Router per room, placed on the least-loaded Worker. */
export class MediasoupController implements MediaController {
  /** Settled or in flight: a second caller for the same room awaits the same creation. */
  private readonly routers = new Map<string, Promise<RouterEntry>>();
  private readonly created = new Map<string, RouterEntry>();
  private readonly lostListeners: ((roomId: string) => void)[] = [];
  private readonly pool: WorkerPool;

  private constructor(
    options: WorkerPoolOptions,
    private readonly log: FastifyBaseLogger,
  ) {
    this.pool = new WorkerPool(options, log, (dead) => {
      this.workerDied(dead);
    });
  }

  static async start(options: WorkerPoolOptions, log: FastifyBaseLogger) {
    const controller = new MediasoupController(options, log);
    await controller.pool.start();
    return controller;
  }

  get healthy(): boolean {
    return this.pool.healthy;
  }

  ensureRouter(roomId: string): Promise<RtpCapabilities> {
    let entry = this.routers.get(roomId);
    if (!entry) {
      entry = this.createRouter(roomId);
      this.routers.set(roomId, entry);
      const forget = () => {
        if (this.routers.get(roomId) === entry) this.routers.delete(roomId); // retry may succeed
      };
      entry.catch(forget);
    }
    return entry.then(({ router }) => router.rtpCapabilities as unknown as RtpCapabilities);
  }

  closeRouter(roomId: string): void {
    const entry = this.routers.get(roomId);
    if (!entry) return;
    this.routers.delete(roomId);
    // Possibly still being created: close it as soon as it exists.
    entry.then(
      ({ router, slot }) => {
        this.created.delete(roomId);
        if (router.closed) return;
        router.close(); // cascades to its transports, Producers, Consumers
        slot.routers -= 1;
        this.log.info({ roomId, routerId: router.id }, 'router.closed');
      },
      () => undefined,
    );
  }

  onRouterLost(listener: (roomId: string) => void): void {
    this.lostListeners.push(listener);
  }

  async inspect(): Promise<WorkerInfo[]> {
    return Promise.all(
      this.pool.workers.map(async ({ index, worker }) => ({
        index,
        pid: worker.pid,
        routerIds: (await worker.dump()).routerIds,
        usage: { ...(await worker.getResourceUsage()) },
      })),
    );
  }

  close(): void {
    this.pool.close();
  }

  private async createRouter(roomId: string): Promise<RouterEntry> {
    const slot = this.pool.pick();
    if (!slot) throw new SignalingError('UNAVAILABLE', 'no media server available, retry');
    slot.routers += 1;
    try {
      const router = await slot.worker.createRouter({ mediaCodecs: MEDIA_CODECS });
      const entry = { router, slot };
      this.created.set(roomId, entry);
      this.log.info({ roomId, workerPid: slot.worker.pid, routerId: router.id }, 'router.created');
      return entry;
    } catch (err) {
      slot.routers -= 1;
      this.log.warn({ roomId, err }, 'router.create_failed'); // e.g. the Worker died meanwhile
      throw new SignalingError('UNAVAILABLE', 'media server unavailable, retry');
    }
  }

  private workerDied(dead: PoolWorker): void {
    const lost = [...this.created].filter(([, entry]) => entry.slot === dead).map(([id]) => id);
    for (const roomId of lost) {
      this.created.delete(roomId);
      this.routers.delete(roomId);
    }
    this.log.error({ workerPid: dead.worker.pid, roomsAffected: lost }, 'media.worker_died');
    for (const roomId of lost) for (const listener of this.lostListeners) listener(roomId);
  }
}
