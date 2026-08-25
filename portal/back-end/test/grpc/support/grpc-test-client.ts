/**
 * T-047 e2e support — a minimal gRPC client, so the tests speak the same protocol a generated
 * client would.
 *
 * It reads the `grpc-status`/`grpc-message` **trailers** rather than the HTTP status, exactly as a
 * conformant client does, which is what makes assertions like *"PERMISSION_DENIED naming the
 * section"* meaningful: if the server answered with an HTTP error instead of a trailer, a real
 * client would report `UNKNOWN` and this client reports the same thing.
 */
import { connect, constants, type ClientHttp2Session } from 'node:http2';
import { frameMessage, deframeMessages } from '@/grpc/wire/grpc-http2.server';

export interface GrpcCallResult {
  readonly httpStatus: number;
  readonly grpcStatus: number;
  readonly grpcMessage: string;
  readonly messages: readonly Buffer[];
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

export interface ClientOptions {
  readonly port: number;
  readonly ca: Buffer;
  readonly cert?: Buffer;
  readonly key?: Buffer;
  /** Extra request headers — used to present a portal cookie on this port (TC-12/TC-41). */
  readonly headers?: Record<string, string>;
}

function decodeGrpcMessage(value: string | undefined): string {
  if (value === undefined) return '';
  return decodeURIComponent(value.replace(/%(?![0-9A-Fa-f]{2})/g, '%25'));
}

/**
 * Opens a session and proves it is **usable**, or rejects — a rejection *is* the assertion for
 * TC-9, TC-10 and TC-38.
 *
 * ### Why it pings instead of resolving on `connect`
 *
 * Under TLS 1.3 the client sends its certificate *after* it has finished its own half of the
 * handshake, so `connect` fires on a session the server is about to tear down for having presented
 * no certificate or an untrusted one. Resolving there would make *"a client with no certificate
 * cannot even connect"* pass against a server that had `requestCert` switched off — the exact
 * regression the test exists to catch. An HTTP/2 PING round-trip is the cheapest thing that cannot
 * succeed unless the server accepted the peer, so the promise settles on that instead.
 */
export async function openSession(options: ClientOptions): Promise<ClientHttp2Session> {
  const session = connect(`https://localhost:${options.port}`, {
    ca: options.ca,
    cert: options.cert,
    key: options.key,
    servername: 'localhost',
  });
  await new Promise<void>((resolve, reject) => {
    const fail = (error: Error): void => {
      session.destroy();
      reject(error);
    };
    session.once('error', fail);
    session.once('close', () =>
      fail(new Error('the server closed the session before it was usable')),
    );
    session.once('connect', () => {
      session.ping((error) => {
        if (error !== null) return fail(error);
        session.removeAllListeners('error');
        session.removeAllListeners('close');
        resolve();
      });
    });
  });
  return session;
}

/** One unary call on an already-open session. */
export async function unary(
  session: ClientHttp2Session,
  path: string,
  request: Buffer,
  extraHeaders: Record<string, string> = {},
): Promise<GrpcCallResult> {
  return new Promise<GrpcCallResult>((resolve, reject) => {
    const stream = session.request({
      [constants.HTTP2_HEADER_METHOD]: 'POST',
      [constants.HTTP2_HEADER_PATH]: path,
      [constants.HTTP2_HEADER_CONTENT_TYPE]: 'application/grpc+proto',
      te: 'trailers',
      ...extraHeaders,
    });

    const chunks: Buffer[] = [];
    let headers: Record<string, string | string[] | undefined> = {};
    let trailers: Record<string, string | string[] | undefined> = {};

    stream.on('response', (received) => {
      headers = received as Record<string, string | string[] | undefined>;
    });
    stream.on('trailers', (received) => {
      trailers = received as Record<string, string | string[] | undefined>;
    });
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('close', () => {
      const body = Buffer.concat(chunks);
      resolve({
        httpStatus: Number(headers[constants.HTTP2_HEADER_STATUS] ?? 0),
        grpcStatus: Number(trailers['grpc-status'] ?? -1),
        grpcMessage: decodeGrpcMessage(trailers['grpc-message'] as string | undefined),
        messages: body.length === 0 ? [] : deframeMessages(body),
        headers,
      });
    });

    stream.end(frameMessage(request));
  });
}

/** A server-streaming call. Returns a handle whose `messages` fill in as they arrive. */
export function serverStream(
  session: ClientHttp2Session,
  path: string,
  request: Buffer,
): { readonly messages: Buffer[]; close: () => void; readonly done: Promise<void> } {
  const stream = session.request({
    [constants.HTTP2_HEADER_METHOD]: 'POST',
    [constants.HTTP2_HEADER_PATH]: path,
    [constants.HTTP2_HEADER_CONTENT_TYPE]: 'application/grpc+proto',
    te: 'trailers',
  });

  const messages: Buffer[] = [];
  let pending = Buffer.alloc(0);
  const done = new Promise<void>((resolve) => {
    stream.on('close', () => resolve());
    stream.on('error', () => resolve());
  });

  stream.on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    // Frames may split across DATA chunks; consume only whole ones.
    for (;;) {
      if (pending.length < 5) return;
      const length = pending.readUInt32BE(1);
      if (pending.length < 5 + length) return;
      messages.push(pending.subarray(5, 5 + length));
      pending = pending.subarray(5 + length);
    }
  });

  stream.end(frameMessage(request));
  return { messages, close: () => stream.close(), done };
}

/** A plain JSON request on the same listener — the §7a internal REST callback. */
export async function postJson(
  session: ClientHttp2Session,
  path: string,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const stream = session.request({
      [constants.HTTP2_HEADER_METHOD]: 'POST',
      [constants.HTTP2_HEADER_PATH]: path,
      [constants.HTTP2_HEADER_CONTENT_TYPE]: 'application/json',
      [constants.HTTP2_HEADER_CONTENT_LENGTH]: payload.length,
      ...extraHeaders,
    });
    const chunks: Buffer[] = [];
    let status = 0;
    stream.on('response', (headers) => {
      status = Number(headers[constants.HTTP2_HEADER_STATUS] ?? 0);
    });
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('close', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      resolve({ status, body: text === '' ? null : JSON.parse(text) });
    });
    stream.end(payload);
  });
}
