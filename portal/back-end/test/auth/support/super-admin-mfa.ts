/**
 * T-055 e2e support — "log this user in", for a world where a `super_admin` login no longer ends
 * in a session.
 *
 * ### Why this exists, and why it lives here
 *
 * T-055 makes MFA structurally mandatory for `super_admin` (02-SECURITY.md §11's release
 * checklist), so `POST /auth/login` for that one role now answers `mfaRequired: true` with **no**
 * session cookie — by design, and asserted as such in `mfa.e2e-spec.ts`. Every other e2e suite
 * that logs a `super_admin` in (`me.e2e-spec.ts`, `rbac.e2e-spec.ts`) therefore has to complete
 * the challenge before it has a session to test with.
 *
 * That is a real behaviour change for those suites, not a test-harness inconvenience, and the
 * honest way to absorb it is to make them **do what a real Super Admin now does**: enrol, then
 * present a code. This helper is that flow, through the real endpoints, with nothing stubbed and
 * no guard bypassed. What it deliberately is *not* is a way to mint a session directly — a helper
 * that inserted a `portal_sessions` row would quietly make those suites stop exercising the login
 * path at all, and would keep passing if the login path broke.
 *
 * It lives beside T-055's own fakes and is imported across directories, exactly as
 * `auth.e2e-spec.ts` already imports `test/common/support/error-envelope.ts`.
 *
 * ### The encryption key
 *
 * Enrolment writes `mfa_secret_enc` through T-016's `FieldCryptoService`, which needs an active
 * `field` key. {@link ensureFieldKey} inserts one whose material is generated per run into
 * `process.env` and never written down (R4), and does so only if the deployment has none — so it
 * cannot disturb a real key configuration. Call it **before** `app.init()`: `KeyRegistryService`
 * reads the table once, at boot.
 */
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { generateKeyMaterial, sweepOrphanedTestKeys } from '../../support/encryption-keys';
import { boundBaseUrl } from '../../security/support/bound-app';
import { FieldCryptoService } from '@/common/crypto/field-crypto.service';
import { PortalUserEmailCrypto } from '@/common/data-protection/portal-user-email.crypto';
import { MFA_PENDING_COOKIE_NAME } from '@/modules/auth/mfa.constants';
import { decodeBase32, totpCodeAt } from '@/modules/auth/services/totp';

/** The kid this helper owns. Distinct per suite, so two suites cannot delete each other's row. */
export function fieldKeyIdFor(suite: string): string {
  return `${suite}_mfa_fld`;
}

function envNameFor(suite: string): string {
  return `${suite.toUpperCase()}_MFA_FIELD_KEY`;
}

/**
 * Makes sure an AES-256-GCM `field` key exists, generating its material into the environment.
 *
 * Inserted as `active` only when the database has no active `field` key — `uq_ek_active_purpose`
 * allows exactly one, and a deployment that already has one keeps it (this row goes in as
 * `rotating`, which still decrypts and is enough for a suite that only round-trips its own data).
 */
export async function ensureFieldKey(sequelize: Sequelize, suite: string): Promise<void> {
  const kid = fieldKeyIdFor(suite);
  const env = envNameFor(suite);
  process.env[env] = generateKeyMaterial();

  // T-067 — see the identical call in `portal-user-fixture.ts`: clear residue a killed run
  // left behind, before `app.init()` trips over it.
  await sweepOrphanedTestKeys(sequelize);

  await sequelize.query(`DELETE FROM reward_portal.encryption_keys WHERE kid = :kid`, {
    type: QueryTypes.DELETE,
    replacements: { kid },
  });
  await sequelize.query(
    `INSERT INTO reward_portal.encryption_keys (kid, purpose, algorithm, key_ref, status)
     VALUES (:kid, 'field', 'AES-256-GCM', :ref,
             CASE WHEN EXISTS (SELECT 1 FROM reward_portal.encryption_keys
                                WHERE purpose = 'field' AND status = 'active')
                  THEN 'rotating' ELSE 'active' END)`,
    { type: QueryTypes.INSERT, replacements: { kid, ref: `env:${env}` } },
  );
}

/** Removes the row and the environment variable. Safe to call when neither exists. */
export async function removeFieldKey(sequelize: Sequelize, suite: string): Promise<void> {
  await sequelize.query(`DELETE FROM reward_portal.encryption_keys WHERE kid = :kid`, {
    type: QueryTypes.DELETE,
    replacements: { kid: fieldKeyIdFor(suite) },
  });
  delete process.env[envNameFor(suite)];
}

function cookieValue(response: request.Response, name: string): string {
  const header = response.headers['set-cookie'];
  const entries = Array.isArray(header) ? header : header === undefined ? [] : [header];
  const match = entries.find((entry) => entry.startsWith(`${name}=`));
  if (match === undefined) throw new Error(`no Set-Cookie for ${name}`);
  return decodeURIComponent(match.split(';')[0].slice(name.length + 1));
}

/**
 * Logs in, completing an MFA challenge when one is demanded.
 *
 * Returns the response that actually carried the session cookies — the login response for the
 * five roles that need no second factor, the `/auth/mfa/verify` response for `super_admin`. The
 * caller's existing "read the cookies off this response" code then works unchanged.
 *
 * Enrolment happens only when the account is not enrolled yet, so a suite that logs the same
 * fixture in twice takes the ordinary "enter your code" path the second time — which is the path
 * a real deployment spends its life on, and worth exercising.
 */
export interface LoginCompletingMfaOptions {
  /**
   * Headers to put on the two requests that can *issue a session* — the login and the MFA verify.
   *
   * Added by T-018 for `six-role-journeys.e2e-spec.ts`. The transport handshake happens wherever a
   * session is minted, which for `super_admin` is `/auth/mfa/verify`, so a caller that wants a
   * transport key has to offer its public key on both. Deliberately *not* applied to
   * `/auth/mfa/enrol`: no session is issued there and a handshake header on it would be meaningless.
   */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * Called with every response the flow produces, in order.
   *
   * Also T-018's: the transport handshake is split across two responses for `super_admin` — the
   * **login** carries the policy advertisement (`X-Payload-Encryption`, set on that route only,
   * because that is where a browser asks "what should I encrypt?"), and the **verify** carries the
   * server public key and the kid. A caller that only sees the returned response would see half of
   * it, which is exactly what a real SPA must not do either.
   */
  readonly observe?: (response: request.Response) => void;
}

export async function loginCompletingMfa(
  app: INestApplication,
  credentials: { email: string; password: string },
  sequelize: Sequelize,
  options: LoginCompletingMfaOptions = {},
): Promise<request.Response> {
  // T-087: aim supertest at a single, already-bound listener rather than letting it
  // `listen(0)`/`close()` a fresh ephemeral port per request. This helper is imported by 26 e2e
  // suites and cannot know whether its caller bound the app already, so `boundBaseUrl` reuses an
  // existing listener and binds only when there is none. See `test/security/support/bound-app.ts`.
  const base = await boundBaseUrl(app);
  const http = () => request(base);
  const headers = options.headers ?? {};
  const observe = options.observe ?? (() => undefined);

  const login = await http().post('/api/v1/auth/login').set(headers).send(credentials);
  observe(login);
  if (login.status !== 200) return login;
  if (login.body?.data?.mfaRequired !== true) return login;

  const pending = cookieValue(login, MFA_PENDING_COOKIE_NAME);

  // T-056: `email` is ciphertext with a random IV, so `lower(email) = lower(:email)` matches
  // nothing. The lookup goes through the blind index, using the application's own crypto — the
  // same path `CredentialRepository` takes.
  const [user] = await sequelize.query<{ id: number; mfa_enabled: boolean }>(
    `SELECT id, mfa_enabled FROM reward_portal.portal_users
      WHERE email_bidx = :bidx AND deleted_at IS NULL`,
    {
      type: QueryTypes.SELECT,
      replacements: { bidx: app.get(PortalUserEmailCrypto).blindIndexFor(credentials.email) },
    },
  );
  if (user === undefined) throw new Error(`no portal_users row for ${credentials.email}`);

  if (!user.mfa_enabled) {
    const enrolment = await http()
      .post('/api/v1/auth/mfa/enrol')
      .send({ mfaPendingToken: pending });
    if (enrolment.status !== 200) {
      throw new Error(
        `MFA enrolment failed: ${enrolment.status} ${JSON.stringify(enrolment.body)}`,
      );
    }
  }

  // The seed is read back the way an authenticator app holds it — decrypted with the same service
  // the application uses, so this exercises the real ciphertext rather than a remembered value.
  const [row] = await sequelize.query<{ mfa_secret_enc: string | null }>(
    `SELECT mfa_secret_enc FROM reward_portal.portal_users WHERE id = :id`,
    { type: QueryTypes.SELECT, replacements: { id: user.id } },
  );
  if (row?.mfa_secret_enc == null) throw new Error('no mfa_secret_enc after enrolment');

  const crypto = app.get(FieldCryptoService);
  const secret = decodeBase32(
    crypto.decrypt(row.mfa_secret_enc, {
      aad: FieldCryptoService.aadFor('reward_portal.portal_users', user.id),
    }),
  );

  const verified = await http()
    .post('/api/v1/auth/mfa/verify')
    .set(headers)
    .send({ mfaPendingToken: pending, totpCode: totpCodeAt(secret, new Date()) });
  observe(verified);
  if (verified.status !== 200) {
    throw new Error(`MFA verify failed: ${verified.status} ${JSON.stringify(verified.body)}`);
  }

  return verified;
}
