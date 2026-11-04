import type { MediaKind, ProducerInfo, ProducerSource, RoomSnapshot } from '@ts-rtc/protocol';
import { Device, type types } from 'mediasoup-client';
import type { SignalingClient } from '../signaling/SignalingClient.js';
import { StatsCollector, type PeerQuality } from '../stats/quality.js';

type Direction = 'send' | 'recv';
type Ice = { iceServers: RTCIceServer[]; iceTransportPolicy: RTCIceTransportPolicy };
const sourceOf = (kind: string): ProducerSource => (kind === 'audio' ? 'mic' : 'camera');

/**
 * Camera simulcast: three layers in one m-line; mediasoup forwards each receiver the best layer
 * its bandwidth allows. Starting points to be measured, not claims. Screens stay single-layer.
 */
const CAMERA_LAYERS: types.RtpEncodingParameters[] = [
  { scaleResolutionDownBy: 4, maxBitrate: 150_000, scalabilityMode: 'L1T3' },
  { scaleResolutionDownBy: 2, maxBitrate: 500_000, scalabilityMode: 'L1T3' },
  { scaleResolutionDownBy: 1, maxBitrate: 1_200_000, scalabilityMode: 'L1T3' },
];

/**
 * The SFU side of a call: one mediasoup-client Device, one send and one recv transport, a
 * Producer per local source and a Consumer per remote Producer. mediasoup-client turns
 * produce/consume into SDP on its own RTCPeerConnections; the app never sees SDP.
 * Created before room.join (like MeshCall) so no sfu.newProducer is missed; held until start().
 */
export class SfuSession {
  readonly states: Record<Direction, string> = { send: 'new', recv: 'new' };
  /** Received media per tile: `participantId` (mic + camera) or `participantId#screen`. */
  readonly streams = new Map<string, MediaStream>();
  private readonly device = new Device();
  private readonly transports = new Map<Direction, types.Transport>();
  private readonly producers = new Map<ProducerSource, types.Producer>();
  private readonly consumers = new Map<string, { consumer: types.Consumer; tile: string }>();
  private readonly stats = new StatsCollector();
  private held: ProducerInfo[] | null = [];
  private readonly unsubscribe: () => void;

  constructor(
    private readonly signaling: Pick<SignalingClient, 'request' | 'onEvent'>,
    private readonly ice: Ice,
    private readonly onChange: () => void,
    private readonly simulcast = true,
  ) {
    this.unsubscribe = signaling.onEvent((event) => {
      if (event.type === 'sfu.newProducer') {
        if (this.held) this.held.push(event.payload);
        else void this.consume(event.payload);
      }
      if (event.type === 'sfu.consumerClosed') this.drop(event.payload.consumerId);
    });
  }

  /** Sends `tracks`, receives everyone already producing, then whatever comes next. */
  async start(snapshot: RoomSnapshot, tracks: MediaStreamTrack[], loopback = false) {
    const { routerRtpCapabilities = {}, producers = [], participantId } = snapshot;
    await this.device.load({ routerRtpCapabilities });
    await this.transport('send');
    await this.transport('recv');
    const own: ProducerInfo[] = [];
    for (const track of tracks) {
      const { id, kind } = await this.produce(track);
      own.push({ producerId: id, participantId, kind, source: sourceOf(kind) });
    }
    // Loopback (diagnostics): receive your own Producers back through the SFU.
    const pending = [...producers, ...(loopback ? own : []), ...(this.held ?? [])];
    this.held = null;
    for (const info of pending) await this.consume(info);
  }

  /** A device turned on mid-call (camera denied at join): a new Producer, announced to all. */
  async produce(
    track: MediaStreamTrack,
    source = sourceOf(track.kind),
    encodings?: RTCRtpEncodingParameters[],
  ): Promise<types.Producer> {
    const send = this.transports.get('send');
    if (!send) throw new Error('no send transport');
    const producer = await send.produce({
      track,
      stopTracks: false,
      appData: { source },
      encodings: encodings ?? (source === 'camera' && this.simulcast ? CAMERA_LAYERS : undefined),
    });
    this.producers.set(source, producer);
    return producer;
  }

  get sharing(): boolean {
    return this.producers.has('screen');
  }

  /** The screen as a Producer of its own: the camera is untouched, so stopping restores nothing. */
  async shareScreen(): Promise<void> {
    const capture = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { max: 15 } }, // text, not motion
      audio: false,
    });
    const [track] = capture.getVideoTracks();
    if (!track) return;
    track.contentHint = 'detail'; // keep text sharp; drop frames rather than resolution
    try {
      const producer = await this.produce(track, 'screen', [{ maxBitrate: 1_500_000 }]);
      // The browser's own "Stop sharing" button ends the track without us doing anything.
      producer.on('trackended', () => void this.stopScreen());
    } catch (err) {
      track.stop(); // e.g. someone else is already sharing (CONFLICT)
      throw err;
    }
    this.onChange();
  }

  async stopScreen(): Promise<void> {
    const producer = this.producers.get('screen');
    if (!producer) return;
    this.producers.delete('screen');
    producer.close();
    producer.track?.stop();
    this.onChange();
    await this.signaling.request('sfu.closeProducer', { producerId: producer.id });
  }

  /** Test hook: what the browser's "Stop sharing" button does (stop() alone fires no 'ended'). */
  endScreenTrack(): void {
    const track = this.producers.get('screen')?.track;
    track?.stop();
    track?.dispatchEvent(new Event('ended'));
  }

  /** Mute: stop sending (client) and stop forwarding (server, so receivers see it at once). */
  async setPaused(kind: MediaKind, paused: boolean): Promise<void> {
    const producer = this.producers.get(sourceOf(kind));
    if (!producer) return;
    if (paused) producer.pause();
    else producer.resume();
    await this.signaling.request('sfu.pauseProducer', { producerId: producer.id, paused });
  }

  /** The send and recv transports together (one entry: SFU traffic is not per peer). */
  async sampleQuality(): Promise<PeerQuality | undefined> {
    const { send, recv } = await this.stats.sample(this.transports);
    return (
      recv && { ...recv, outKbps: send?.outKbps ?? null, limitation: send?.limitation ?? null }
    );
  }

  /** Test hook: the camera's layers as sent (outbound-rtp per rid), lowest first. */
  async sendLayers(): Promise<{ rid: string; bytes: number; width: number | null }[]> {
    const layers: { rid: string; bytes: number; width: number | null }[] = [];
    (await this.producers.get('camera')?.getStats())?.forEach(
      (stat: { type: string; rid?: string; bytesSent?: number; frameWidth?: number }) => {
        if (stat.type !== 'outbound-rtp') return;
        layers.push({
          rid: stat.rid ?? '',
          bytes: stat.bytesSent ?? 0,
          width: stat.frameWidth ?? null,
        });
      },
    );
    return layers.sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
  }

  /** Test hook: the width of the video each tile receives (the layer the SFU forwards). */
  async receivedWidths(): Promise<Record<string, number>> {
    const result: Record<string, number> = {};
    for (const { consumer, tile } of this.consumers.values()) {
      if (consumer.kind !== 'video') continue;
      (await consumer.getStats()).forEach((stat: { type: string; frameWidth?: number }) => {
        if (stat.type === 'inbound-rtp' && stat.frameWidth) result[tile] = stat.frameWidth;
      });
    }
    return result;
  }

  /** Test hook: inbound RTP bytes per remote participant and kind. */
  async inboundBytes(): Promise<Record<string, Record<MediaKind, number>>> {
    const result: Record<string, Record<MediaKind, number>> = {};
    for (const { consumer, tile } of this.consumers.values()) {
      const totals = (result[tile] ??= { audio: 0, video: 0 });
      (await consumer.getStats()).forEach((stat: { type: string; bytesReceived?: number }) => {
        if (stat.type === 'inbound-rtp') totals[consumer.kind] += stat.bytesReceived ?? 0;
      });
    }
    return result;
  }

  close(): void {
    this.unsubscribe();
    this.producers.get('screen')?.track?.stop(); // not in the call's local stream
    for (const transport of this.transports.values()) transport.close();
    this.transports.clear();
    this.streams.clear();
  }

  private async consume({ producerId, participantId, source }: ProducerInfo): Promise<void> {
    const tile = source === 'screen' ? `${participantId}#screen` : participantId;
    const recv = this.transports.get('recv');
    if (!recv) return;
    let consumerId: string | undefined;
    try {
      const params = await this.signaling.request('sfu.consume', {
        transportId: recv.id,
        producerId,
        rtpCapabilities: this.device.recvRtpCapabilities,
      });
      const consumer = await recv.consume({
        id: params.consumerId,
        producerId,
        kind: params.kind,
        rtpParameters: params.rtpParameters as unknown as types.RtpParameters,
      });
      consumerId = consumer.id;
      this.consumers.set(consumer.id, { consumer, tile });
      this.setTracks(tile, (tracks) => [...tracks, consumer.track]);
      // Paused on the server until now, so the first key frame reaches an attached track.
      await this.signaling.request('sfu.resumeConsumer', { consumerId: consumer.id });
    } catch (err) {
      // Its Producer closed meanwhile; sfu.consumerClosed may have come before we had it.
      if (consumerId) this.drop(consumerId);
      console.warn('sfu: consume failed (its producer may have just closed)', err);
    }
  }

  private drop(consumerId: string): void {
    const entry = this.consumers.get(consumerId);
    if (!entry) return;
    this.consumers.delete(consumerId);
    entry.consumer.close();
    this.setTracks(entry.tile, (tracks) => tracks.filter((t) => t !== entry.consumer.track));
  }

  /** A new MediaStream each time, so <video> sees the change. */
  private setTracks(tile: string, change: (tracks: MediaStreamTrack[]) => MediaStreamTrack[]) {
    const tracks = change(this.streams.get(tile)?.getTracks() ?? []);
    if (tracks.length > 0) this.streams.set(tile, new MediaStream(tracks));
    else this.streams.delete(tile);
    this.onChange();
  }

  private async transport(direction: Direction): Promise<types.Transport> {
    const params = await this.signaling.request('sfu.createTransport', { direction });
    const options: types.TransportOptions = {
      id: params.transportId,
      iceParameters: params.iceParameters as unknown as types.IceParameters,
      iceCandidates: params.iceCandidates as unknown as types.IceCandidate[],
      dtlsParameters: params.dtlsParameters as unknown as types.DtlsParameters,
      ...this.ice,
    };
    const transport =
      direction === 'send'
        ? this.device.createSendTransport(options)
        : this.device.createRecvTransport(options);
    transport.on('connect', ({ dtlsParameters }, done, fail) => {
      this.signaling
        .request('sfu.connectTransport', { transportId: transport.id, dtlsParameters })
        .then(() => {
          done();
        }, fail);
    });
    transport.on('produce', ({ kind, rtpParameters, appData }, done, fail) => {
      const source = appData.source as ProducerSource;
      this.signaling
        .request('sfu.produce', { transportId: transport.id, kind, source, rtpParameters })
        .then(({ producerId }) => {
          done({ id: producerId });
        }, fail);
    });
    transport.on('connectionstatechange', (state) => {
      this.states[direction] = state;
      this.onChange();
    });
    this.transports.set(direction, transport);
    return transport;
  }
}
