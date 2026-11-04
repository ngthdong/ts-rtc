import { SignalingError } from '@ts-rtc/protocol';
import type { FastifyBaseLogger } from 'fastify';
import type { types } from 'mediasoup';
import type {
  ConsumerParams,
  Direction,
  Json,
  MediaController,
  MediaCounts,
  MediaKind,
  TransportCloseReason,
  TransportParams,
} from '../media-controller.js';

export interface TransportOptions {
  /** Consuming your own Producer: the diagnostics loopback. Off in production. */
  allowLoopback: boolean;
  /** A transport not DTLS-connected this long after creation is closed. */
  connectDeadlineMs: number;
  /** ICE disconnected this long closes the transport (Stage 15: ICE restart instead). */
  iceDisconnectedMs: number;
}

const MAX_PRODUCERS = 3; // microphone, camera, screen

interface Party {
  roomId: string;
  transports: Map<string, types.WebRtcTransport>;
  connected: Set<string>;
  producers: number;
}

type ClosedListener = Parameters<MediaController['onTransportClosed']>[0];

/** Each participant's transports, Producers and Consumers, and who may use which. */
export class TransportService {
  private readonly parties = new Map<string, Party>();
  private readonly producers = new Map<string, { roomId: string; participantId: string }>();
  private readonly live: MediaCounts = { transports: 0, producers: 0, consumers: 0 };
  private readonly closedListeners: ClosedListener[] = [];

  constructor(
    private readonly options: TransportOptions,
    private readonly log: FastifyBaseLogger,
  ) {}

  counts(): MediaCounts {
    return { ...this.live };
  }

  onClosed(listener: ClosedListener): void {
    this.closedListeners.push(listener);
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
      producers: 0,
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
    rtpParameters: Json,
  ): Promise<string> {
    const { party, transport } = this.owned(participantId, transportId, 'send');
    if (party.producers >= MAX_PRODUCERS) {
      throw new SignalingError('CAPACITY_EXCEEDED', `at most ${String(MAX_PRODUCERS)} producers`);
    }
    let producer: types.Producer;
    try {
      producer = await transport.produce({
        kind,
        rtpParameters: rtpParameters as unknown as types.RtpParameters,
      });
    } catch {
      throw new SignalingError('INVALID_PAYLOAD', 'rtpParameters rejected');
    }
    party.producers += 1;
    this.live.producers += 1;
    this.producers.set(producer.id, { roomId: party.roomId, participantId });
    producer.observer.once('close', () => {
      party.producers -= 1;
      this.live.producers -= 1;
      this.producers.delete(producer.id);
    });
    this.log.info({ participantId, producerId: producer.id, kind }, 'producer.created');
    return producer.id;
  }

  async consume(
    participantId: string,
    transportId: string,
    producerId: string,
    rtpCapabilities: Json,
  ): Promise<ConsumerParams> {
    const { party, transport } = this.owned(participantId, transportId, 'recv');
    const source = this.producers.get(producerId);
    if (source?.roomId !== party.roomId) {
      throw new SignalingError('NOT_FOUND', 'no such producer in this room');
    }
    if (source.participantId === participantId && !this.options.allowLoopback) {
      throw new SignalingError('FORBIDDEN', 'consuming your own producer is diagnostics only');
    }
    let consumer: types.Consumer;
    try {
      consumer = await transport.consume({ producerId, rtpCapabilities });
    } catch {
      throw new SignalingError('INVALID_STATE', 'this device cannot receive that producer');
    }
    this.live.consumers += 1;
    consumer.observer.once('close', () => {
      this.live.consumers -= 1;
    });
    const { id: consumerId, kind, rtpParameters } = consumer;
    return { consumerId, producerId, kind, rtpParameters };
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
      for (const listener of this.closedListeners) {
        listener(roomId, participantId, transport.id, reason);
      }
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
