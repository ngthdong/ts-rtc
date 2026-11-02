import type { MeshSignal } from '@ts-rtc/protocol';

export interface PeerSessionOptions {
  // On an offer collision the polite side rolls back its own offer and accepts the other.
  polite: boolean;
  localStream: MediaStream | null;
  send(signal: MeshSignal): void;
  onChange(stream: MediaStream | null, state: RTCPeerConnectionState): void;
  createPeerConnection?: () => RTCPeerConnection;
  iceServers: RTCIceServer[] | undefined;
}

/**
 * One RTCPeerConnection to one remote participant, using "perfect negotiation": either side
 * may (re)offer at any time, and a collision is resolved by the polite side yielding.
 */
export class PeerSession {
  readonly pc: RTCPeerConnection;
  private remoteStream: MediaStream | null = null;
  private makingOffer = false;
  private ignoreOffer = false;
  private closed = false;
  // Incoming signals are applied one at a time, so a candidate never overtakes its offer.
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly options: PeerSessionOptions) {
    const create =
      options.createPeerConnection ??
      (() => new RTCPeerConnection({ iceServers: options.iceServers }));
    const pc = (this.pc = create());
    const { localStream } = options;
    if (localStream) {
      for (const track of localStream.getTracks()) pc.addTrack(track, localStream);
    } else {
      // No camera/mic (denied or absent): still receive the other side.
      pc.addTransceiver('audio', { direction: 'recvonly' });
      pc.addTransceiver('video', { direction: 'recvonly' });
    }
    pc.onnegotiationneeded = () => {
      void this.offer();
    };
    pc.onicecandidate = ({ candidate: c }) => {
      if (!c) return;
      const { candidate, sdpMid, sdpMLineIndex, usernameFragment } = c;
      options.send({ candidate: { candidate, sdpMid, sdpMLineIndex, usernameFragment } });
    };
    pc.ontrack = ({ streams }) => {
      this.remoteStream = streams[0] ?? null;
      this.notify();
    };
    pc.onconnectionstatechange = () => {
      this.notify();
    };
  }

  handle(signal: MeshSignal): Promise<void> {
    this.queue = this.queue
      .then(() => this.apply(signal))
      .catch((err: unknown) => {
        console.warn('mesh: could not apply signal', err);
      });
    return this.queue;
  }

  // Idempotent.
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pc.close();
  }

  private async offer(): Promise<void> {
    try {
      this.makingOffer = true;
      await this.pc.setLocalDescription();
      this.sendLocalDescription();
    } catch (err) {
      console.warn('mesh: offer failed', err);
    } finally {
      this.makingOffer = false;
    }
  }

  private async apply(signal: MeshSignal): Promise<void> {
    if (this.closed) return;
    if ('description' in signal) {
      const { description } = signal;
      const collision =
        description.type === 'offer' && (this.makingOffer || this.pc.signalingState !== 'stable');
      this.ignoreOffer = !this.options.polite && collision;
      if (this.ignoreOffer) return;
      await this.pc.setRemoteDescription(description); // rolls back our own offer if needed
      if (description.type === 'offer') {
        await this.pc.setLocalDescription();
        this.sendLocalDescription();
      }
      return;
    }
    try {
      await this.pc.addIceCandidate(signal.candidate);
    } catch (err) {
      if (!this.ignoreOffer) throw err; // candidates for an offer we ignored are expected to fail
    }
  }

  private sendLocalDescription(): void {
    const description = this.pc.localDescription;
    if (this.closed || !description) return;
    if (description.type !== 'offer' && description.type !== 'answer') return;
    this.options.send({ description: { type: description.type, sdp: description.sdp } });
  }

  private notify(): void {
    if (!this.closed) this.options.onChange(this.remoteStream, this.pc.connectionState);
  }
}
