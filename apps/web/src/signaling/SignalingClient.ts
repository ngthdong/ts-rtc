import {
  ClientRequest,
  Events,
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

export type ConnectionStatus = 'connecting' | 'ready' | 'closed';

export interface SignalingSnapshot {
  status: ConnectionStatus;
  sessionId: string | null;
  closeCode: number | null;
  closeReason: string | null;
  rttMs: number | null;
}

export const initialSnapshot: SignalingSnapshot = {
  status: 'connecting',
  sessionId: null,
  closeCode: null,
  closeReason: null,
  rttMs: null,
};

export interface SignalingClientOptions {
  requestTimeoutMs?: number;
  createSocket?: (url: string) => WebSocket;
}

interface Pending {
  type: RequestType;
  resolve: (payload: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const OPEN = 1;
const MAX_MISSED_HEARTBEATS = 2;

export class SignalingClient {
  private readonly ws: WebSocket;
  private readonly requestTimeoutMs: number;
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<() => void>();
  private readonly eventListeners = new Set<(event: SignalingEvent) => void>();
  private lastSeq = 0;
  private state = initialSnapshot;
  private nextId = 0;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private missedHeartbeats = 0;

  constructor(url: string, options: SignalingClientOptions = {}) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
    this.ws = (options.createSocket ?? ((u) => new WebSocket(u)))(url);
    this.ws.onopen = () => {
      void this.greet();
    };
    this.ws.onmessage = (event: MessageEvent) => {
      this.onMessage(event.data);
    };
    this.ws.onclose = (event) => {
      this.onClosed(event.code, event.reason || null);
    };
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
    if (this.ws.readyState !== OPEN) {
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
      this.ws.send(JSON.stringify(message));
    });
  }

  close(): void {
    this.listeners.clear();
    this.eventListeners.clear();
    this.detach();
    this.ws.close(1000);
    this.onClosed(1000, 'closed by client');
  }

  private async greet(): Promise<void> {
    try {
      const welcome = await this.request('session.hello', { protocolVersions: [PROTOCOL_VERSION] });
      this.update({ status: 'ready', sessionId: welcome.sessionId });
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

  private giveUp(reason: string): void {
    this.detach();
    this.ws.close();
    this.onClosed(null, reason);
  }

  private onClosed(code: number | null, reason: string | null): void {
    clearInterval(this.heartbeat);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new SignalingError('UNAVAILABLE', 'connection closed'));
    }
    this.pending.clear();
    this.update({ status: 'closed', closeCode: code, closeReason: reason });
  }

  private detach(): void {
    this.ws.onopen = null;
    this.ws.onmessage = null;
    this.ws.onclose = null;
  }

  private update(patch: Partial<SignalingSnapshot>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}
