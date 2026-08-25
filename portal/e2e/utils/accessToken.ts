/**
 * T-050 — mints a copy of a real, currently-valid access JWT with its `exp` (and `iat`/`nbf`)
 * moved into the past, so `session.spec.ts`'s access-token-expiry test (the inherited T-058 TC-4
 * criterion, `project-plan/tasks/T-050-e2e-tests.md`'s "Inherited acceptance criteria" table) can
 * force the exact condition that criterion is about — a live session whose access token has
 * expired but whose refresh token has not — deterministically, without waiting out the real
 * 15-minute `ACCESS_TOKEN_TTL_SECONDS` (`back-end/src/modules/auth/session.constants.ts`) and
 * without an environment-only override of it, which does not exist in the codebase to opt into
 * (unlike `LOGIN_THROTTLE_RELAX_FACTOR`, T-066) and which this task has no standing to add
 * (T-011's file scope, not this task's — AGENT-PROTOCOL R9).
 *
 * This suite is in an unusual position to do this itself, faithfully rather than by mocking
 * anything: `global-setup.ts` mints its own disposable RSA keypair for the whole run and hands it
 * to the back end as `JWT_PRIVATE_KEY`/`JWT_PUBLIC_KEY` (`utils/state.ts`'s own `jwtKeys`) — the
 * exact key `TokenService` signs and verifies access tokens with. Holding that key here means this
 * file produces a token the server's own `verifyAccessToken` will accept as genuine right up until
 * its `exp` claim, the same "real, independent exercise of the server's own verification path, not
 * a mock of it" reasoning `utils/totp.ts`'s own header already applies to RFC 6238.
 *
 * Deliberately re-implements `TokenService.signAccessToken`'s RS256 signing rather than importing
 * it: this is a standalone npm project (`e2e/package.json`'s own header) with no dependency on
 * `back-end`'s source tree, and everything reproduced below (the claim names, RS256 with PKCS1
 * padding, the `kid` derivation, `iss`/`aud`) is exactly as public as `session.constants.ts`'s own
 * comment says it is — none of this discloses a secret, it only re-runs a public algorithm against
 * a key this suite already legitimately holds.
 */
import {
  constants as cryptoConstants,
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
} from 'node:crypto';

/** `session.constants.ts`'s own values — asserted against below as a sanity check, not trusted
 * blindly: if either ever drifts, this file should fail loudly rather than silently forge a token
 * against the wrong issuer/audience. */
const JWT_ISSUER = 'reward-portal';
const JWT_AUDIENCE = 'reward-portal-spa';

export interface JwtKeyPair {
  readonly privatePem: string;
  readonly publicPem: string;
}

function base64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function decodeSegment<T>(segment: string): T {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as T;
}

/** Mirrors `TokenService`'s own private `deriveKeyId` exactly: SHA-256 of the public key's SPKI
 * DER encoding, base64url, first 16 characters. The header `kid` must match this or the server's
 * own `unknown_key_id` check rejects the token before it ever looks at `exp`. */
function deriveKeyId(publicPem: string): string {
  const spki = createPublicKey(publicPem).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(spki).digest('base64url').slice(0, 16);
}

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

/**
 * Reads the claims out of a real, currently-valid access token — without verifying it, on
 * purpose: the caller already holds a token the server itself issued moments earlier (a real
 * browser's own `__Host-rs_at` cookie), so this is "read the claims back", not "trust an
 * unverified token" — and returns a **new** token, freshly signed by this file with the identical
 * claims except `iat`/`nbf`/`exp`, all moved into the past.
 */
export function forgeExpiredAccessToken(validToken: string, jwtKeys: JwtKeyPair): string {
  const segments = validToken.split('.');
  if (segments.length !== 3) {
    throw new Error(
      'forgeExpiredAccessToken: not a three-segment JWT — has the access cookie shape changed?',
    );
  }
  const payload = decodeSegment<JwtPayload>(segments[1]);
  if (payload.iss !== JWT_ISSUER || payload.aud !== JWT_AUDIENCE) {
    throw new Error(
      `forgeExpiredAccessToken: expected iss/aud "${JWT_ISSUER}"/"${JWT_AUDIENCE}", got ` +
        `"${payload.iss}"/"${payload.aud}" — has session.constants.ts changed?`,
    );
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const forgedPayload: JwtPayload = {
    ...payload,
    iat: nowSeconds - 3600,
    nbf: nowSeconds - 3600,
    exp: nowSeconds - 60, // already expired a minute ago — never in the future, never "now"
  };

  const header = { alg: 'RS256', typ: 'JWT', kid: deriveKeyId(jwtKeys.publicPem) };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(forgedPayload))}`;
  const signature = cryptoSign('sha256', Buffer.from(signingInput, 'ascii'), {
    key: createPrivateKey(jwtKeys.privatePem),
    padding: cryptoConstants.RSA_PKCS1_PADDING,
  });
  return `${signingInput}.${signature.toString('base64url')}`;
}
