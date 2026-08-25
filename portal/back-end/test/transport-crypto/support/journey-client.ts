/**
 * T-018 e2e support — a **client** that behaves the way the SPA will, for the six-role journey
 * suite (TC-18, verification steps 4–6).
 *
 * ### Why this exists at all
 *
 * TC-18 and the Definition of Done ask for the E2E journeys to be green *in all three modes*. The
 * suite that will run those journeys through a browser is T-050's, and it cannot exist yet — no
 * SPA screen does. What can exist, and is what this file makes possible, is the same journeys
 * driven through the **real API**, by a client that makes the same decisions the browser library
 * makes, against the real Nest application and the real Postgres database.
 *
 * ### What it does and does not prove
 *
 * It uses the *server's* codec (`sealEnvelope`/`openEnvelope`) rather than
 * `front-end/src/lib/transportCrypto.ts`, for a boring reason: the front-end library is written
 * against the DOM's `Crypto`/`Headers` types and does not typecheck under the back end's
 * `tsconfig`. The evidence chain is closed elsewhere and in two links rather than one:
 *
 *  1. `front-end/test/lib/transportCrypto.spec.ts` runs the **real** browser library over real
 *     WebCrypto and asserts it interoperates with this exact Node codec, in both directions,
 *     including the HKDF derivation (T-018 TC-1, TC-5).
 *  2. This file asserts the Node codec interoperates with the running server, per role, per mode.
 *
 * What it deliberately mirrors rather than imports is the *decision* logic — "should this request
 * be encrypted, and how much of it?" — because that logic is what a client must get right and
 * because copying it here means a server-side change that silently alters the answer shows up as a
 * failing journey rather than as a passing one. The rules are the four lines of
 * `transportModeFor` in the browser library and `TransportPolicyService.modeFor` on the server.
 */
import { createECDH, randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { boundBaseUrl } from '../../security/support/bound-app';
import { CORRELATION_HEADER } from '@/common/errors/trace-id';
import { CSRF_COOKIE_NAME } from '@/modules/auth/session.constants';
import { normaliseRouteOverrideKey } from '@/common/data-protection/data-protection.config';
import { deriveTransportKey } from '@/common/transport-crypto/handshake.service';
import {
  isAlwaysCleartext,
  normalisePath,
  PAYLOAD_ENCRYPTED_HEADER,
  TRANSPORT_ENVELOPE_VERSION,
  TRANSPORT_KID_HEADER,
  TRANSPORT_POLICY_HEADER,
  TRANSPORT_PUBLIC_KEY_HEADER,
  type TransportPolicyAdvertisement,
} from '@/common/transport-crypto/transport-crypto.constants';
import {
  isPayloadEnvelope,
  openEnvelope,
  sealEnvelope,
  WHOLE_BODY_PATH,
} from '@/common/transport-crypto/transport-envelope';

export type TransportMode = 'off' | 'fields' | 'full';

/** One request/response pair, with both the wire form and the plaintext the client ends up with. */
export interface Exchange {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  /** Exactly what left the client, as it appeared on the wire. */
  readonly requestText: string;
  /** Exactly what arrived, before the client opened anything. */
  readonly responseText: string;
  /** The response as the application layer sees it — envelopes opened, if there were any. */
  readonly body: unknown;
  readonly requestEncrypted: boolean;
  readonly responseEncrypted: boolean;
  readonly correlationId: string;
}

/** The cookie/CSRF pair a logged-in client holds, plus its transport key when it has one. */
export class JourneyClient {
  private readonly ecdh = createECDH('prime256v1');
  readonly publicKeyBase64: string;

  private key: Buffer | null = null;
  private kid: string | null = null;
  private policy: TransportPolicyAdvertisement | null = null;

  jar = '';
  csrf = '';

  private counter = 0;

  constructor(private readonly app: INestApplication) {
    this.publicKeyBase64 = this.ecdh.generateKeys().toString('base64');
  }

  /** The one header a client offers at handshake time. */
  handshakeHeaders(): Record<string, string> {
    return { [TRANSPORT_PUBLIC_KEY_HEADER]: this.publicKeyBase64 };
  }

  /**
   * Takes whatever handshake material a response happens to carry.
   *
   * Split deliberately: the policy advertisement arrives on the login response and the key
   * material on whichever response *issued the session* — the login for five roles, the MFA
   * verify for `super_admin`. A real SPA has to absorb both, from two different responses, and so
   * does this.
   */
  adopt(response: request.Response): void {
    const advertisement = response.headers[TRANSPORT_POLICY_HEADER];
    if (typeof advertisement === 'string') {
      this.policy = JSON.parse(advertisement) as TransportPolicyAdvertisement;
    }

    const serverPublicKey = response.headers[TRANSPORT_PUBLIC_KEY_HEADER];
    const kid = response.headers[TRANSPORT_KID_HEADER];
    if (typeof serverPublicKey === 'string' && typeof kid === 'string') {
      const peer = Buffer.from(serverPublicKey, 'base64');
      const shared = this.ecdh.computeSecret(peer);
      this.key = deriveTransportKey(shared, Buffer.from(this.publicKeyBase64, 'base64'), peer);
      shared.fill(0);
      this.kid = kid;
    }

    const cookies = response.headers['set-cookie'];
    if (cookies !== undefined) this.absorbCookies(Array.isArray(cookies) ? cookies : [cookies]);
  }

  get hasTransportKey(): boolean {
    return this.key !== null;
  }

  get advertisedPolicy(): TransportPolicyAdvertisement | null {
    return this.policy;
  }

  /** Forgets the transport key — what `resetTransport()` does in the browser (R5, logout). */
  forgetKey(): void {
    this.key = null;
    this.kid = null;
  }

  /**
   * The client's own copy of the routing decision, mirroring `TransportPolicyService.modeFor`:
   * always-cleartext first (so no override can switch encryption on for the login), then the
   * per-route override, then the global mode.
   */
  modeFor(method: string, path: string): TransportMode {
    if (this.policy === null) return 'off';
    if (isAlwaysCleartext(path)) return 'off';

    const key = normaliseRouteOverrideKey(`${method.toUpperCase()} ${normalisePath(path)}`);
    return (this.policy.routeOverrides[key] ?? this.policy.mode) as TransportMode;
  }

  /**
   * Sends one request the way the SPA would, and hands back both the wire form and the plaintext.
   *
   * The correlation id is generated per request and sent as `X-Correlation-Id`, because it is
   * **authenticated data**: a client that did not send one could not reconstruct the AAD of the
   * response. That is the contract T-022 inherits, written down in the T-018 completion report.
   */
  async send(
    method: 'get' | 'post' | 'patch' | 'delete',
    path: string,
    body?: unknown,
  ): Promise<Exchange> {
    const correlationId = this.nextCorrelationId();
    const mode = body === undefined ? 'off' : this.modeFor(method, path);

    let payload = body;
    let requestEncrypted = false;
    if (body !== undefined && mode !== 'off' && this.key !== null && this.kid !== null) {
      const sealed = this.sealRequest(mode, body, correlationId);
      payload = sealed.payload;
      requestEncrypted = sealed.encrypted;
    }

    // T-087: one already-bound listener instead of a fresh ephemeral port per request. This
    // client is handed an app it does not own the lifecycle of, so `boundBaseUrl` reuses the
    // caller's listener when there is one and binds once when there is not. See
    // `test/security/support/bound-app.ts`.
    let call = request(await boundBaseUrl(this.app))
      [method](`/api/v1${path}`)
      .set(CORRELATION_HEADER, correlationId);

    if (this.jar !== '') call = call.set('Cookie', this.jar);
    if (this.csrf !== '' && method !== 'get') call = call.set('X-CSRF-Token', this.csrf);
    if (requestEncrypted) call = call.set(PAYLOAD_ENCRYPTED_HEADER, TRANSPORT_ENVELOPE_VERSION);

    const response = payload === undefined ? await call : await call.send(payload as object);

    const cookies = response.headers['set-cookie'];
    if (cookies !== undefined) this.absorbCookies(Array.isArray(cookies) ? cookies : [cookies]);

    return {
      status: response.status,
      headers: response.headers,
      requestText: payload === undefined ? '' : JSON.stringify(payload),
      responseText: response.text ?? '',
      body: this.openResponse(response),
      requestEncrypted,
      responseEncrypted: response.headers[PAYLOAD_ENCRYPTED_HEADER] !== undefined,
      correlationId,
    };
  }

  // --- internals -------------------------------------------------------------------------------

  private nextCorrelationId(): string {
    this.counter += 1;
    // Matches `CORRELATION_ID_PATTERN` (`[A-Za-z0-9_-]{8,64}`), so the server adopts it rather
    // than minting its own — which it must, or the AAD would not agree.
    return `t018-journey-${this.counter}-${randomBytes(6).toString('hex')}`;
  }

  private sealRequest(
    mode: TransportMode,
    body: unknown,
    correlationId: string,
  ): { payload: unknown; encrypted: boolean } {
    const key = this.key as Buffer;
    const kid = this.kid as string;

    if (mode === 'full') {
      return {
        payload: sealEnvelope(key, JSON.stringify(body), {
          kid,
          direction: 'req',
          correlationId,
          path: WHOLE_BODY_PATH,
        }),
        encrypted: true,
      };
    }

    // `fields`: encrypt exactly the field names the server advertised, at any depth, in place.
    const flagged = new Set(this.policy?.fields ?? []);
    const counter = { count: 0 };
    const sealed = this.sealFields(body, '', flagged, counter, correlationId, 0);
    return { payload: sealed, encrypted: counter.count > 0 };
  }

  private sealFields(
    value: unknown,
    path: string,
    flagged: ReadonlySet<string>,
    counter: { count: number },
    correlationId: string,
    depth: number,
  ): unknown {
    if (depth > 12 || value === null || typeof value !== 'object') return value;

    if (Array.isArray(value)) {
      return value.map((item, index) =>
        this.sealFields(
          item,
          join(path, String(index)),
          flagged,
          counter,
          correlationId,
          depth + 1,
        ),
      );
    }

    const out: Record<string, unknown> = {};
    for (const [property, raw] of Object.entries(value as Record<string, unknown>)) {
      const childPath = join(path, property);
      if (flagged.has(property) && raw !== undefined) {
        out[property] = sealEnvelope(this.key as Buffer, JSON.stringify(raw), {
          kid: this.kid as string,
          direction: 'req',
          correlationId,
          path: childPath,
        });
        counter.count += 1;
        continue;
      }
      out[property] = this.sealFields(raw, childPath, flagged, counter, correlationId, depth + 1);
    }
    return out;
  }

  /** Opens whatever the response carried: a whole-body envelope, field envelopes, or nothing. */
  private openResponse(response: request.Response): unknown {
    if (response.headers[PAYLOAD_ENCRYPTED_HEADER] === undefined) return response.body;
    if (this.key === null || this.kid === null) {
      throw new Error('an encrypted response arrived but this client holds no transport key');
    }

    const correlationId = response.headers[CORRELATION_HEADER];
    if (typeof correlationId !== 'string') {
      throw new Error('an encrypted response carried no correlation id to build the AAD from');
    }

    const body: unknown = response.body;
    if (isPayloadEnvelope(body)) {
      return JSON.parse(
        openEnvelope(this.key, body, {
          kid: this.kid,
          direction: 'res',
          correlationId,
          path: WHOLE_BODY_PATH,
        }),
      );
    }
    return this.openFields(body, '', correlationId, 0);
  }

  private openFields(value: unknown, path: string, correlationId: string, depth: number): unknown {
    if (depth > 12 || value === null || typeof value !== 'object') return value;

    if (isPayloadEnvelope(value)) {
      return JSON.parse(
        openEnvelope(this.key as Buffer, value, {
          kid: this.kid as string,
          direction: 'res',
          correlationId,
          path,
        }),
      );
    }

    if (Array.isArray(value)) {
      return value.map((item, index) =>
        this.openFields(item, join(path, String(index)), correlationId, depth + 1),
      );
    }

    const out: Record<string, unknown> = {};
    for (const [property, raw] of Object.entries(value as Record<string, unknown>)) {
      out[property] = this.openFields(raw, join(path, property), correlationId, depth + 1);
    }
    return out;
  }

  private absorbCookies(cookies: readonly string[]): void {
    const jar = new Map<string, string>();
    for (const pair of this.jar.split('; ').filter((entry) => entry !== '')) {
      const at = pair.indexOf('=');
      jar.set(pair.slice(0, at), pair.slice(at + 1));
    }

    for (const cookie of cookies) {
      const [pair] = cookie.split(';');
      const at = pair.indexOf('=');
      const name = pair.slice(0, at);
      const value = pair.slice(at + 1);
      // A cleared cookie arrives with an empty value — a logout has to empty the jar, or the next
      // request would present a cookie the browser would already have dropped.
      if (value === '') jar.delete(name);
      else jar.set(name, value);
      if (name === CSRF_COOKIE_NAME) this.csrf = decodeURIComponent(value);
    }

    this.jar = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
  }
}

function join(parent: string, child: string): string {
  return parent === '' ? child : `${parent}.${child}`;
}
