import { SignalingError, type ProducerInfo, type ProducerSource } from '@ts-rtc/protocol';
import type { FastifyBaseLogger } from 'fastify';
import { errors, type types } from 'mediasoup';
import type {
  ConsumerParams,
  Direction,
  Json,
  MediaController,
  MediaCounts,
  MediaEvent,
  MediaKind,
  TransportCloseReason,
  TransportParams,
} from '../media-controller.js';

export interface TransportOptions {
  /** Consuming your own Producer: the diagnostics loopback. Off in production. */
  allowLoopback: boolean;
  /** A transport not DTLS-connected this long after creation is closed. */
  connectDeadlineMs: number;
  /** ICE disconnected this long closes the transport. */
  iceDisconnectedMs: number;
}

/** Audio + video of up to 9 others, plus 2 screens later (2 × (10 − 1) + 2). */
const MAX_CONSUMERS = 20;

/** Everything one participant owns; only the owner may use it. */
interface Party {
  roomId: string;
  transports: Map<string, types.WebRtcTransport>;
  connected: Set<string>;
  producers: Map<ProducerSource, types.Producer>;
  consumers: Map<string, types.Consumer>;
}

type Listener = Parameters<MediaController['onEvent']>[0];

/** Each participant's transports, Producers and Consumers, and who may use which. */
export class TransportService {
  private readonly parties = new Map<string, Party>();
  /** Every open Producer, by id: what consume looks up (room check, owner). */
  private readonly producerIndex = new Map<string, { roomId: string; info: ProducerInfo }>();
  private readonly live: MediaCounts = { transports: 0, producers: 0, consumers: 0 };
  private readonly listeners: Listener[] = [];

  constructor(
    private readonly options: TransportOptions,
    private readonly log: FastifyBaseLogger,
  ) {}

  counts(): MediaCounts {
    return { ...this.live };
  }

  onEvent(listener: Listener): void {
    this.listeners.push(listener);
  }

  /** The room a participant's media lives in, while it has any. */
  roomOf(participantId: string): string | undefined {
    return this.parties.get(participantId)?.roomId;
  }

  producers(roomId: string): ProducerInfo[] {
    return [...this.producerIndex.values()].filter((p) => p.roomId === roomId).map((p) => p.info);
  }

  async create(
    router: types.Router,
    webRtcServer: types.WebRtcServer,
    roomId: string,
    participantId: string,
    direction: Direction,
  ): Promise<TransportParams> {
    const party: Party = this.parties.get(participantId) ?? {
      roomId,
      transports: new Map(),
      connected: new Set(),
      producers: new Map(),
      consumers: new Map(),
    };
    this.parties.set(participantId, party);
    for (const existing of party.transports.values()) {
      if (existing.appData.direction === direction) {
        throw new SignalingError('CONFLICT', `${direction} transport exists: ${existing.id}`);
      }
    }
    const transport = await router.createWebRtcTransport({
      webRtcServer,
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      initialAvailableOutgoingBitrate: 1_000_000,
      appData: { participantId, direction },
    });
    if (direction === 'send') await transport.setMaxIncomingBitrate(3_000_000);
    party.transports.set(transport.id, transport);
    this.watch(transport, roomId, participantId, party);
    const candidates = transport.iceCandidates.map((c) => `${c.protocol} ${c.address}:${c.port}`);
    this.log.info(
      { participantId, transportId: transport.id, direction, candidates },
      'transport.created',
    );
    return {
      transportId: transport.id,
      iceParameters: transport.iceParameters as unknown as Json,
      iceCandidates: transport.iceCandidates as unknown as Json[],
      dtlsParameters: transport.dtlsParameters as unknown as Json,
    };
  }

  async connect(participantId: string, transportId: string, dtlsParameters: Json): Promise<void> {
    const { party, transport } = this.owned(participantId, transportId);
    if (party.connected.has(transportId)) throw new SignalingError('CONFLICT', 'already connected');
    party.connected.add(transportId);
    try {
      await transport.connect({
        dtlsParameters: dtlsParameters as unknown as types.DtlsParameters,
      });
    } catch {
      party.connected.delete(transportId);
      throw new SignalingError('INVALID_PAYLOAD', 'dtlsParameters rejected');
    }
  }

  async produce(
    participantId: string,
    transportId: string,
    kind: MediaKind,
    source: ProducerSource,
    rtpParameters: Json,
  ): Promise<ProducerInfo> {
    const { party, transport } = this.owned(participantId, transportId, 'send');
    if ((source === 'mic') !== (kind === 'audio')) {
      throw new SignalingError('INVALID_PAYLOAD', 'mic is audio, camera and screen are video');
    }
    const existing = party.producers.get(source);
    if (existing) throw new SignalingError('CONFLICT', `${source} producer exists: ${existing.id}`);
    // One sharer per room. The lock is the open screen Producer itself: closing it (stop,
    // leave, crash) releases it, so there is no flag to drift. Callers run in the room executor.
    const sharer = this.producers(party.roomId).find((p) => p.source === 'screen');
    if (source === 'screen' && sharer) {
      throw new SignalingError('CONFLICT', `already sharing: ${sharer.participantId}`);
    }
    let producer: types.Producer;
    try {
      producer = await transport.produce({
        kind,
        rtpParameters: rtpParameters as unknown as types.RtpParameters,
        appData: { participantId, source },
      });
    } catch {
      throw new SignalingError('INVALID_PAYLOAD', 'rtpParameters rejected');
    }
    const info = { producerId: producer.id, participantId, kind, source };
    party.producers.set(source, producer);
    this.producerIndex.set(producer.id, { roomId: party.roomId, info });
    this.live.producers += 1;
    producer.observer.once('close', () => {
      party.producers.delete(source);
      this.producerIndex.delete(producer.id);
      this.live.producers -= 1;
    });
    this.log.info({ participantId, producerId: producer.id, kind, source }, 'producer.created');
    return info;
  }

  async consume(
    participantId: string,
    transportId: string,
    producerId: string,
    rtpCapabilities: Json,
  ): Promise<ConsumerParams> {
    const { party, transport } = this.owned(participantId, transportId, 'recv');
    const source = this.producerIndex.get(producerId);
    if (source?.roomId !== party.roomId) {
      throw new SignalingError('NOT_FOUND', 'no such producer in this room');
    }
    if (source.info.participantId === participantId && !this.options.allowLoopback) {
      throw new SignalingError('FORBIDDEN', 'consuming your own producer is diagnostics only');
    }
    for (const existing of party.consumers.values()) {
      if (existing.producerId === producerId) {
        throw new SignalingError('CONFLICT', `already consuming it: ${existing.id}`);
      }
    }
    if (party.consumers.size >= MAX_CONSUMERS) {
      throw new SignalingError('CAPACITY_EXCEEDED', `at most ${String(MAX_CONSUMERS)} consumers`);
    }
    let consumer: types.Consumer;
    try {
      consumer = await transport.consume({ producerId, rtpCapabilities, paused: true });
    } catch (err) {
      this.log.warn({ participantId, producerId, err }, 'consumer.create_failed');
      // The Producer may have closed while we waited for the Worker.
      if (err instanceof errors.NotFoundError || !this.producerIndex.has(producerId)) {
        throw new SignalingError('NOT_FOUND', 'that producer just closed');
      }
      if (err instanceof TypeError) {
        throw new SignalingError('INVALID_STATE', 'CODEC_INCOMPATIBLE: cannot receive it');
      }
      throw new SignalingError('UNAVAILABLE', 'media server error, retry');
    }
    const { id: consumerId, kind, rtpParameters, producerPaused } = consumer;
    party.consumers.set(consumerId, consumer);
    this.live.consumers += 1;
    consumer.observer.once('close', () => {
      party.consumers.delete(consumerId);
      this.live.consumers -= 1;
    });
    // mediasoup closes the Consumer itself; the client must hear about it.
    consumer.on('producerclose', () => {
      this.emit(party.roomId, participantId, {
        type: 'sfu.consumerClosed',
        payload: { consumerId, reason: 'producer_closed' },
      });
    });
    return { consumerId, producerId, kind, rtpParameters, producerPaused };
  }

  async resumeConsumer(participantId: string, consumerId: string): Promise<void> {
    const consumer = this.parties.get(participantId)?.consumers.get(consumerId);
    if (!consumer) throw new SignalingError('NOT_FOUND', 'no such consumer');
    await consumer.resume();
  }

  async pauseProducer(participantId: string, producerId: string, paused: boolean): Promise<void> {
    const own = [...(this.parties.get(participantId)?.producers.values() ?? [])];
    const producer = own.find((p) => p.id === producerId);
    if (!producer) throw new SignalingError('NOT_FOUND', 'no such producer');
    await (paused ? producer.pause() : producer.resume());
  }

  closeProducer(participantId: string, producerId: string): void {
    const own = [...(this.parties.get(participantId)?.producers.values() ?? [])];
    const producer = own.find((p) => p.id === producerId);
    if (!producer) throw new SignalingError('NOT_FOUND', 'no such producer');
    producer.close(); // its Consumers emit producerclose → sfu.consumerClosed
    this.log.info({ participantId, producerId }, 'producer.closed');
  }

  closeParticipant(participantId: string): void {
    const party = this.parties.get(participantId);
    this.parties.delete(participantId);
    for (const transport of party?.transports.values() ?? []) transport.close();
  }

  /** The room's Router closed or died: its transports are gone already (cascade). */
  forgetRoom(roomId: string): void {
    for (const [participantId, party] of this.parties) {
      if (party.roomId === roomId) this.parties.delete(participantId);
    }
  }

  private emit(roomId: string, participantId: string, event: MediaEvent): void {
    for (const listener of this.listeners) listener(roomId, participantId, event);
  }

  /** The caller's own transport, of the right direction. Others' look like they don't exist. */
  private owned(participantId: string, transportId: string, direction?: Direction) {
    const party = this.parties.get(participantId);
    const transport = party?.transports.get(transportId);
    if (!party || !transport) throw new SignalingError('NOT_FOUND', 'no such transport');
    if (direction && transport.appData.direction !== direction) {
      throw new SignalingError('INVALID_STATE', `not a ${direction} transport`);
    }
    return { party, transport };
  }

  private watch(
    transport: types.WebRtcTransport,
    roomId: string,
    participantId: string,
    party: Party,
  ): void {
    const log = this.log.child({ participantId, transportId: transport.id });
    const close = (reason: TransportCloseReason) => {
      if (transport.closed) return;
      log.warn({ reason }, 'transport.closing');
      transport.close();
      this.emit(roomId, participantId, {
        type: 'sfu.transportClosed',
        payload: { transportId: transport.id, reason },
      });
    };
    const deadline = setTimeout(() => {
      if (transport.dtlsState !== 'connected') close('connect_timeout');
    }, this.options.connectDeadlineMs);
    let iceTimer: NodeJS.Timeout | undefined;
    transport.on('icestatechange', (iceState) => {
      log.info({ iceState }, 'transport.ice');
      clearTimeout(iceTimer);
      if (iceState === 'disconnected') {
        iceTimer = setTimeout(() => {
          close('ice_disconnected');
        }, this.options.iceDisconnectedMs);
      }
    });
    transport.on('dtlsstatechange', (dtlsState) => {
      log.info({ dtlsState }, 'transport.dtls');
      if (dtlsState === 'failed' || dtlsState === 'closed') close(`dtls_${dtlsState}`);
    });
    transport.on('iceselectedtuplechange', ({ protocol, localPort }) => {
      log.info({ protocol, localPort }, 'transport.tuple'); // the browser's address: not logged
    });
    this.live.transports += 1;
    transport.observer.once('close', () => {
      clearTimeout(deadline);
      clearTimeout(iceTimer);
      party.transports.delete(transport.id);
      party.connected.delete(transport.id);
      this.live.transports -= 1;
      log.info('transport.closed');
    });
  }
}
