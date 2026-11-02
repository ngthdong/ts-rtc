/** A Router's RTP capabilities: plain JSON for the client's mediasoup-client Device. */
export type RtpCapabilities = Record<string, unknown>;

/** Per-Worker numbers for tests, the dev dump and metrics. */
export interface WorkerInfo {
  index: number;
  pid: number;
  routerIds: string[];
  usage: Record<string, number>;
}

/**
 * The SFU as the rest of the server sees it. Rooms ask by room id; nothing outside
 * `media/` imports mediasoup, and no mediasoup object crosses this boundary.
 */
export interface MediaController {
  /** Creates the room's Router on the least-loaded Worker, or returns the existing one. */
  ensureRouter(roomId: string): Promise<RtpCapabilities>;
  /** Idempotent; also safe while ensureRouter for the room is still in flight. */
  closeRouter(roomId: string): void;
  /** Called with each room whose Router was lost because its Worker died. */
  onRouterLost(listener: (roomId: string) => void): void;
  /** False once Workers die faster than they may be restarted: /readyz answers 503. */
  readonly healthy: boolean;
  inspect(): Promise<WorkerInfo[]>;
  close(): void;
}
