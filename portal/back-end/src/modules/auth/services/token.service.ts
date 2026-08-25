/**
 * T-011 — token minting and verification: the RS256 access JWT, the opaque refresh token, and
 * the session-bound CSRF value.
 *
 * ---
 *
 * ### Why this file implements JWS itself instead of using a library
 *
 * A deliberate decision, and the one thing in this task most worth a reviewer's attention.
 *
 * The workspace has no JWT dependency, and this environment cannot install one. Rather than
 * treat that as a blocker, note what the alternative actually buys: a JWS compact-serialisation
 * *encoder and decoder*. All of the cryptography — RSASSA-PKCS1-v1_5 over SHA-256 — is done by
 * Node's `crypto`, exactly as it would be inside `jsonwebtoken`. What is left is string
 * splitting, base64url and a list of claim assertions, and it is precisely those claim
 * assertions that every published JWT vulnerability has lived in: `alg: none` accepted because
 * the decoder trusted the header, HMAC-vs-RSA confusion because the verifier chose its
 * algorithm from attacker-controlled input, an unverified `decode()` used where `verify()` was
 * meant.
 *
 * Implementing it here makes those failure modes structurally unreachable rather than
 * correctly-configured:
 *
 *  - **There is no HMAC code path in this file at all.** Not a disabled one, not a
 *    conditionally-selected one — `crypto.verify` is called with an RSA `KeyObject` that is
 *    validated as RSA at construction. An attacker who sets `alg: HS256` is not choosing a
 *    weaker branch; they are choosing a branch that does not exist (TC-11).
 *  - **The algorithm is never read from the token to decide what to do.** It is read only to
 *    be compared against {@link JWT_ALLOWED_ALGORITHMS} and rejected if it differs, which is
 *    the same check with the causality the right way round (TC-10).
 *  - **There is no `decode()` to misuse.** The only function that returns claims is the one
 *    that verifies the signature first, and it returns them only after every registered claim
 *    has been asserted. A future caller cannot reach for the unsafe variant because none is
 *    exported.
 *
 * This mirrors the precedent already set in `src/common/crypto/` (T-016), which builds
 * AES-256-GCM and HKDF over `node:crypto` for the same reasons. Flagged in the completion
 * report so the architect can overrule it — if a library is preferred, `signAccessToken` and
 * `verifyAccessToken` are the only two methods that would change, and their tests would not.
 *
 * ---
 *
 * ### What this service does *not* do
 *
 * It reads no database and makes no authorisation decision. It is handed claims and returns a
 * string, or is handed a string and returns claims. Whether the session behind `sid` is still
 * alive is `SessionValidGuard`'s question, deliberately kept separate: a valid signature means
 * "this token was minted by us and has not been altered", never "this request is allowed".
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  constants as cryptoConstants,
  createHmac,
  createPrivateKey,
  createPublicKey,
  createHash,
  hkdfSync,
  randomBytes,
  randomUUID,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';
import type { Env } from '@/config/env.schema';
import type { PortalRole } from '@/database/portal-models';
import {
  JWT_ALLOWED_ALGORITHMS,
  JWT_AUDIENCE,
  JWT_ISSUER,
  JWT_MAX_LENGTH,
  JWT_MIN_MODULUS_LENGTH,
  JWT_SIGNING_ALGORITHM,
  ACCESS_TOKEN_TTL_SECONDS,
} from '../session.constants';

/** The six roles, as a runtime set — a `role` claim outside it is a forged or stale token. */
const PORTAL_ROLES: ReadonlySet<string> = new Set<PortalRole>([
  'super_admin',
  'country_admin',
  'tenant_admin',
  'maker',
  'checker',
  'merchant',
]);

/**
 * The scope and identity a caller's access token asserts (02-SECURITY.md §1).
 *
 * Every field here originates in `portal_users`, is signed by this service, and is re-derived
 * from the database on every refresh (§3, AR-04). **This is the only structure downstream code
 * may read a tenant, country, merchant or role from** (R3): a value with the same name arriving
 * in a DTO is, by definition, a bug.
 */
export interface AccessTokenClaims {
  /** `portal_users.id`. */
  readonly userId: number;
  /** `portal_sessions.id` — minted server-side; the client never proposes one. */
  readonly sessionId: string;
  readonly role: PortalRole;
  readonly countryId: number | null;
  readonly tenantId: number | null;
  readonly merchantId: number | null;
  /** `rbac_cache_config.rbac_version:<role>` at issue time. Consumed by T-013's cache. */
  readonly rbacVersion: number;
  /** This token's own unique id, for correlating a single token across audit rows. */
  readonly tokenId: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

/** What a caller supplies to mint a token; the timestamps and `jti` are added here. */
export type AccessTokenInput = Omit<AccessTokenClaims, 'tokenId' | 'issuedAt' | 'expiresAt'>;

export interface MintedAccessToken {
  readonly token: string;
  readonly claims: AccessTokenClaims;
}

export interface MintedOpaqueToken {
  /** Handed to the client once, in a cookie or a link, and never stored anywhere. */
  readonly raw: string;
  /** SHA-256 of {@link raw}, hex. The only form that touches the database. */
  readonly hash: string;
}

/**
 * Verification failure. Carries a short machine reason **for the server log only** — the guard
 * that catches this answers with `SessionInvalidHttpException`, which has nowhere to put it.
 * See `auth.errors.ts` for the same argument applied to login failures.
 */
export class InvalidAccessTokenError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`Access token rejected: ${reason}`);
    this.name = 'InvalidAccessTokenError';
    this.reason = reason;
    Error.captureStackTrace?.(this, InvalidAccessTokenError);
  }
}

/** Thrown at construction. A boot-time failure, never reachable from a request. */
export class SigningKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SigningKeyError';
    Error.captureStackTrace?.(this, SigningKeyError);
  }
}

/** The JOSE header this service emits and the only shape it accepts. */
interface JoseHeader {
  alg: string;
  typ?: string;
  kid?: string;
  crit?: unknown;
}

/** The registered + private claim set, as it appears on the wire (seconds, snake-free). */
interface JwtPayload {
  iss: string;
  aud: string;
  sub: string;
  sid: string;
  role: string;
  countryId: number | null;
  tenantId: number | null;
  merchantId: number | null;
  rbacVersion: number;
  jti: string;
  iat: number;
  nbf: number;
  exp: number;
}

@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);

  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;
  /** Header `kid`. Rotation-ready: a token minted under another key is rejected outright. */
  private readonly keyId: string;
  /** HMAC key for the session-bound CSRF value. See {@link csrfTokenFor}. */
  private readonly csrfKey: Buffer;

  constructor(configService: ConfigService<Env, true>) {
    const privatePem = normalisePem(configService.get('JWT_PRIVATE_KEY', { infer: true }));
    const publicPem = normalisePem(configService.get('JWT_PUBLIC_KEY', { infer: true }));

    this.privateKey = loadKey(() => createPrivateKey(privatePem), 'JWT_PRIVATE_KEY');
    this.publicKey = loadKey(() => createPublicKey(publicPem), 'JWT_PUBLIC_KEY');

    assertRsaKey(this.privateKey, 'JWT_PRIVATE_KEY');
    assertRsaKey(this.publicKey, 'JWT_PUBLIC_KEY');
    this.assertKeyPairMatches();

    this.keyId = deriveKeyId(this.publicKey);
    this.csrfKey = deriveCsrfKey(this.privateKey);

    this.logger.log(`RS256 signing key loaded (kid=${this.keyId})`);
  }

  /** The `kid` this service stamps into every header. Exposed for tests and diagnostics. */
  get kid(): string {
    return this.keyId;
  }

  /**
   * Mints an access JWT.
   *
   * `nbf` is set equal to `iat` rather than omitted: 02-SECURITY.md §1.1 requires verification
   * to assert `nbf`, and a claim that is only asserted when present is not asserted.
   */
  signAccessToken(input: AccessTokenInput, now: Date): MintedAccessToken {
    const issuedAtSeconds = Math.floor(now.getTime() / 1000);
    const expiresAtSeconds = issuedAtSeconds + ACCESS_TOKEN_TTL_SECONDS;
    const tokenId = randomUUID();

    const header: JoseHeader = {
      alg: JWT_SIGNING_ALGORITHM,
      typ: 'JWT',
      kid: this.keyId,
    };

    const payload: JwtPayload = {
      iss: JWT_ISSUER,
      aud: JWT_AUDIENCE,
      sub: String(input.userId),
      sid: input.sessionId,
      role: input.role,
      countryId: input.countryId,
      tenantId: input.tenantId,
      merchantId: input.merchantId,
      rbacVersion: input.rbacVersion,
      jti: tokenId,
      iat: issuedAtSeconds,
      nbf: issuedAtSeconds,
      exp: expiresAtSeconds,
    };

    const signingInput = `${encodeSegment(header)}.${encodeSegment(payload)}`;
    const signature = cryptoSign(
      'sha256',
      Buffer.from(signingInput, 'ascii'),
      // Explicit even though it is Node's default for an RSA key: RS256 *is*
      // RSASSA-PKCS1-v1_5, and a future default change (or a PSS key) must break loudly
      // rather than start emitting tokens no other RS256 verifier would accept.
      { key: this.privateKey, padding: cryptoConstants.RSA_PKCS1_PADDING },
    );

    return {
      token: `${signingInput}.${signature.toString('base64url')}`,
      claims: {
        ...input,
        tokenId,
        issuedAt: new Date(issuedAtSeconds * 1000),
        expiresAt: new Date(expiresAtSeconds * 1000),
      },
    };
  }

  /**
   * Verifies an access JWT and returns its claims. Throws {@link InvalidAccessTokenError} for
   * every failure; **never** returns unverified claims.
   *
   * The order below is the security-relevant part and is not arbitrary: cheap structural
   * checks, then the algorithm allowlist, then the signature, and only then anything that
   * treats the payload as meaningful. Nothing derived from the payload is used — not even
   * logged — before `cryptoVerify` has returned `true`.
   */
  verifyAccessToken(token: string, now: Date): AccessTokenClaims {
    if (token.length === 0) throw new InvalidAccessTokenError('empty');
    if (token.length > JWT_MAX_LENGTH) throw new InvalidAccessTokenError('oversized');

    const segments = token.split('.');
    if (segments.length !== 3) throw new InvalidAccessTokenError('malformed');

    const [headerSegment, payloadSegment, signatureSegment] = segments;
    // Rejects `alg: none`'s hallmark empty third segment before anything else looks at it,
    // and rejects any character outside the base64url alphabet — including the `+`, `/` and
    // `=` of standard base64, which would otherwise decode leniently and let two distinct
    // strings map to one signature input.
    for (const segment of segments) {
      if (!BASE64URL.test(segment)) throw new InvalidAccessTokenError('malformed');
    }

    const header = decodeSegment<JoseHeader>(headerSegment, 'header');
    if (typeof header.alg !== 'string' || !JWT_ALLOWED_ALGORITHMS.includes(header.alg)) {
      // The single check that closes both `alg: none` (TC-10) and RSA/HMAC confusion (TC-11).
      throw new InvalidAccessTokenError('algorithm_not_allowed');
    }
    if (header.typ !== undefined && header.typ !== 'JWT') {
      throw new InvalidAccessTokenError('type_not_allowed');
    }
    if (header.crit !== undefined) {
      // RFC 7515 §4.1.11: a `crit` header we do not understand must be rejected, not ignored.
      throw new InvalidAccessTokenError('critical_header_unsupported');
    }
    if (header.kid !== this.keyId) {
      throw new InvalidAccessTokenError('unknown_key_id');
    }

    const signatureValid = cryptoVerify(
      'sha256',
      Buffer.from(`${headerSegment}.${payloadSegment}`, 'ascii'),
      { key: this.publicKey, padding: cryptoConstants.RSA_PKCS1_PADDING },
      Buffer.from(signatureSegment, 'base64url'),
    );
    if (!signatureValid) throw new InvalidAccessTokenError('bad_signature');

    // --- everything below this line is operating on authenticated data ---------------------
    const payload = decodeSegment<JwtPayload>(payloadSegment, 'payload');
    return this.assertClaims(payload, now);
  }

  /**
   * A 256-bit opaque refresh (or reset) token and its SHA-256 digest.
   *
   * `randomBytes(32)` per T-011 implementation note 4 — a CSPRNG, not `Math.random`, and not a
   * UUID, whose v4 form carries only 122 bits and whose textual form is far more guessable
   * than it looks. Only `hash` is ever persisted, so a database dump does not yield a single
   * usable session (contrast a design that stores the token itself, where read access to one
   * table is read access to every live session).
   */
  generateOpaqueToken(): MintedOpaqueToken {
    const raw = randomBytes(32).toString('base64url');
    return { raw, hash: hashOpaqueToken(raw) };
  }

  /** SHA-256 of a presented opaque token, for looking its row up. Exposed for the guards. */
  hashOpaqueToken(raw: string): string {
    return hashOpaqueToken(raw);
  }

  /**
   * The double-submit CSRF value for a session (02-SECURITY.md §4).
   *
   * **Deterministic, keyed and session-bound, rather than random-and-stored.** §4 says the
   * server "stores its HMAC in the session", but `portal_sessions` has no column for it, and
   * adding one would be schema work this task is not authorised to do (R1/R9). An HMAC of the
   * session id under a key only this process holds is the same guarantee with no state: the
   * value is unguessable without the key, it is bound to exactly one session, it rotates
   * automatically on every login because `sid` is fresh, and it dies with the session because
   * `CsrfGuard` (T-012) recomputes it from the **verified** `sid` claim rather than from
   * anything the client sent.
   *
   * The key is derived from the RSA private key by HKDF with its own `info` string, so it is
   * cryptographically independent of the signing key despite sharing its source entropy, and
   * needs no additional secret to be configured or rotated. Truncated to 128 bits, which is
   * what 02-SECURITY.md §1 specifies for this cookie.
   */
  csrfTokenFor(sessionId: string): string {
    return createHmac('sha256', this.csrfKey)
      .update(`csrf:v1:${sessionId}`, 'utf8')
      .digest()
      .subarray(0, 16)
      .toString('base64url');
  }

  /**
   * Asserts every registered and private claim. Called only on authenticated data.
   *
   * Expiry uses `<=` against `exp` and `>` against `nbf` — a token is dead *at* its expiry
   * second and alive *at* its not-before second, matching RFC 7519 §4.1.4/4.1.5. No clock
   * skew is tolerated: this system signs and verifies with the same clock, so a leeway window
   * would only ever extend the life of a token past the point the rest of the design assumes
   * it is gone.
   */
  private assertClaims(payload: JwtPayload, now: Date): AccessTokenClaims {
    if (payload.iss !== JWT_ISSUER) throw new InvalidAccessTokenError('issuer_mismatch');
    if (payload.aud !== JWT_AUDIENCE) throw new InvalidAccessTokenError('audience_mismatch');

    const nowSeconds = Math.floor(now.getTime() / 1000);
    if (!isFiniteNumber(payload.exp)) throw new InvalidAccessTokenError('exp_missing');
    if (payload.exp <= nowSeconds) throw new InvalidAccessTokenError('expired');
    if (!isFiniteNumber(payload.nbf)) throw new InvalidAccessTokenError('nbf_missing');
    if (payload.nbf > nowSeconds) throw new InvalidAccessTokenError('not_yet_valid');
    if (!isFiniteNumber(payload.iat)) throw new InvalidAccessTokenError('iat_missing');

    if (typeof payload.sub !== 'string' || !/^[1-9]\d*$/.test(payload.sub)) {
      throw new InvalidAccessTokenError('sub_invalid');
    }
    if (typeof payload.sid !== 'string' || payload.sid.length === 0) {
      throw new InvalidAccessTokenError('sid_invalid');
    }
    if (typeof payload.jti !== 'string' || payload.jti.length === 0) {
      throw new InvalidAccessTokenError('jti_invalid');
    }
    if (typeof payload.role !== 'string' || !PORTAL_ROLES.has(payload.role)) {
      // A role that is not one of the six cannot be the result of any legitimate issuance —
      // treat it as forgery rather than defaulting it to something harmless.
      throw new InvalidAccessTokenError('role_invalid');
    }
    if (!isFiniteNumber(payload.rbacVersion)) {
      throw new InvalidAccessTokenError('rbac_version_invalid');
    }

    return {
      userId: Number(payload.sub),
      sessionId: payload.sid,
      role: payload.role as PortalRole,
      countryId: assertNullableId(payload.countryId, 'countryId'),
      tenantId: assertNullableId(payload.tenantId, 'tenantId'),
      merchantId: assertNullableId(payload.merchantId, 'merchantId'),
      rbacVersion: payload.rbacVersion,
      tokenId: payload.jti,
      issuedAt: new Date(payload.iat * 1000),
      expiresAt: new Date(payload.exp * 1000),
    };
  }

  /**
   * Proves at boot that `JWT_PUBLIC_KEY` is the public half of `JWT_PRIVATE_KEY`.
   *
   * Without this, a deployment that pastes a mismatched pair boots cleanly, issues tokens
   * happily, and rejects every one of them on the next request — an outage that looks like a
   * session bug. Worse, a *deliberately* swapped public key would mean this service accepts
   * tokens signed by whoever holds the corresponding private key. One signature and one
   * verification at startup rules both out.
   */
  private assertKeyPairMatches(): void {
    const probe = Buffer.from('reward-portal key pair self-test', 'utf8');
    const signature = cryptoSign('sha256', probe, {
      key: this.privateKey,
      padding: cryptoConstants.RSA_PKCS1_PADDING,
    });
    const matches = cryptoVerify(
      'sha256',
      probe,
      { key: this.publicKey, padding: cryptoConstants.RSA_PKCS1_PADDING },
      signature,
    );
    if (!matches) {
      throw new SigningKeyError(
        'JWT_PUBLIC_KEY is not the public half of JWT_PRIVATE_KEY — refusing to start.',
      );
    }
  }
}

// --- helpers ---------------------------------------------------------------------------------

/** The base64url alphabet, one or more characters, and nothing else. No padding, no `+`/`/`. */
const BASE64URL = /^[A-Za-z0-9_-]+$/;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** A nullable foreign key claim: `null`, or a positive integer. Anything else is forgery. */
function assertNullableId(value: unknown, name: string): number | null {
  if (value === null) return null;
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  throw new InvalidAccessTokenError(`${name}_invalid`);
}

function encodeSegment(value: object): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/**
 * Decodes one base64url JSON segment. Rejects anything that is not a plain JSON object —
 * `null`, an array and a bare number are all valid JSON and none of them is a JOSE header or a
 * claim set, but `typeof null === 'object'` would let the first through a naive check.
 */
function decodeSegment<T>(segment: string, what: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidAccessTokenError(`${what}_not_json`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new InvalidAccessTokenError(`${what}_not_object`);
  }
  return parsed as T;
}

function hashOpaqueToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/**
 * PEM as it arrives from the environment.
 *
 * `.env` files cannot hold a literal newline inside a quoted value, so `.env.example` documents
 * pasting the PEM with `\n` escapes — which arrive here as a backslash followed by an `n`.
 * Un-escaping them is what turns that back into a PEM Node will parse. Surrounding quotes are
 * stripped for the same reason: some secret managers hand the value back quoted.
 */
function normalisePem(value: string): string {
  const unquoted = value.trim().replace(/^["']|["']$/g, '');
  return unquoted.replace(/\\n/g, '\n');
}

function loadKey(load: () => KeyObject, name: string): KeyObject {
  try {
    return load();
  } catch (error) {
    // The message from `createPrivateKey` can quote fragments of the input. Never propagate it.
    throw new SigningKeyError(
      `${name} is not a valid PEM key (${(error as Error).name}) — refusing to start.`,
    );
  }
}

/**
 * The check that makes "there is no HMAC path" true rather than aspirational: if the configured
 * key is not RSA, this service does not start, so `cryptoVerify` can never be reached with a
 * symmetric key object.
 *
 * Exported for its own tests. Both fallbacks below are unreachable through this service's own
 * call sites — `createPrivateKey`/`createPublicKey` reject symmetric input, and Node populates
 * `asymmetricKeyDetails` for every RSA key it produces — which is exactly why they are asserted
 * directly: an unreachable guard that has never been executed is an unreachable guard nobody
 * knows is correct, and "unreachable" is a claim about today's Node, not a property of this code.
 */
export function assertRsaKey(key: KeyObject, name: string): void {
  if (key.asymmetricKeyType !== 'rsa') {
    throw new SigningKeyError(
      `${name} must be an RSA key for RS256, got ${key.asymmetricKeyType ?? 'a symmetric key'}.`,
    );
  }
  const modulusLength = key.asymmetricKeyDetails?.modulusLength ?? 0;
  if (modulusLength < JWT_MIN_MODULUS_LENGTH) {
    throw new SigningKeyError(
      `${name} has a ${modulusLength}-bit modulus; ${JWT_MIN_MODULUS_LENGTH} is the minimum.`,
    );
  }
}

/**
 * A stable `kid` for the configured key: the first 16 characters of the SHA-256 of its DER
 * SPKI encoding. Derived rather than configured so it cannot drift from the key it names, and
 * public by construction — it is a fingerprint of a *public* key, so publishing it in every
 * token header discloses nothing.
 */
function deriveKeyId(publicKey: KeyObject): string {
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(spki).digest('base64url').slice(0, 16);
}

/**
 * Derives the CSRF HMAC key from the signing key by HKDF-SHA256 with a purpose-specific `info`
 * string, so the two are cryptographically unrelated even though they share a source. The
 * exported DER is zeroed immediately: it is the private key in raw form, and there is no reason
 * for a second copy of it to sit in the heap for the lifetime of the process.
 */
function deriveCsrfKey(privateKey: KeyObject): Buffer {
  const der = privateKey.export({ type: 'pkcs8', format: 'der' });
  try {
    return Buffer.from(
      hkdfSync('sha256', der, Buffer.from('reward-portal/csrf', 'utf8'), 'csrf-double-submit', 32),
    );
  } finally {
    der.fill(0);
  }
}
