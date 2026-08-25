/**
 * T-018 — enforcement point ①, inbound (07-DATA-PROTECTION.md §5).
 *
 * Replaces `request.body` with plaintext **before** anything else in the pipeline sees it, so
 * DTOs, `class-validator` and every controller in the application stay exactly as they were
 * written and need no knowledge that encryption exists.
 *
 * ---
 *
 * ## Why an interceptor is the correct place, and middleware is not
 *
 * Nest's order is: middleware → guards → **interceptors (pre)** → pipes → handler. Two things
 * follow, and both are requirements rather than conveniences:
 *
 *  - **Interceptors run before `ValidationPipe`** — task file implementation note 4, TC-16. So the
 *    pipe receives ordinary plaintext and `forbidNonWhitelisted` keeps meaning what it meant
 *    (TC-4). Decrypting in a pipe would be too late; the DTO would already have been rejected for
 *    carrying `kid`, `iv`, `tag` and `ct`.
 *  - **Interceptors run after the guards**, which is what makes R3 hold here. `JwtAuthGuard` has
 *    already put a *verified* `authUser` on the request, so the session whose key we use is the
 *    one in the signed token. Middleware runs before the guards and would have had to trust the
 *    envelope's own `kid` — i.e. let the caller nominate which session key decrypts their
 *    payload, which is the whole attack.
 *
 * ## Decryption is driven by the header; encryption is driven by the mode
 *
 * The asymmetry is deliberate. If a payload arrives marked `X-Payload-Encrypted: v1` we must
 * decrypt it or fail — handing an envelope to a controller is never right. But we do not *demand*
 * an envelope in `fields`/`full` mode, because that would lock out `curl`, the health probes,
 * T-050's E2E suite and any non-browser client, none of which have a WebCrypto stack, in exchange
 * for no threat-model gain: the traffic is on TLS either way and the modes exist to be turned
 * down (`off` is this task's documented rollback), not to be a second authentication factor.
 * Recorded in the completion report as an interpretation for the architect.
 *
 * `mode: 'off'` makes this interceptor a **complete no-op**, envelope or not. That is what makes
 * the rollback in the task file real: if decryption is the thing that has gone wrong in
 * production, flipping the mode has to stop it running, not merely stop it being required.
 *
 * ## 400 or 401
 *
 * Anything that says "the key you used is not your session's key" is a 401 — no session, no key
 * on the session, or a `kid` naming somebody else (TC-12, TC-14). Anything that says "we share a
 * key and this payload is broken" is a 400 with `PAYLOAD_DECRYPT_FAILED` and no detail (TC-11,
 * TC-15). `transport-crypto.exceptions.ts` argues why that split matters to the client.
 */
import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { resolveTraceId } from '@/common/errors/trace-id';
import type { AuthenticatedRequest } from '@/modules/auth/decorators/current-user.decorator';
import { CHAIN_SPAN, traceSpan } from '@/common/tracing/span.service';
import { HandshakeService } from './handshake.service';
import {
  PAYLOAD_ENCRYPTED_HEADER,
  sessionKid,
  TRANSPORT_ENVELOPE_VERSION,
} from './transport-crypto.constants';
import {
  PayloadDecryptFailedHttpException,
  TransportSessionInvalidHttpException,
} from './transport-crypto.exceptions';
import { TransportPolicyService } from './transport-policy.service';
import {
  EnvelopeError,
  isPayloadEnvelope,
  openBodyEnvelope,
  openEnvelope,
  WHOLE_BODY_PATH,
  type EnvelopeBinding,
} from './transport-envelope';

/**
 * Depth bound on the `fields`-mode walk, matching `MAX_RESPONSE_DEPTH` in T-017's masking
 * interceptor. A request body twelve levels deep is not a legitimate payload in this API, and an
 * unbounded walk over attacker-supplied JSON is a denial-of-service primitive.
 */
export const MAX_PAYLOAD_DEPTH = 12;

@Injectable()
export class PayloadDecryptInterceptor implements NestInterceptor {
  private readonly logger = new Logger(PayloadDecryptInterceptor.name);

  constructor(
    private readonly handshake: HandshakeService,
    private readonly transport: TransportPolicyService,
  ) {}

  /**
   * T-019 added the span wrapper and nothing else — the work is unchanged, in `decrypt`.
   * `payload.decrypt` is stage 6 of 08-OBSERVABILITY.md §5's waterfall. Unlike the two
   * response-side interceptors, this one does its work *inside* `intercept` (it must, before the
   * handler sees the body), so wrapping the method measures the real thing. `traceSpan` awaits
   * the promise for timing only and is a no-op outside a request; see `span.service.ts`.
   */
  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    return traceSpan(CHAIN_SPAN.PAYLOAD_DECRYPT, () => this.decrypt(context, next));
  }

  private async decrypt(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    if (context.getType() !== 'http') return next.handle();

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const mode = this.transport.modeFor(request.method, request.path);

    // `off` covers both the configured rollback and every always-cleartext route (TC-7, TC-9,
    // TC-10) — `TransportPolicyService.modeFor` folds the two together on purpose.
    if (mode === 'off') return next.handle();

    const marker = request.headers[PAYLOAD_ENCRYPTED_HEADER];
    if (marker === undefined) {
      // Nothing to decrypt — but resolve the key anyway, so the response side can encrypt without
      // a second database round trip. `keyForRequest` memoises on the request.
      await this.handshake.keyForRequest(request);
      return next.handle();
    }
    if (marker !== TRANSPORT_ENVELOPE_VERSION) {
      this.logger.warn(
        `Rejected a payload marked ${PAYLOAD_ENCRYPTED_HEADER}: ${describeMarker(marker)}; this ` +
          `build understands ${TRANSPORT_ENVELOPE_VERSION} only.`,
      );
      throw new PayloadDecryptFailedHttpException();
    }

    // R3: the session is the verified token's, never the envelope's.
    const sessionId = request.authUser?.sessionId;
    if (sessionId === undefined) {
      // A `@Public()` route that is not on the always-cleartext list, or a guard chain that never
      // ran. Either way there is no session and therefore no key.
      throw new TransportSessionInvalidHttpException();
    }

    const key = await this.handshake.keyForRequest(request);
    if (key === null) throw new TransportSessionInvalidHttpException();

    const kid = sessionKid(sessionId);
    const correlationId = resolveTraceId(request);

    request.body = this.decryptBody(request.body, key, kid, correlationId);

    return next.handle();
  }

  /**
   * A whole-body envelope (`full`) or a body containing field envelopes (`fields`).
   *
   * Which one is decided by **what arrived**, not by the configured mode. A server that trusted
   * the mode would break every client during the window in which the mode is being changed, and
   * would have no sensible behaviour for a `full`-mode envelope sent to a `fields`-mode route
   * override. Detection costs one shape test and removes the whole class of skew.
   */
  private decryptBody(body: unknown, key: Buffer, kid: string, correlationId: string): unknown {
    if (isPayloadEnvelope(body)) {
      this.assertOwnKid(body.kid, kid);
      return this.open(() =>
        openBodyEnvelope(key, body, {
          kid,
          direction: 'req',
          correlationId,
          path: WHOLE_BODY_PATH,
        }),
      );
    }

    return this.walk(body, key, kid, correlationId, '', 0);
  }

  /**
   * Replaces every field envelope in `value` with its plaintext, in place, keeping the path so
   * the AAD binds an envelope to the field it was written for (TC-13).
   */
  private walk(
    value: unknown,
    key: Buffer,
    kid: string,
    correlationId: string,
    path: string,
    depth: number,
  ): unknown {
    if (depth > MAX_PAYLOAD_DEPTH) return value;
    if (value === null || typeof value !== 'object') return value;

    if (isPayloadEnvelope(value)) {
      this.assertOwnKid(value.kid, kid);
      const binding: EnvelopeBinding = { kid, direction: 'req', correlationId, path };
      return this.open(() => JSON.parse(openEnvelope(key, value, binding)) as unknown);
    }

    if (Array.isArray(value)) {
      return value.map((item, index) =>
        this.walk(item, key, kid, correlationId, joinPath(path, String(index)), depth + 1),
      );
    }

    const out: Record<string, unknown> = {};
    for (const [property, raw] of Object.entries(value as Record<string, unknown>)) {
      out[property] = this.walk(raw, key, kid, correlationId, joinPath(path, property), depth + 1);
    }
    return out;
  }

  /**
   * An envelope naming another session is an **authentication** failure, not a parse failure —
   * task file implementation note 7 and TC-12. Raised before any cryptographic work is attempted,
   * so a wrong-session envelope costs nothing to reject.
   */
  private assertOwnKid(presented: string, expected: string): void {
    if (presented === expected) return;
    // The presented kid is not logged: it is attacker-controlled text, and T-014's redaction
    // rules exist precisely so unvalidated request content does not reach a log line verbatim.
    this.logger.warn(
      `Rejected an encrypted payload whose kid does not name the caller's own session ` +
        `(expected ${expected}).`,
    );
    throw new TransportSessionInvalidHttpException();
  }

  /**
   * Runs one decrypt, converting any {@link EnvelopeError} into the single opaque 400.
   *
   * A `SyntaxError` from `JSON.parse` on a *field* envelope lands here too — the plaintext opened
   * cleanly but was not the JSON this side writes, which is the same "we share a key and this
   * payload is broken" case and gets the same answer.
   */
  private open<T>(decrypt: () => T): T {
    try {
      return decrypt();
    } catch (error) {
      const reason = error instanceof EnvelopeError ? error.reason : 'not_json';
      // The reason stays here, with the correlation id the logger attaches. The client is told
      // only `PAYLOAD_DECRYPT_FAILED` (implementation note 8).
      this.logger.warn(`Payload decryption failed (${reason}).`);
      throw new PayloadDecryptFailedHttpException();
    }
  }
}

/** `a.b` + `c` → `a.b.c`; the root's children have no leading dot. */
function joinPath(parent: string, child: string): string {
  return parent === '' ? child : `${parent}.${child}`;
}

/** A type name for the log line, never the header's own value — it is caller-controlled. */
function describeMarker(marker: unknown): string {
  return Array.isArray(marker) ? 'the header was sent more than once' : 'an unsupported version';
}
