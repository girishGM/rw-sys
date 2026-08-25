/**
 * T-018 — enforcement point ①, outbound (07-DATA-PROTECTION.md §5 and §8).
 *
 * ```
 * entity → response DTO → mask by caller role → serialise → ENCRYPT ENVELOPE → send
 *                                                            ▲
 *                                                            └─ this file
 * ```
 *
 * ---
 *
 * ## The ordering constraint, stated where it can be broken
 *
 * §8 fixes the order as `DTO → mask → serialise → encrypt`, and Nest runs interceptors'
 * response-side logic in **reverse** registration order — so this interceptor must be registered
 * **before** `DataProtectionModule`'s `ResponseMaskingInterceptor` in order to run **after** it.
 * `TransportCryptoModule` therefore sits immediately before `DataProtectionModule` in
 * `AppModule.imports`, and `data-protection.module.ts` carries the same note from the other side.
 *
 * Get it backwards and the envelope is built from the *unmasked* body: every masked field is
 * shipped in full to a client that can decrypt it, and **nothing visibly fails** — the response
 * still decrypts, still has the right shape, and still passes every test that does not look
 * inside. That is why TC-17 exists and why it is the test to run first after touching this file.
 *
 * ## Encryption is driven by the mode; decryption is driven by the header
 *
 * The inbound half decrypts whatever arrives marked; the outbound half encrypts what
 * `config/data-protection.json` says to encrypt, and only when the session actually holds a
 * transport key. A caller that never handshook (`curl`, a health probe, T-050's E2E suite) gets
 * cleartext over TLS rather than an envelope it could never open — see
 * `payload-decrypt.interceptor.ts`'s header for the full argument.
 *
 * ## Errors are never encrypted, and that is a feature
 *
 * Exception filters run **outside** the interceptor chain in Nest, so an error response never
 * reaches this code. That falls out of the framework, but it is exactly what is wanted: TC-11
 * requires the client to be able to *read* `PAYLOAD_DECRYPT_FAILED`, and an error envelope that
 * could only be opened by the crypto layer that has just failed would be unreadable precisely
 * when it matters. T-014 already guarantees an error body carries nothing but a catalogue code, a
 * catalogue message and a trace id, so there is nothing in one to protect.
 *
 * ## A failure here fails the request rather than falling back to cleartext
 *
 * If `sealEnvelope` or `JSON.stringify` throws, the error propagates and the filter answers 500.
 * The alternative — log it and send the body in the clear — is a silent downgrade of the exact
 * control this file exists to apply, and AGENT-PROTOCOL §7 is explicit that a guard is never
 * weakened to keep something green.
 */
import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import type { Response } from 'express';
import type { Observable } from 'rxjs';
import { concatMap } from 'rxjs/operators';
import { CORRELATION_HEADER, resolveTraceId } from '@/common/errors/trace-id';
import { CHAIN_SPAN, traceSpan } from '@/common/tracing/span.service';
import type { AuthenticatedRequest } from '@/modules/auth/decorators/current-user.decorator';
import { HandshakeService } from './handshake.service';
import {
  normalisePath,
  PAYLOAD_ENCRYPTED_HEADER,
  sessionKid,
  TRANSPORT_ENVELOPE_VERSION,
  TRANSPORT_POLICY_HEADER,
  TRANSPORT_PUBLIC_KEY_HEADER,
} from './transport-crypto.constants';
import { MAX_PAYLOAD_DEPTH } from './payload-decrypt.interceptor';
import { TransportPolicyService } from './transport-policy.service';
import { sealEnvelope, WHOLE_BODY_PATH, type EnvelopeBinding } from './transport-envelope';

/** The route whose response carries the policy advertisement. */
const LOGIN_PATH = '/auth/login';

@Injectable()
export class PayloadEncryptInterceptor implements NestInterceptor {
  private readonly logger = new Logger(PayloadEncryptInterceptor.name);

  constructor(
    private readonly handshake: HandshakeService,
    private readonly transport: TransportPolicyService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const http = context.switchToHttp();
    const request = http.getRequest<AuthenticatedRequest>();
    const response = http.getResponse<Response>();

    // T-019 wrapped the encryption work — `response.encrypt`, the other half of stage 9 in
    // 08-OBSERVABILITY.md §5's waterfall (`response.mask + encrypt`), recorded as its own span so
    // an incident can tell which of the two is slow. Around the `concatMap` callback rather than
    // around `intercept`, which only builds the observable. No-op outside a request.
    return next
      .handle()
      .pipe(
        concatMap((body) =>
          traceSpan(CHAIN_SPAN.RESPONSE_ENCRYPT, () => this.encrypt(body, request, response)),
        ),
      );
  }

  private async encrypt(
    body: unknown,
    request: AuthenticatedRequest,
    response: Response,
  ): Promise<unknown> {
    // Advertised before the mode check, because the one route that needs the advertisement —
    // `POST /auth/login` — is permanently `off` by construction. Only offered to a client that
    // opened the handshake, so an ordinary `curl` login is byte-identical to what it was.
    if (
      normalisePath(request.path) === LOGIN_PATH &&
      request.headers[TRANSPORT_PUBLIC_KEY_HEADER] !== undefined
    ) {
      response.setHeader(TRANSPORT_POLICY_HEADER, JSON.stringify(this.transport.advertisement()));
    }

    const mode = this.transport.modeFor(request.method, request.path);
    if (mode === 'off') return body;
    if (!isEncryptableBody(body)) return body;

    const sessionId = request.authUser?.sessionId;
    if (sessionId === undefined) return body;

    const key = await this.handshake.keyForRequest(request);
    if (key === null) return body;

    const kid = sessionKid(sessionId);
    const correlationId = resolveTraceId(request);

    if (mode === 'full') {
      const envelope = sealEnvelope(key, JSON.stringify(body), {
        kid,
        direction: 'res',
        correlationId,
        path: WHOLE_BODY_PATH,
      });
      this.markEncrypted(response, correlationId);
      return envelope;
    }

    const encrypted = { count: 0 };
    const out = this.walk(body, key, kid, correlationId, '', 0, encrypted);
    // The original object is returned when nothing was flagged, rather than the rebuilt copy.
    // The walk necessarily produces plain objects, and a route exempt from response masking
    // (`RevealController`) may still be holding a class instance whose identity a serialiser
    // downstream could care about. Rebuilding it for no gain is a change nobody asked for.
    if (encrypted.count === 0) return body;

    this.markEncrypted(response, correlationId);
    return out;
  }

  /**
   * Replaces every policy-flagged field with an envelope, in place — `fields` mode (TC-6).
   *
   * The value is JSON-encoded before it is sealed, so a flagged field holding a number, a boolean
   * or a whole object round-trips as itself rather than as a string. The same convention is used
   * inbound; `payload-decrypt.interceptor.ts` parses what this writes.
   *
   * A flagged field is **not** descended into: once a field is encrypted, its interior is
   * ciphertext and there is nothing further to look at.
   */
  private walk(
    value: unknown,
    key: Buffer,
    kid: string,
    correlationId: string,
    path: string,
    depth: number,
    encrypted: { count: number },
  ): unknown {
    if (depth > MAX_PAYLOAD_DEPTH) return value;
    if (value === null || typeof value !== 'object') return value;
    if (value instanceof Date) return value;

    if (Array.isArray(value)) {
      return value.map((item, index) =>
        this.walk(
          item,
          key,
          kid,
          correlationId,
          joinPath(path, String(index)),
          depth + 1,
          encrypted,
        ),
      );
    }

    const out: Record<string, unknown> = {};
    for (const [property, raw] of Object.entries(value as Record<string, unknown>)) {
      const childPath = joinPath(path, property);

      if (raw !== undefined && this.transport.isPayloadEncryptField(property)) {
        const binding: EnvelopeBinding = { kid, direction: 'res', correlationId, path: childPath };
        out[property] = sealEnvelope(key, JSON.stringify(raw), binding);
        encrypted.count += 1;
        continue;
      }

      out[property] = this.walk(raw, key, kid, correlationId, childPath, depth + 1, encrypted);
    }
    return out;
  }

  /**
   * Tells the client the body is an envelope, and which correlation id its AAD was built from.
   *
   * The correlation id is echoed because it is **authenticated data**: a client that did not send
   * an `X-Correlation-Id` of its own could not otherwise reconstruct the AAD and would fail every
   * decryption. T-019 owns the general correlation layer and will set the same header from the
   * same `resolveTraceId` seam, so the two agree by construction rather than by coincidence.
   */
  private markEncrypted(response: Response, correlationId: string): void {
    response.setHeader(PAYLOAD_ENCRYPTED_HEADER, TRANSPORT_ENVELOPE_VERSION);
    response.setHeader(CORRELATION_HEADER, correlationId);
  }
}

/**
 * Whether a handler's return value is something this interceptor may turn into an envelope.
 *
 * `undefined`/`null` are the 204 responses, which have no body. A `Buffer`, a `Date`, a stream or
 * a `StreamableFile` is passed through untouched: `JSON.stringify` would silently mangle each of
 * them, and this task's scope is JSON payloads (07-DATA-PROTECTION.md §5 shows nothing else). A
 * scalar body is likewise left alone — every endpoint in this API answers with the
 * `{ data: … }` envelope of 03-API-CONTRACT.md §1, so a bare string is not a case to design for.
 *
 * Class instances **are** accepted, not only plain objects. In the normal path
 * `ResponseMaskingInterceptor` has already rebuilt the body into plain objects, but a route
 * carrying `@NoResponseMasking` (`RevealController`) has not — and refusing to encrypt exactly
 * the endpoint that exists to return one plaintext value would be the wrong way round.
 */
export function isEncryptableBody(body: unknown): boolean {
  if (body === null || body === undefined) return false;
  if (typeof body !== 'object') return false;
  if (body instanceof Date || Buffer.isBuffer(body)) return false;
  const candidate = body as { pipe?: unknown; getStream?: unknown };
  if (typeof candidate.pipe === 'function') return false;
  if (typeof candidate.getStream === 'function') return false;
  return true;
}

/** `a.b` + `c` → `a.b.c`. Mirrors the inbound walk so the two AAD paths cannot drift. */
function joinPath(parent: string, child: string): string {
  return parent === '' ? child : `${parent}.${child}`;
}
