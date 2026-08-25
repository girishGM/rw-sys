/**
 * T-018 TC-18 and verification steps 4–6 — **the six role journeys, in all three modes**, through
 * the real `AppModule`, the real interceptor chain and the real Postgres database.
 *
 * ---
 *
 * ## Why this file exists (read this before deciding it is redundant)
 *
 * T-018's Definition of Done is explicit: *"AGENT-PROTOCOL §4 gates, TC-1…TC-23 green, and the
 * E2E suite green in all three modes (`off`, `fields`, `full`). A mode that is configurable but
 * untested is not configurable."* Two submissions of this task deferred TC-18 and verification
 * step 6 to T-050 on the grounds that T-050 owns the E2E suite and the SPA screens do not exist
 * yet. That reasoning is true about the *browser*, and it was hiding a real defect that had
 * nothing to do with browsers:
 *
 * > **`super_admin` never got a transport key.** T-055 makes MFA structurally mandatory for that
 * > role, so its session is issued by `POST /auth/mfa/verify`, not by `POST /auth/login` — and the
 * > handshake was bound to the login only. The role with unrestricted scope could therefore never
 * > encrypt a payload, and nothing went red: `PayloadEncryptInterceptor` silently returns cleartext
 * > when the session holds no key. One of the six journeys below failed on its first run, which is
 * > precisely what TC-18 is for. The fix is in `mfa.controller.ts`.
 *
 * So the journeys are run here at the API layer, over every endpoint that exists today
 * (Waves 2–3 have not been built), and what remains for T-050 is the browser and the screens —
 * named in the completion report rather than left as "deferred".
 *
 * ## What each journey covers
 *
 * ```
 *  1  log in as the role                       (handshake: ECDH → HKDF → AES-256-GCM)
 *  2  GET  /me/bootstrap                       role-specific nav, permissions, widgets
 *  3  GET  /me                                 the profile, which carries a policy-flagged field
 *  4  PATCH /me                                a mutation, with CSRF, through the ValidationPipe
 *  5  GET  /auth/sessions                      the caller's own sessions
 *  6  POST /auth/change-password  (×2)         the `full` route override, both ways
 *  7  POST /auth/refresh                       the key must survive token rotation
 *  8  POST /auth/logout → replay               a revoked session's key is dead (TC-14)
 * ```
 *
 * ## The assertion that makes this worth running three times
 *
 * Every journey builds a **transcript** — status codes plus the plaintext the client ends up
 * holding — and the three modes' transcripts are compared for equality at the end. That is the
 * property payload encryption has to have: *the application behaves identically; only the wire
 * changes.* Wire-level expectations (opaque in `full`, field-shaped in `fields`, readable in
 * `off`) are asserted per mode inside the journey.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import * as argon2 from 'argon2';
import { AppModule } from '@/app.module';
import { SEQUELIZE } from '@/database/sequelize.provider';
import { ARGON2_OPTIONS } from '@/modules/auth/auth.constants';
import { validationExceptionFactory } from '@/common/errors/validation.exception-factory';
import {
  DATA_PROTECTION_CONFIG,
  dataProtectionConfigFactory,
  type DataProtectionConfig,
} from '@/common/data-protection/data-protection.config';
import { isPayloadEnvelope } from '@/common/transport-crypto/transport-envelope';
import type { PortalRole } from '@/database/portal-models';
import {
  deletePortalUsersByEmail,
  emailCryptoOf,
  ensureEncryptionKeys,
  insertPortalUser,
  removeEncryptionKeys,
} from '../auth/support/portal-user-fixture';
import { loginCompletingMfa } from '../auth/support/super-admin-mfa';
import type { PortalUserEmailCrypto } from '@/common/data-protection/portal-user-email.crypto';
import { JourneyClient, type Exchange, type TransportMode } from './support/journey-client';

jest.setTimeout(600_000);

/** Namespaces this suite's `encryption_keys` rows, so two suites cannot delete each other's. */
const SUITE = 't018j';

const PASSWORD = 'correct horse battery staple 7!';
const ROTATED_PASSWORD = 'Tr0ubador-Zephyr-Quill!42';

/** `countries.code` is `character(2)`; distinct from every other suite's fixture. */
const COUNTRY_CODE = 'ZX';
const TENANT_CODE = 'T018_E2E_T';
const MERCHANT_CODE = 'T018_E2E_M';
/** Every fixture user's `display_name` starts with this, which is how cleanup finds them. */
const DISPLAY_PREFIX = 'T-018 journey';

interface RoleFixture {
  readonly key: string;
  readonly role: PortalRole;
  readonly scoped: 'none' | 'country' | 'tenant' | 'merchant';
}

/** The six roles of 00-ARCHITECTURE.md §2, in delegation order. */
const ROLES: readonly RoleFixture[] = [
  { key: 'super', role: 'super_admin', scoped: 'none' },
  { key: 'country', role: 'country_admin', scoped: 'country' },
  { key: 'tenant', role: 'tenant_admin', scoped: 'tenant' },
  { key: 'maker', role: 'maker', scoped: 'tenant' },
  { key: 'checker', role: 'checker', scoped: 'tenant' },
  { key: 'merchant', role: 'merchant', scoped: 'merchant' },
];

const MODES: readonly TransportMode[] = ['off', 'fields', 'full'];

/** One journey's observable outcome, with every volatile value (ids, timestamps) left out. */
interface Transcript {
  readonly steps: Record<string, unknown>;
}

/** `mode → role key → transcript`, compared across modes by the last describe in this file. */
const transcripts = new Map<string, Transcript>();

let app: INestApplication;
let db: Sequelize;
let emailCrypto: PortalUserEmailCrypto;
let countryId: number;
let tenantId: number;
let merchantId: number;

// --- boot -----------------------------------------------------------------------------------

async function sql<T extends object>(
  statement: string,
  replacements: Record<string, unknown> = {},
): Promise<T[]> {
  return db.query<T>(statement, { type: QueryTypes.SELECT, replacements });
}

async function exec(statement: string, replacements: Record<string, unknown> = {}): Promise<void> {
  await db.query(statement, { type: QueryTypes.RAW, replacements });
}

/**
 * Boots the whole application with one transport configuration.
 *
 * The config is overridden at the DI token rather than by rewriting `config/data-protection.json`,
 * for two reasons: a test that edits a committed config file is a test that can leave the
 * repository in a different state than it found it, and the point here is to prove the *modes*
 * work, not that JSON parsing works (which `data-protection.config.spec.ts` already covers).
 * Everything except `transport` is taken from the committed file, so `failClosed`, the masking
 * default and the policy cache TTL are the production ones.
 */
async function boot(
  mode: TransportMode,
  routeOverrides?: Readonly<Record<string, TransportMode>>,
): Promise<void> {
  const committed = dataProtectionConfigFactory();
  const config: DataProtectionConfig = {
    ...committed,
    transport: {
      mode,
      routeOverrides: routeOverrides ?? committed.transport.routeOverrides,
    },
  };

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DATA_PROTECTION_CONFIG)
    .useValue(config)
    .compile();

  // `KeyRegistryService` reads `encryption_keys` once, at boot, so the fixture keys go in first.
  await ensureEncryptionKeys(moduleRef.get<Sequelize>(SEQUELIZE), SUITE);

  app = moduleRef.createNestApplication();
  // Identical to `main.ts` — the pipe and its exception factory are part of what TC-4 asserts.
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: validationExceptionFactory,
    }),
  );
  await app.listen(0);

  db = app.get<Sequelize>(SEQUELIZE);
  emailCrypto = emailCryptoOf(app);

  countryId = await ensureCountry();
  tenantId = await ensureTenant();
  merchantId = await ensureMerchant();
  await seedActors();
}

async function shutdown(): Promise<void> {
  if (db !== undefined) {
    await exec(`DELETE FROM reward_portal.portal_users WHERE display_name LIKE :prefix`, {
      prefix: `${DISPLAY_PREFIX}%`,
    });
    await removeEncryptionKeys(db, SUITE);
  }
  if (app !== undefined) await app.close();
}

// --- fixtures ---------------------------------------------------------------------------------

function emailFor(key: string): string {
  return `t018-journey-${key}@example.invalid`;
}

/**
 * Recreated on every boot rather than shared across the three.
 *
 * `ensureEncryptionKeys` generates fresh key material per boot (R4 — nothing is written down), and
 * `portal_users.email` is encrypted with it, so a row written under the previous boot's key would
 * be unreadable under this one. Recreating is cheaper and honest; ids are deliberately never part
 * of a transcript, so they are free to change.
 */
async function seedActors(): Promise<void> {
  await deletePortalUsersByEmail(
    db,
    emailCrypto,
    ROLES.map((fixture) => emailFor(fixture.key)),
  );

  for (const fixture of ROLES) {
    const scope = {
      countryId: fixture.scoped === 'none' ? null : countryId,
      tenantId: fixture.scoped === 'tenant' || fixture.scoped === 'merchant' ? tenantId : null,
      merchantId: fixture.scoped === 'merchant' ? merchantId : null,
    };

    const userId = await insertPortalUser(db, emailCrypto, {
      email: emailFor(fixture.key),
      displayName: `${DISPLAY_PREFIX} ${fixture.key}`,
      role: fixture.role,
      ...scope,
    });

    await exec(
      `INSERT INTO reward_portal.portal_user_credentials (user_id, password_hash, password_algo)
       VALUES (:userId, :hash, 'argon2id')`,
      { userId, hash: await argon2.hash(PASSWORD, ARGON2_OPTIONS) },
    );
  }
}

async function ensureCountry(): Promise<number> {
  const [existing] = await sql<{ id: number }>(
    `SELECT id FROM reward_config.countries WHERE code = :code`,
    { code: COUNTRY_CODE },
  );
  if (existing !== undefined) {
    await exec(`UPDATE reward_config.countries SET status = 'active' WHERE id = :id`, {
      id: existing.id,
    });
    return existing.id;
  }

  const [created] = await sql<{ id: number }>(
    `INSERT INTO reward_config.countries (code, name, timezone, currency_code, dialing_code, status)
     VALUES (:code, 'T-018 journey country', 'UTC', 'USD', '+018', 'active')
     RETURNING id`,
    { code: COUNTRY_CODE },
  );
  return created.id;
}

async function ensureTenant(): Promise<number> {
  const [existing] = await sql<{ id: number }>(
    `SELECT id FROM reward_config.tenants WHERE code = :code`,
    { code: TENANT_CODE },
  );
  if (existing !== undefined) {
    await exec(
      `UPDATE reward_config.tenants
          SET status = 'active', deleted_at = NULL, country_id = :countryId
        WHERE id = :id`,
      { id: existing.id, countryId },
    );
    return existing.id;
  }

  const [created] = await sql<{ id: number }>(
    `INSERT INTO reward_config.tenants (code, name, country_id, status)
     VALUES (:code, :code, :countryId, 'active')
     RETURNING id`,
    { code: TENANT_CODE, countryId },
  );
  return created.id;
}

async function ensureMerchant(): Promise<number> {
  const [existing] = await sql<{ id: number }>(
    `SELECT id FROM reward_config.merchants WHERE merchant_code = :code`,
    { code: MERCHANT_CODE },
  );
  if (existing !== undefined) {
    await exec(
      `UPDATE reward_config.merchants
          SET status = 'active', deleted_at = NULL, tenant_id = :tenantId
        WHERE id = :id`,
      { id: existing.id, tenantId },
    );
    return existing.id;
  }

  const [created] = await sql<{ id: number }>(
    `INSERT INTO reward_config.merchants (tenant_id, merchant_code, name, country_code, status)
     VALUES (:tenantId, :code, :code, :countryCode, 'active')
     RETURNING id`,
    { code: MERCHANT_CODE, tenantId, countryCode: COUNTRY_CODE },
  );
  return created.id;
}

/** Deactivates the shared `reward_config` fixtures — `reward_app` holds no `DELETE` there. */
async function retireFixtures(): Promise<void> {
  await exec(`UPDATE reward_config.merchants SET status = 'inactive' WHERE merchant_code = :code`, {
    code: MERCHANT_CODE,
  });
  await exec(
    `UPDATE reward_config.tenants SET status = 'inactive', deleted_at = now() WHERE code = :code`,
    { code: TENANT_CODE },
  );
  await exec(`UPDATE reward_config.countries SET status = 'inactive' WHERE code = :code`, {
    code: COUNTRY_CODE,
  });
}

// --- the journey ------------------------------------------------------------------------------

/**
 * Logs one role in, completing the MFA challenge when the role is `super_admin`, and returns a
 * client holding the session **and** the transport key.
 *
 * The handshake material arrives on two different responses for `super_admin` (advertisement at
 * login, key at verify), which is why the client adopts every response the flow produces.
 */
async function logIn(fixture: RoleFixture, password: string = PASSWORD): Promise<JourneyClient> {
  const client = new JourneyClient(app);
  const response = await loginCompletingMfa(app, { email: emailFor(fixture.key), password }, db, {
    headers: client.handshakeHeaders(),
    observe: (seen) => client.adopt(seen),
  });

  expect(response.status).toBe(200);
  return client;
}

/** The values a mode must not change. Ids and timestamps are excluded on purpose. */
function transcriptOf(steps: Record<string, unknown>): Transcript {
  return { steps };
}

/** Every string value in a body, flattened — used to prove none of them is on the wire. */
function stringValues(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    if (value.length >= 4) out.push(value);
    return out;
  }
  if (value === null || typeof value !== 'object') return out;
  for (const item of Object.values(value as Record<string, unknown>)) stringValues(item, out);
  return out;
}

/**
 * The wire-level expectations for one exchange, given the mode that applies to its route.
 *
 * This is where "the mode is configured" becomes "the mode is *doing* something": in `full` the
 * body on the wire is four base64 fields and nothing else; in `fields` the flagged field is an
 * envelope while its siblings stay readable; in `off` the body is ordinary JSON.
 */
function assertWireShape(
  exchange: Exchange,
  mode: TransportMode,
  flagged: readonly string[],
): void {
  if (mode === 'off') {
    expect(exchange.responseEncrypted).toBe(false);
    return;
  }

  if (mode === 'full') {
    expect(exchange.responseEncrypted).toBe(true);
    const raw: unknown = JSON.parse(exchange.responseText);
    expect(isPayloadEnvelope(raw)).toBe(true);
    // TC-19 — nothing readable survives on the wire.
    for (const value of stringValues(exchange.body)) {
      expect(exchange.responseText).not.toContain(value);
    }
    return;
  }

  // `fields`: encrypted only if the payload actually carried a flagged field.
  const raw = JSON.parse(exchange.responseText) as { data?: Record<string, unknown> };
  const encryptedFields = flagged.filter((name) => isPayloadEnvelope(raw.data?.[name]));
  expect(exchange.responseEncrypted).toBe(encryptedFields.length > 0);
  expect(encryptedFields).toEqual(flagged.filter((name) => raw.data?.[name] !== undefined));
}

/**
 * One role's whole journey. Returns the transcript; asserts the wire shape as it goes.
 *
 * Note what is *not* mode-aware in here: every status code, every plaintext value and every
 * assertion about what the application did. That is the point — see this file's header.
 */
async function runJourney(fixture: RoleFixture, mode: TransportMode): Promise<Transcript> {
  const client = await logIn(fixture);
  const steps: Record<string, unknown> = {};

  // TC-1 — the handshake happened, for every one of the six roles.
  expect(client.hasTransportKey).toBe(true);
  expect(client.advertisedPolicy?.mode).toBe(mode);

  // 2 — the bootstrap. Role-specific, and the response the SPA cannot start without.
  const bootstrap = await client.send('get', '/me/bootstrap');
  expect(bootstrap.status).toBe(200);
  const bootstrapBody = bootstrap.body as {
    data: {
      user: { role: string; displayName: string };
      scope: Record<string, number | null>;
      nav: { key: string }[];
      permissions: Record<string, string[]>;
      widgets: { key: string }[];
    };
  };
  steps.bootstrap = {
    status: bootstrap.status,
    role: bootstrapBody.data.user.role,
    displayName: bootstrapBody.data.user.displayName,
    scopeKeys: Object.keys(bootstrapBody.data.scope).sort(),
    scopedToSomething: Object.values(bootstrapBody.data.scope).some((value) => value !== null),
    nav: bootstrapBody.data.nav.map((item) => item.key),
    permissions: Object.keys(bootstrapBody.data.permissions).sort(),
    widgets: bootstrapBody.data.widgets.map((widget) => widget.key),
  };
  expect(bootstrapBody.data.user.role).toBe(fixture.role);
  // No policy-flagged field name appears in a bootstrap payload, so `fields` mode leaves it alone —
  // which is exactly the "payloads stay debuggable" property §5 claims for that mode.
  assertWireShape(bootstrap, mode, []);

  // 3 — the profile, which carries `email`: `in_transit = 'payload_encrypt'` (T017_002).
  const profile = await client.send('get', '/me');
  expect(profile.status).toBe(200);
  const profileBody = profile.body as { data: { email: string; displayName: string } };
  steps.profile = {
    status: profile.status,
    email: profileBody.data.email,
    displayName: profileBody.data.displayName,
  };
  expect(profileBody.data.email).toBe(emailFor(fixture.key));
  assertWireShape(profile, mode, ['email']);
  if (mode !== 'off') {
    // TC-19 at the journey level: the address is not readable on the wire in either mode.
    expect(profile.responseText).not.toContain(emailFor(fixture.key));
  } else {
    expect(profile.responseText).toContain(emailFor(fixture.key));
  }

  // 4 — a mutation, through CSRF and the ValidationPipe.
  const renamed = `${DISPLAY_PREFIX} ${fixture.key} renamed`;
  const patched = await client.send('patch', '/me', { displayName: renamed });
  expect(patched.status).toBe(200);
  steps.patched = {
    status: patched.status,
    displayName: (patched.body as { data: { displayName: string } }).data.displayName,
  };
  expect((patched.body as { data: { displayName: string } }).data.displayName).toBe(renamed);

  // TC-4 — `forbidNonWhitelisted` still applies to a payload that arrived encrypted.
  const rejected = await client.send('patch', '/me', { displayName: renamed, role: 'super_admin' });
  steps.forbidNonWhitelisted = {
    status: rejected.status,
    code: (rejected.body as { error?: { code?: string } }).error?.code,
  };
  expect(rejected.status).toBe(400);

  // 5 — the caller's own sessions.
  const sessions = await client.send('get', '/auth/sessions');
  expect(sessions.status).toBe(200);
  const sessionRows = (sessions.body as { data: { current: boolean }[] }).data;
  steps.sessions = {
    status: sessions.status,
    hasCurrent: sessionRows.some((row) => row.current),
  };

  // 6 — the `full` route override, in every mode (see the note in the completion report about
  // what that means for the documented `off` rollback).
  const changeMode = client.modeFor('post', '/auth/change-password');
  expect(changeMode).toBe('full');
  const changed = await client.send('post', '/auth/change-password', {
    currentPassword: PASSWORD,
    newPassword: ROTATED_PASSWORD,
  });
  steps.changePassword = { status: changed.status, requestEncrypted: changed.requestEncrypted };
  expect(changed.status).toBe(204);
  expect(changed.requestEncrypted).toBe(true);
  expect(changed.requestText).not.toContain(ROTATED_PASSWORD);

  // 6b — and it really took effect. A 204 alone would also be produced by a body that decrypted
  // into *something* the DTO accepted; logging in with the new password proves the plaintext the
  // controller acted on was the plaintext the client sealed. Not changed back: T-010's password
  // history refuses a password this account has used before, which is correct behaviour and not
  // something to work around — the fixtures are recreated per boot instead.
  const reauthenticated = await logIn(fixture, ROTATED_PASSWORD);
  steps.reauthenticated = { hasTransportKey: reauthenticated.hasTransportKey };
  expect(reauthenticated.hasTransportKey).toBe(true);
  expect((await reauthenticated.send('post', '/auth/logout')).status).toBe(204);

  // 7 — token rotation. The session id does not change, so the key must still work afterwards.
  const refreshed = await client.send('post', '/auth/refresh');
  expect(refreshed.status).toBe(200);
  const afterRefresh = await client.send('get', '/me');
  steps.afterRefresh = {
    status: afterRefresh.status,
    email: (afterRefresh.body as { data: { email: string } }).data.email,
  };
  expect(afterRefresh.status).toBe(200);

  // 8 — logout, then replay the same encrypted request with the same key (TC-14).
  const jarBeforeLogout = client.jar;
  const csrfBeforeLogout = client.csrf;
  const loggedOut = await client.send('post', '/auth/logout');
  expect(loggedOut.status).toBe(204);

  client.jar = jarBeforeLogout;
  client.csrf = csrfBeforeLogout;
  const replayed = await client.send('post', '/auth/change-password', {
    currentPassword: ROTATED_PASSWORD,
    newPassword: PASSWORD,
  });
  steps.afterLogout = { status: replayed.status };
  expect(replayed.status).toBe(401);

  return transcriptOf(steps);
}

// --- the three modes ---------------------------------------------------------------------------

describe.each(MODES)('transport mode: %s — all six role journeys', (mode) => {
  beforeAll(async () => {
    await boot(mode);
  });

  afterAll(async () => {
    await shutdown();
  });

  it.each(ROLES.map((fixture) => [fixture.key, fixture] as const))(
    'TC-18 — %s completes the whole journey',
    async (_key, fixture) => {
      const transcript = await runJourney(fixture, mode);
      transcripts.set(`${mode}:${fixture.key}`, transcript);
    },
  );

  /**
   * TC-12 and TC-21 in the shape a real deployment produces them: two live sessions, each with its
   * own key, and an envelope sealed by one presented on the other.
   *
   * `POST /auth/change-password` is used because its route override is `full` in every mode, so
   * this case asserts the same thing three times rather than needing three expectations.
   */
  it("TC-12/TC-21 — one session cannot use another session's key", async () => {
    // The six journeys above each rotated their own account's password, so the fixtures are
    // recreated first. Recreating also drops every session they left behind, which is the state a
    // fresh pair of logins should start from.
    await seedActors();

    const maker = await logIn(ROLES[3]);
    const checker = await logIn(ROLES[4]);

    // Sanity first: the maker's own key really does work on its own session.
    const own = await maker.send('post', '/auth/change-password', {
      currentPassword: PASSWORD,
      newPassword: ROTATED_PASSWORD,
    });
    expect(own.status).toBe(204);

    // Now the same client — and therefore the same key and the same `kid` — carrying the checker's
    // cookies. The session in the verified token is the checker's; the envelope names the maker's.
    const ownJar = maker.jar;
    const ownCsrf = maker.csrf;
    maker.jar = checker.jar;
    maker.csrf = checker.csrf;

    const crossed = await maker.send('post', '/auth/change-password', {
      currentPassword: PASSWORD,
      newPassword: `${ROTATED_PASSWORD}-crossed`,
    });
    expect(crossed.status).toBe(401);

    // And the checker's password is untouched: the request never reached the controller.
    maker.jar = ownJar;
    maker.csrf = ownCsrf;
    const checkerStillWorks = await checker.send('get', '/me');
    expect(checkerStillWorks.status).toBe(200);

    await maker.send('post', '/auth/logout');
    await checker.send('post', '/auth/logout');
  });
});

// --- the documented rollback --------------------------------------------------------------------

/**
 * T-018's Rollback section: *"Set `transport.mode: "off"`. The application continues on TLS
 * alone."*
 *
 * Run as its own boot because the committed `routeOverrides` keep `POST /auth/change-password` at
 * `full` even when the global mode is `off` — overrides beat the global mode, by design and by
 * `TransportPolicyService.modeFor`'s documented order. So the *complete* rollback is "mode off and
 * no overrides", and this proves that state really does take the crypto out of the path entirely.
 * The tension between the two is raised in the completion report for the architect; it is not
 * silently redesigned here.
 */
describe('the documented rollback — mode off with no route overrides', () => {
  beforeAll(async () => {
    await boot('off', {});
  });

  afterAll(async () => {
    await retireFixtures();
    await shutdown();
  });

  it('every request and response on a maker journey is ordinary JSON', async () => {
    const client = await logIn(ROLES[3]);
    expect(client.modeFor('post', '/auth/change-password')).toBe('off');

    const profile = await client.send('get', '/me');
    expect(profile.status).toBe(200);
    expect(profile.responseEncrypted).toBe(false);
    expect(profile.responseText).toContain(emailFor('maker'));

    const changed = await client.send('post', '/auth/change-password', {
      currentPassword: PASSWORD,
      newPassword: ROTATED_PASSWORD,
    });
    expect(changed.status).toBe(204);
    expect(changed.requestEncrypted).toBe(false);
    // The password really did travel in cleartext — which is what "TLS alone" means, and why the
    // rollback is a deliberate, documented downgrade rather than a no-op.
    expect(changed.requestText).toContain(ROTATED_PASSWORD);

    // And the application still works: the rotated password logs in, with no transport crypto in
    // the path at all (verification step 4 — "toggle mode to off, reload; app still works").
    const again = await logIn(ROLES[3], ROTATED_PASSWORD);
    expect((await again.send('get', '/me/bootstrap')).status).toBe(200);
    await again.send('post', '/auth/logout');
    await client.send('post', '/auth/logout');
  });
});

// --- the cross-mode invariant --------------------------------------------------------------------

describe('the modes change the wire and nothing else', () => {
  it.each(ROLES.map((fixture) => [fixture.key] as const))(
    '%s sees identical application behaviour in off, fields and full',
    (key) => {
      const off = transcripts.get(`off:${key}`);
      const fields = transcripts.get(`fields:${key}`);
      const full = transcripts.get(`full:${key}`);

      expect(off).toBeDefined();
      expect(fields).toEqual(off);
      expect(full).toEqual(off);
    },
  );

  it('all eighteen journeys ran', () => {
    expect(transcripts.size).toBe(MODES.length * ROLES.length);
  });
});
