import { SignalingError } from '@ts-rtc/protocol';
import type { FastifyBaseLogger } from 'fastify';
import type { types } from 'mediasoup';
import type {
  Direction,
  MediaController,
  RtpCapabilities,
  TransportParams,
  WorkerInfo,
} from '../media-controller.js';
import { MEDIA_CODECS } from './codecs.js';
import { TransportService, type TransportOptions } from './transport-service.js';
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
  private readonly transports: TransportService;
  // Transport, Producer and Consumer operations are the TransportService's, exposed as is.
  readonly connectTransport: MediaController['connectTransport'];
  readonly produce: MediaController['produce'];
  readonly consume: MediaController['consume'];
  readonly resumeConsumer: MediaController['resumeConsumer'];
  readonly pauseProducer: MediaController['pauseProducer'];
  readonly producers: MediaController['producers'];
  readonly closeParticipant: MediaController['closeParticipant'];
  readonly onEvent: MediaController['onEvent'];
  readonly counts: MediaController['counts'];

  private constructor(
    options: WorkerPoolOptions & TransportOptions,
    private readonly log: FastifyBaseLogger,
  ) {
    this.pool = new WorkerPool(options, log, (dead) => {
      this.workerDied(dead);
    });
    const transports = (this.transports = new TransportService(options, log));
    this.connectTransport = transports.connect.bind(transports);
    this.produce = transports.produce.bind(transports);
    this.consume = transports.consume.bind(transports);
    this.resumeConsumer = transports.resumeConsumer.bind(transports);
    this.pauseProducer = transports.pauseProducer.bind(transports);
    this.producers = transports.producers.bind(transports);
    this.closeParticipant = transports.closeParticipant.bind(transports);
    this.onEvent = transports.onEvent.bind(transports);
    this.counts = transports.counts.bind(transports);
  }

  static async start(options: WorkerPoolOptions & TransportOptions, log: FastifyBaseLogger) {
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
        this.transports.forgetRoom(roomId);
        if (router.closed) return;
        router.close(); // cascades to its transports, Producers, Consumers
        slot.routers -= 1;
        this.log.info({ roomId, routerId: router.id }, 'router.closed');
      },
      () => undefined,
    );
  }

  async createTransport(
    roomId: string,
    participantId: string,
    direction: Direction,
  ): Promise<TransportParams> {
    const entry = this.created.get(roomId);
    if (!entry) throw new SignalingError('INVALID_STATE', 'the room has no media router');
    const { router, slot } = entry;
    return this.transports.create(router, slot.webRtcServer, roomId, participantId, direction);
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
      this.transports.forgetRoom(roomId);
    }
    this.log.error({ workerPid: dead.worker.pid, roomsAffected: lost }, 'media.worker_died');
    for (const roomId of lost) for (const listener of this.lostListeners) listener(roomId);
  }
}
