import type { MediaKind } from '@ts-rtc/protocol';
import { Device, type types } from 'mediasoup-client';
import type { SignalingClient } from '../signaling/SignalingClient.js';
import { StatsCollector, type PeerQuality } from '../stats/quality.js';

type Direction = 'send' | 'recv';
type Ice = { iceServers: RTCIceServer[]; iceTransportPolicy: RTCIceTransportPolicy };

/**
 * One SFU session: a mediasoup-client Device and at most one send and one recv transport.
 * mediasoup-client turns produce/consume into SDP on its own RTCPeerConnections; the app
 * never sees SDP in SFU mode.
 */
export class SfuSession {
  readonly states: Record<Direction, string> = { send: 'new', recv: 'new' };
  private readonly device = new Device();
  private readonly transports = new Map<Direction, types.Transport>();
  private readonly stats = new StatsCollector();

  private constructor(
    private readonly signaling: Pick<SignalingClient, 'request'>,
    private readonly ice: Ice,
    private readonly onChange: () => void,
  ) {}

  static async start(
    signaling: Pick<SignalingClient, 'request'>,
    routerRtpCapabilities: Record<string, unknown>,
    ice: Ice,
    onChange: () => void,
  ): Promise<SfuSession> {
    const session = new SfuSession(signaling, ice, onChange);
    await session.device.load({ routerRtpCapabilities });
    return session;
  }

  /**
   * Diagnostics: send each track to the SFU and receive it back on the recv transport.
   * Proves the browser ⇄ Worker path (ICE, DTLS, SRTP) with nobody else involved.
   */
  async loopback(tracks: MediaStreamTrack[]): Promise<MediaStream> {
    const send = await this.transport('send');
    const recv = await this.transport('recv');
    const received = new MediaStream();
    for (const track of tracks) {
      const producer = await send.produce({ track, stopTracks: false });
      const consumer = await this.signaling.request('sfu.consume', {
        transportId: recv.id,
        producerId: producer.id,
        rtpCapabilities: this.device.recvRtpCapabilities,
      });
      const { track: echo } = await recv.consume({
        id: consumer.consumerId,
        producerId: consumer.producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters as unknown as types.RtpParameters,
      });
      received.addTrack(echo);
    }
    return received;
  }

  /** Quality of the round trip: what arrives on recv, what leaves on send. */
  async sampleQuality(): Promise<PeerQuality | undefined> {
    const { send, recv } = await this.stats.sample(this.transports);
    return (
      recv && { ...recv, outKbps: send?.outKbps ?? null, limitation: send?.limitation ?? null }
    );
  }

  /** Test hook: inbound RTP bytes on the recv transport, per kind. */
  async inboundBytes(): Promise<Record<MediaKind, number>> {
    const totals = { audio: 0, video: 0 };
    (await this.transports.get('recv')?.getStats())?.forEach(
      (stat: { type: string; kind?: MediaKind; bytesReceived?: number }) => {
        if (stat.type === 'inbound-rtp' && stat.kind) totals[stat.kind] += stat.bytesReceived ?? 0;
      },
    );
    return totals;
  }

  close(): void {
    for (const transport of this.transports.values()) transport.close();
    this.transports.clear();
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
    transport.on('produce', ({ kind, rtpParameters }, done, fail) => {
      this.signaling
        .request('sfu.produce', { transportId: transport.id, kind, rtpParameters })
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
