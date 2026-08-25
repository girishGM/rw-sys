/**
 * T-047 — the internal listener: gRPC over HTTP/2 with mutual TLS, plus the one internal REST
 * route §7a defines, on the same socket and therefore in the same trust domain.
 *
 * See `proto-codec.ts`'s header for why this is built on `node:http2` rather than on
 * `@grpc/grpc-js`. The wire format below is the published gRPC-over-HTTP/2 protocol:
 *
 * ```
 * request   :method POST · :path /<package>.<Service>/<Method> · content-type application/grpc+proto
 *           DATA: [0x00][uint32be length][message bytes]  (repeated for a streaming request)
 * response  :status 200 · content-type application/grpc
 *           DATA: same framing, one frame per response message
 *           TRAILERS: grpc-status: <code> · grpc-message: <percent-encoded text>
 * ```
 *
 * Two properties of that shape matter and are easy to get wrong:
 *
 *  1. **A failed RPC is still HTTP 200.** The status lives in the `grpc-status` trailer, not in
 *     `:status`. Returning HTTP 403 would make a conformant client report `UNKNOWN` and lose the
 *     `PERMISSION_DENIED` that 09-INTEGRATION.md §7 requires the caller to see.
 *  2. **Trailers must be sent even when the handler threw**, or the client hangs until its
 *     deadline rather than failing fast. Node's HTTP/2 API makes this sharper than it looks:
 *     `sendTrailers()` throws `ERR_HTTP2_TRAILERS_NOT_READY` unless the stream was answered with
 *     `respond(headers, { waitForTrailers: true })` and the trailers are sent from the
 *     `wantTrailers` event. Calling it directly throws — and the natural place to call it is the
 *     `catch` block that reports a *failed* RPC, so the throw escapes as an unhandled rejection and
 *     the caller hangs exactly in the case the code was written to avoid. {@link GrpcResponder}
 *     exists so that pairing cannot come apart: nothing else in this file touches `respond`,
 *     `write` or `sendTrailers`.
 *
 * ### Why the §7a REST callback shares this listener
 *
 * §7a: *"Same mTLS handshake and client-cert SAN allowlist as the gRPC port (§7) … it must not be
 * reachable from `/api/v1`."* Sharing one socket is the strongest available expression of both
 * halves: the callback cannot be reached without completing the same handshake, and it is not
 * mounted on the Express app at all, so no change to the portal's global guard chain can
 * accidentally expose it. HTTP/1.1 is permitted for this route (`allowHTTP1`) so an ordinary HTTP
 * client can call it; gRPC itself requires HTTP/2 and is refused over HTTP/1.1.
 */
import {
  createSecureServer,
  constants,
  type Http2SecureServer,
  type Http2ServerRequest,
  type Http2ServerResponse,
  type ServerHttp2Stream,
} from 'node:http2';
import type { TLSSocket, PeerCertificate } from 'node:tls';
import { GrpcError, GrpcStatus, type GrpcStatusCode } from '../grpc.errors';

/** What the TLS layer knows about the caller. */
export interface PeerIdentity {
  /** Whether the certificate chain validated against the configured CA. */
  readonly authorized: boolean;
  readonly authorizationError: string | null;
  /** Every subject-alternative name on the certificate, in `TYPE:value` form as Node reports it. */
  readonly subjectAltNames: readonly string[];
  /** The certificate subject's CN, when it has one. */
  readonly commonName: string | null;
  readonly hasCertificate: boolean;
}

/** One call, before any application decision has been made about it. */
export interface CallContext {
  readonly peer: PeerIdentity;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly remoteAddress: string;
  readonly path: string;
}

export type UnaryHandler = (context: CallContext, request: Buffer) => Promise<Buffer>;

/** A server-streaming handler. `emit` may be called until `signal` aborts (client went away). */
export type StreamHandler = (
  context: CallContext,
  request: Buffer,
  emit: (message: Buffer) => void,
  signal: AbortSignal,
) => Promise<void>;

export interface RestResult {
  readonly status: number;
  readonly body: unknown;
}

export type RestHandler = (
  context: CallContext,
  method: string,
  body: Buffer,
) => Promise<RestResult>;

export interface InternalListenerOptions {
  readonly port: number;
  readonly host: string;
  readonly key: string | Buffer;
  readonly cert: string | Buffer;
  readonly ca: string | Buffer | (string | Buffer)[];
  /** Extra headers added to every gRPC response — the documented client TTL lives here. */
  readonly responseHeaders?: Readonly<Record<string, string>>;
  readonly onError?: (message: string, error: unknown) => void;
}

/** `[0x00][uint32be length][message]` — one gRPC length-prefixed frame. */
export function frameMessage(message: Buffer): Buffer {
  const prefix = Buffer.allocUnsafe(5);
  prefix.writeUInt8(0, 0); // compressed-flag: this server never compresses
  prefix.writeUInt32BE(message.length, 1);
  return Buffer.concat([prefix, message]);
}

/** The inverse of {@link frameMessage}. Rejects a truncated or compressed frame rather than
 * guessing — a half-read request must never reach a handler. */
export function deframeMessages(buffer: Buffer): Buffer[] {
  const messages: Buffer[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 5 > buffer.length) {
      throw new GrpcError(GrpcStatus.INVALID_ARGUMENT, 'truncated gRPC frame header');
    }
    const compressed = buffer.readUInt8(offset);
    if (compressed !== 0) {
      throw new GrpcError(
        GrpcStatus.INVALID_ARGUMENT,
        'compressed gRPC frames are not accepted by this service',
      );
    }
    const length = buffer.readUInt32BE(offset + 1);
    if (offset + 5 + length > buffer.length) {
      throw new GrpcError(GrpcStatus.INVALID_ARGUMENT, 'truncated gRPC frame body');
    }
    messages.push(buffer.subarray(offset + 5, offset + 5 + length));
    offset += 5 + length;
  }
  return messages;
}

/**
 * Percent-encodes a `grpc-message` trailer.
 *
 * HTTP/2 header values are restricted to a narrow ASCII range; the gRPC specification defines
 * this encoding for the human-readable message so that a non-ASCII or control character in an
 * error string cannot corrupt the frame.
 */
export function encodeGrpcMessage(message: string): string {
  return [...Buffer.from(message, 'utf8')]
    .map((byte) =>
      byte >= 0x20 && byte <= 0x7e && byte !== 0x25
        ? String.fromCharCode(byte)
        : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`,
    )
    .join('');
}

function peerOf(socket: TLSSocket): PeerIdentity {
  const certificate: PeerCertificate | Record<string, never> =
    typeof socket.getPeerCertificate === 'function' ? socket.getPeerCertificate() : {};
  const hasCertificate = Object.keys(certificate).length > 0;
  const altNames = (certificate as PeerCertificate).subjectaltname;
  // `subject.CN` is typed `string` but is an **array** when a certificate carries more than one CN
  // (legal, and produced by some CAs). Taking the first is the only reading that is not a lie; a
  // cast would silently hand an array to a string comparison in the grant lookup.
  const commonName = (certificate as PeerCertificate).subject?.CN as string | string[] | undefined;
  return {
    authorized: socket.authorized === true,
    authorizationError:
      socket.authorizationError === undefined || socket.authorizationError === null
        ? null
        : String(socket.authorizationError),
    subjectAltNames: altNames === undefined ? [] : altNames.split(',').map((entry) => entry.trim()),
    commonName: Array.isArray(commonName) ? (commonName[0] ?? null) : (commonName ?? null),
    hasCertificate,
  };
}

/**
 * One gRPC response: headers, zero or more framed messages, and exactly one status trailer.
 *
 * All three of the ordering rules Node imposes live here and nowhere else:
 *
 *  - `respond()` must carry `waitForTrailers: true`, or `sendTrailers()` throws.
 *  - `sendTrailers()` must be called from the `wantTrailers` event, which Node emits after the
 *    final DATA frame — i.e. after `end()` — not before.
 *  - The stream must be ended exactly once, whether the handler returned or threw.
 *
 * {@link end} is therefore idempotent and safe to call on a destroyed stream: the client
 * disconnecting mid-call is normal (a `WatchCampaignConfig` subscriber going away), not an error.
 */
class GrpcResponder {
  private trailers: Record<string, string> = { 'grpc-status': String(GrpcStatus.OK) };
  private responded = false;
  private ended = false;

  constructor(
    private readonly stream: ServerHttp2Stream,
    private readonly extraHeaders: Readonly<Record<string, string>>,
    private readonly onError?: (message: string, error: unknown) => void,
  ) {}

  /** Sends `200 application/grpc+proto` and arms the trailer callback. Idempotent. */
  respond(): void {
    if (this.responded || this.stream.destroyed) return;
    this.responded = true;
    // `allowHTTP1` turns on Node's HTTP/1-compatibility layer, and that layer builds an
    // `Http2ServerResponse` for **every** stream — including the ones answered here — whose
    // constructor registers its own `wantTrailers` listener that calls `sendTrailers({})`. Two
    // listeners means two calls, and the second throws `ERR_HTTP2_TRAILERS_ALREADY_SENT`
    // asynchronously, from an event handler, where it becomes an uncaught exception and the caller
    // never learns the RPC's status. The compat response object is never used for a gRPC stream, so
    // its listener is removed rather than worked around.
    this.stream.removeAllListeners('wantTrailers');
    this.stream.on('wantTrailers', () => {
      if (this.stream.destroyed) return;
      try {
        this.stream.sendTrailers(this.trailers);
      } catch (error) {
        // Nothing useful is left to do — the peer either has its status or the stream is gone —
        // but throwing out of an event handler would take the process down with it.
        this.onError?.('gRPC trailers could not be sent', error);
      }
    });
    this.stream.respond(
      {
        [constants.HTTP2_HEADER_STATUS]: 200,
        [constants.HTTP2_HEADER_CONTENT_TYPE]: 'application/grpc+proto',
        ...this.extraHeaders,
      },
      { waitForTrailers: true },
    );
  }

  /** One length-prefixed message. Dropped silently once the peer has gone. */
  write(message: Buffer): void {
    if (this.stream.destroyed || !this.stream.writable) return;
    this.stream.write(frameMessage(message));
  }

  /** The status trailer, then the end of the stream. Safe to call twice; the first wins. */
  end(status: GrpcStatusCode, message: string): void {
    if (this.ended) return;
    this.ended = true;
    this.trailers = { 'grpc-status': String(status) };
    if (message !== '') this.trailers['grpc-message'] = encodeGrpcMessage(message);
    if (this.stream.destroyed) return;
    this.respond();
    this.stream.end();
  }
}

/**
 * The internal mTLS listener.
 *
 * Handlers are registered by **method name only** — the service name in the `:path` is checked
 * against the one this server serves, so a request for another service is `UNIMPLEMENTED`-shaped
 * (`NOT_FOUND`, per the gRPC mapping) rather than falling through to a handler that happens to
 * share a method name.
 */
export class InternalTlsListener {
  private readonly unary = new Map<string, UnaryHandler>();
  private readonly streaming = new Map<string, StreamHandler>();
  private rest: RestHandler | null = null;
  private server: Http2SecureServer | null = null;

  constructor(
    private readonly serviceFullName: string,
    private readonly options: InternalListenerOptions,
  ) {}

  registerUnary(method: string, handler: UnaryHandler): void {
    this.unary.set(method, handler);
  }

  registerStream(method: string, handler: StreamHandler): void {
    this.streaming.set(method, handler);
  }

  registerRest(handler: RestHandler): void {
    this.rest = handler;
  }

  /** The bound port, once listening. Zero means "not listening"; a test may pass port 0 and read
   * the ephemeral port back from here. */
  address(): number {
    const address = this.server?.address();
    return address !== null && typeof address === 'object' ? address.port : 0;
  }

  async listen(): Promise<void> {
    const server = createSecureServer({
      key: this.options.key,
      cert: this.options.cert,
      ca: this.options.ca,
      // The two options that make this mutual TLS. `rejectUnauthorized` refuses the *handshake*
      // for a missing or untrusted client certificate (TC-9, TC-10), before any byte of the
      // request is parsed and before any application code runs.
      requestCert: true,
      rejectUnauthorized: true,
      allowHTTP1: true,
      minVersion: 'TLSv1.2',
    });

    server.on('stream', (stream, headers) => {
      // `handleStream` reports every *expected* failure as a trailer. The `.catch` is for the
      // unexpected one — and it destroys the stream rather than leaving it open, because a caller
      // waiting on a socket that will never answer is a worse failure than a reset one.
      void this.handleStream(stream, headers).catch((error) => {
        this.report('gRPC stream failed', error);
        if (!stream.destroyed) stream.destroy();
      });
    });
    server.on('request', (request, response) => {
      // HTTP/1.1 fallback, for the §7a REST callback only.
      if (request.httpVersionMajor >= 2) return;
      void this.handleHttp1(request, response);
    });
    server.on('sessionError', (error) => this.report('gRPC session error', error));
    server.on('clientError', (error) => this.report('gRPC client error', error));
    server.on('tlsClientError', (error) => this.report('gRPC TLS client error', error));

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.options.port, this.options.host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.server = server;
  }

  async close(): Promise<void> {
    const server = this.server;
    if (server === null) return;
    this.server = null;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // `close()` waits for open sessions, and a held-open `WatchCampaignConfig` stream is exactly
      // that — its own client normally goes away first, but a shutdown must not depend on it. The
      // timer is the bound; it is `unref`'d so it cannot itself keep the process alive.
      setTimeout(() => resolve(), 2_000).unref();
    });
  }

  private report(message: string, error: unknown): void {
    this.options.onError?.(message, error);
  }

  private async handleStream(
    stream: ServerHttp2Stream,
    headers: Readonly<Record<string, string | string[] | undefined>>,
  ): Promise<void> {
    const path = String(headers[constants.HTTP2_HEADER_PATH] ?? '');
    const method = String(headers[constants.HTTP2_HEADER_METHOD] ?? 'GET');
    const socket = stream.session?.socket as TLSSocket;
    const context: CallContext = {
      peer: peerOf(socket),
      headers,
      remoteAddress: socket?.remoteAddress ?? 'unknown',
      path,
    };

    if (!path.startsWith(`/${this.serviceFullName}/`)) {
      await this.handleRestOverHttp2(stream, context, method);
      return;
    }

    const body = await readBody(stream);
    const rpc = path.slice(this.serviceFullName.length + 2);
    const streamHandler = this.streaming.get(rpc);
    const unaryHandler = this.unary.get(rpc);
    const responder = new GrpcResponder(
      stream,
      this.options.responseHeaders ?? {},
      (message, error) => this.report(message, error),
    );

    if (streamHandler === undefined && unaryHandler === undefined) {
      responder.end(GrpcStatus.NOT_FOUND, `unknown method ${rpc}`);
      return;
    }

    try {
      const messages = deframeMessages(body);
      const request = messages[0] ?? Buffer.alloc(0);

      responder.respond();

      if (streamHandler !== undefined) {
        const controller = new AbortController();
        stream.on('close', () => controller.abort());
        stream.on('error', () => controller.abort());
        await streamHandler(
          context,
          request,
          (message) => responder.write(message),
          controller.signal,
        );
      } else {
        responder.write(await (unaryHandler as UnaryHandler)(context, request));
      }

      responder.end(GrpcStatus.OK, '');
    } catch (error) {
      const grpc = asGrpcError(error);
      responder.end(grpc.status, grpc.message);
      if (!(error instanceof GrpcError)) this.report('gRPC handler failed', error);
    }
  }

  private async handleRestOverHttp2(
    stream: ServerHttp2Stream,
    context: CallContext,
    method: string,
  ): Promise<void> {
    const body = await readBody(stream);
    const result = await this.runRest(context, method, body);
    if (stream.destroyed) return;
    const payload = Buffer.from(JSON.stringify(result.body), 'utf8');
    stream.respond({
      [constants.HTTP2_HEADER_STATUS]: result.status,
      [constants.HTTP2_HEADER_CONTENT_TYPE]: 'application/json; charset=utf-8',
      [constants.HTTP2_HEADER_CONTENT_LENGTH]: payload.length,
    });
    stream.end(payload);
  }

  private async handleHttp1(
    request: Http2ServerRequest,
    response: Http2ServerResponse,
  ): Promise<void> {
    const socket = request.socket as TLSSocket;
    const context: CallContext = {
      peer: peerOf(socket),
      headers: request.headers,
      remoteAddress: socket.remoteAddress ?? 'unknown',
      path: request.url ?? '',
    };
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const result = await this.runRest(context, request.method ?? 'GET', Buffer.concat(chunks));
    const payload = Buffer.from(JSON.stringify(result.body), 'utf8');
    response.writeHead(result.status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': payload.length,
    });
    response.end(payload);
  }

  private async runRest(context: CallContext, method: string, body: Buffer): Promise<RestResult> {
    if (this.rest === null) {
      return { status: 404, body: { error: { code: 'NOT_FOUND' } } };
    }
    try {
      return await this.rest(context, method, body);
    } catch (error) {
      const grpc = asGrpcError(error);
      if (!(error instanceof GrpcError)) this.report('internal REST handler failed', error);
      return {
        status: httpStatusFor(grpc.status),
        body: { error: { code: statusCodeName(grpc.status), message: grpc.message } },
      };
    }
  }
}

async function readBody(stream: ServerHttp2Stream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** Anything a handler threw, as the status the peer should see. An unexpected error is
 * `INTERNAL` with a fixed message — the peer gets a code it can act on, and the detail goes to
 * the log rather than over the wire. */
export function asGrpcError(error: unknown): GrpcError {
  if (error instanceof GrpcError) return error;
  return new GrpcError(GrpcStatus.INTERNAL, 'internal error');
}

/** The HTTP status the §7a REST callback returns for a given gRPC status. */
export function httpStatusFor(status: GrpcStatusCode): number {
  switch (status) {
    case GrpcStatus.OK:
      return 200;
    case GrpcStatus.INVALID_ARGUMENT:
      return 400;
    case GrpcStatus.UNAUTHENTICATED:
      return 401;
    case GrpcStatus.PERMISSION_DENIED:
      return 403;
    case GrpcStatus.NOT_FOUND:
      return 404;
    case GrpcStatus.FAILED_PRECONDITION:
      return 409;
    case GrpcStatus.RESOURCE_EXHAUSTED:
      return 429;
    case GrpcStatus.UNAVAILABLE:
      return 503;
    default:
      return 500;
  }
}

function statusCodeName(status: GrpcStatusCode): string {
  const entry = Object.entries(GrpcStatus).find(([, value]) => value === status);
  return entry === undefined ? 'INTERNAL' : entry[0];
}
