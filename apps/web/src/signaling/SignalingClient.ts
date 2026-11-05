import {
  ClientRequest,
  Events,
  IceServer,
  isEventType,
  PROTOCOL_VERSION,
  Requests,
  ServerMessage,
  SignalingError,
  type RequestPayload,
  type RequestType,
  type ResponsePayload,
  type SignalingEvent,
} from '@ts-rtc/protocol';
import { backoffMs, RECONNECT, shouldReconnect } from './ReconnectPolicy.js';

/** reconnecting: the socket dropped and another attempt is scheduled; closed: no more attempts. */
export type ConnectionStatus = 'connecting' | 'ready' | 'reconnecting' | 'closed';

export interface SignalingSnapshot {
  status: ConnectionStatus;
  sessionId: string | null;
  closeCode: number | null;
  closeReason: string | null;
  rttMs: number | null;
  iceServers: IceServer[];
}

export const initialSnapshot: SignalingSnapshot = {
  status: 'connecting',
  sessionId: null,
  closeCode: null,
  closeReason: null,
  rttMs: null,
  iceServers: [],
};

export interface SignalingClientOptions {
  requestTimeoutMs?: number;
  /** Sent in session.hello; without a valid one the server closes with 4401. */
  accessToken?: string | undefined;
  createSocket?: (url: string) => WebSocket;
  /** The backoff's jitter (tests pass a fixed one). */
  random?: () => number;
}

interface Pending {
  type: RequestType;
  resolve: (payload: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const OPEN = 1;
const MAX_MISSED_HEARTBEATS = 2;

/**
 * One logical connection over a series of sockets: a dropped socket (no close code, or one
 * that is not final) is replaced with backoff. A new socket is a new session (a new sessionId
 * in the snapshot); the room membership is resumed by RoomClient (room.resume), not here.
 */
export class SignalingClient {
  private ws: WebSocket | null = null;
  private readonly requestTimeoutMs: number;
  private readonly accessToken: string | undefined;
  private readonly createSocket: (url: string) => WebSocket;
  private readonly random: () => number;
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<() => void>();
  private readonly eventListeners = new Set<(event: SignalingEvent) => void>();
  private lastSeq = 0;
  private state = initialSnapshot;
  private nextId = 0;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private missedHeartbeats = 0;
  /** Failed attempts since the last greeted socket. */
  private attempts = 0;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  /** drop(): no new socket before this time (a simulated outage). */
  private blockedUntil = 0;

  constructor(
    private readonly url: string,
    options: SignalingClientOptions = {},
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
    this.accessToken = options.accessToken;
    this.createSocket = options.createSocket ?? ((u) => new WebSocket(u));
    this.random = options.random ?? Math.random;
    globalThis.addEventListener?.('online', this.retryNow);
    this.connect();
  }

  get snapshot(): SignalingSnapshot {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  onEvent(listener: (event: SignalingEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  request<T extends RequestType>(
    type: T,
    payload: RequestPayload<T>,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<ResponsePayload<T>> {
    const ws = this.ws;
    if (ws?.readyState !== OPEN) {
      return Promise.reject(new SignalingError('UNAVAILABLE', 'not connected'));
    }
    const id = String(++this.nextId);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new SignalingError('TIMEOUT', `${type} timed out`));
      }, timeoutMs);
      this.pending.set(id, { type, resolve: resolve as (p: unknown) => void, reject, timer });
      const message: ClientRequest = { v: PROTOCOL_VERSION, kind: 'req', id, type, payload };
      ws.send(JSON.stringify(message));
    });
  }

  close(): void {
    this.stopped = true;
    globalThis.removeEventListener?.('online', this.retryNow);
    this.listeners.clear();
    this.eventListeners.clear();
    const ws = this.detach();
    ws?.close(1000);
    this.onClosed(1000, 'closed by client');
  }

  /**
   * Test hook: the network goes away for `ms`. The socket closes (so the server sees the drop
   * at once) and no new one is opened before `ms` have passed.
   */
  drop(ms: number): void {
    this.blockedUntil = Date.now() + ms;
    const ws = this.detach();
    ws?.close(4000, 'test: connection dropped');
    this.onClosed(null, 'connection lost');
  }

  /** The browser is back online: try now instead of waiting out the backoff. */
  private readonly retryNow = (): void => {
    if (this.state.status !== 'reconnecting' || Date.now() < this.blockedUntil) return;
    clearTimeout(this.retry);
    this.connect();
  };

  private connect(): void {
    const ws = this.createSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      void this.greet();
    };
    ws.onmessage = (event: MessageEvent) => {
      this.onMessage(event.data);
    };
    ws.onclose = (event) => {
      this.detach();
      this.onClosed(event.code, event.reason || null);
    };
  }

  private async greet(): Promise<void> {
    try {
      const welcome = await this.request('session.hello', {
        protocolVersions: [PROTOCOL_VERSION],
        ...(this.accessToken && { accessToken: this.accessToken }),
      });
      const { sessionId, iceServers } = welcome;
      this.attempts = 0;
      this.lastSeq = 0; // event seq is per session
      this.missedHeartbeats = 0;
      this.update({ status: 'ready', sessionId, iceServers, closeCode: null, closeReason: null });
      this.heartbeat = setInterval(() => {
        void this.beat();
      }, welcome.heartbeatIntervalMs);
    } catch (err) {
      if (err instanceof SignalingError && err.code === 'TIMEOUT') this.giveUp('hello timeout');
    }
  }

  private async beat(): Promise<void> {
    const startedAt = performance.now();
    try {
      await this.request('session.heartbeat', {});
      this.missedHeartbeats = 0;
      this.update({ rttMs: Math.round(performance.now() - startedAt) });
    } catch {
      this.missedHeartbeats += 1;
      if (this.missedHeartbeats >= MAX_MISSED_HEARTBEATS) this.giveUp('heartbeat timeout');
    }
  }

  private onMessage(data: unknown): void {
    let json: unknown;
    try {
      json = JSON.parse(typeof data === 'string' ? data : '');
    } catch {
      return;
    }
    const parsed = ServerMessage.safeParse(json);
    if (!parsed.success) {
      console.warn('signaling: dropped a malformed server message');
      return;
    }
    const message = parsed.data;
    if (message.kind === 'evt') {
      this.onServerEvent(message);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (!message.ok) {
      pending.reject(new SignalingError(message.error.code, message.error.message));
      return;
    }
    const payload = Requests[pending.type].response.safeParse(message.payload);
    if (payload.success) pending.resolve(payload.data);
    else
      pending.reject(new SignalingError('INVALID_PAYLOAD', `malformed ${pending.type} response`));
  }

  private onServerEvent(message: Extract<ServerMessage, { kind: 'evt' }>): void {
    // One socket delivers in order, so a gap means a server bug, not network loss.
    if (message.seq !== this.lastSeq + 1) {
      console.warn(`signaling: event seq jumped from ${this.lastSeq} to ${message.seq}`);
    }
    this.lastSeq = message.seq;
    if (!isEventType(message.type)) return; // newer server, unknown event: ignore
    const payload = Events[message.type].safeParse(message.payload);
    if (!payload.success) {
      console.warn(`signaling: dropped a malformed ${message.type} event`);
      return;
    }
    const event = { type: message.type, payload: payload.data } as SignalingEvent;
    for (const listener of this.eventListeners) listener(event);
  }

  /** The server stopped answering (hello or heartbeats): treat the socket as dropped. */
  private giveUp(reason: string): void {
    this.detach()?.close();
    this.onClosed(null, reason);
  }

  /** The socket is gone: another one after a backoff, unless the close is final. */
  private onClosed(code: number | null, reason: string | null): void {
    clearInterval(this.heartbeat);
    clearTimeout(this.retry);
    // Pending requests fail (UNAVAILABLE), never replayed: the caller knows what is still needed.
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new SignalingError('UNAVAILABLE', 'connection closed'));
    }
    this.pending.clear();
    const again = !this.stopped && shouldReconnect(code) && this.attempts < RECONNECT.maxAttempts;
    this.update({
      status: again ? 'reconnecting' : 'closed',
      closeCode: code,
      closeReason: reason,
    });
    if (!again) return;
    // drop(): not before the simulated outage is over.
    const delay = Math.max(backoffMs(this.attempts++, this.random), this.blockedUntil - Date.now());
    this.retry = setTimeout(() => {
      this.connect();
    }, delay);
  }

  /** Stops listening to the current socket; returns it (to close it), if any. */
  private detach(): WebSocket | null {
    const ws = this.ws;
    this.ws = null;
    if (ws) ws.onopen = ws.onmessage = ws.onclose = null;
    return ws;
  }

  private update(patch: Partial<SignalingSnapshot>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}
