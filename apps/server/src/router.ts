import {
  isRequestType,
  PROTOCOL_VERSION,
  Requests,
  SignalingError,
  CloseCode,
  type ClientRequest,
  type RequestPayload,
  type RequestType,
  type ResponsePayload,
  type ServerResponse,
} from '@ts-rtc/protocol';
import type { FastifyBaseLogger } from 'fastify';
import type { Session } from './session.js';

export interface RequestContext {
  readonly session: Session;
  readonly log: FastifyBaseLogger;
}

export type Handler<T extends RequestType> = (
  payload: RequestPayload<T>,
  ctx: RequestContext,
) => ResponsePayload<T> | Promise<ResponsePayload<T>>;

type AnyHandler = (payload: unknown, ctx: RequestContext) => unknown;

export interface Outcome {
  response: ServerResponse;
  closeCode?: number | undefined;
}

export class RequestRouter {
  private readonly handlers = new Map<RequestType, AnyHandler>();

  constructor(private readonly timeoutMs: number) {}

  on<T extends RequestType>(type: T, handler: Handler<T>): this {
    this.handlers.set(type, handler as unknown as AnyHandler);
    return this;
  }

  async dispatch(req: ClientRequest, ctx: RequestContext): Promise<Outcome> {
    const startedAt = performance.now();
    const log = ctx.log.child({ requestId: req.id, type: req.type });
    const base = { v: PROTOCOL_VERSION, kind: 'res', id: req.id, type: req.type } as const;
    try {
      const payload = await this.withDeadline(this.run(req, ctx), log);
      log.debug({ durationMs: since(startedAt), outcome: 'ok' }, 'request.done');
      return { response: { ...base, ok: true, payload } };
    } catch (err) {
      const error =
        err instanceof SignalingError ? err : new SignalingError('INTERNAL', 'internal error');
      if (err instanceof SignalingError) {
        log.info(
          { durationMs: since(startedAt), outcome: 'error', errorCode: error.code },
          'request.done',
        );
      } else {
        log.error({ err, durationMs: since(startedAt) }, 'request.failed');
      }
      const body = { code: error.code, message: error.message, retryable: error.retryable };
      return { response: { ...base, ok: false, error: body }, closeCode: error.closeCode };
    }
  }

  private async run(req: ClientRequest, ctx: RequestContext): Promise<unknown> {
    if (req.v !== PROTOCOL_VERSION) {
      throw new SignalingError(
        'UNSUPPORTED_VERSION',
        `server speaks protocol v${PROTOCOL_VERSION}`,
        CloseCode.UnsupportedVersion,
      );
    }
    const handler = isRequestType(req.type) ? this.handlers.get(req.type) : undefined;
    if (!handler || !isRequestType(req.type)) {
      throw new SignalingError('UNKNOWN_TYPE', 'unknown request type');
    }
    if (req.type !== 'session.hello' && !ctx.session.greeted) {
      throw new SignalingError('INVALID_STATE', 'send session.hello first');
    }
    const parsed = Requests[req.type].request.safeParse(req.payload);
    if (!parsed.success) {
      // Paths and messages only: never echo the client's values back.
      const issues = parsed.error.issues.map(
        (i) => `${i.path.join('.') || '(root)'}: ${i.message}`,
      );
      throw new SignalingError('INVALID_PAYLOAD', issues.join('; '));
    }
    return await handler(parsed.data, ctx);
  }

  private withDeadline<T>(work: Promise<T>, log: FastifyBaseLogger): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new SignalingError('TIMEOUT', 'request timed out'));
      }, this.timeoutMs);
    });
    work.then(
      () => {
        if (timedOut) log.warn('request.late');
      },
      () => undefined,
    );
    return Promise.race([work, deadline]).finally(() => {
      clearTimeout(timer);
    });
  }
}

function since(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}
