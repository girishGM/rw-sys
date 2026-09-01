/**
 * T-121 — the two field value-source registries against the real Postgres instance, through the
 * real `AppModule`, over real HTTP. Two actors: `super_admin` (the only role permitted to write)
 * and `maker` (proves the permission gate actually rejects everyone else), mirroring
 * `rule-category-crud.e2e-spec.ts`'s two-actor shape.
 *
 * Covers TC-1…TC-7 and verification steps 2 and 3. The credential assertions here are the ones
 * that matter most: they check the *observable* outcome in the two places a leak would actually
 * happen — the HTTP response body, and the raw database column — rather than restating what the
 * code intends (AGENT-PROTOCOL §3).
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as argon2 from 'argon2';
import request from 'supertest';
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { AppModule } from '@/app.module';
import { ARGON2_OPTIONS } from '@/modules/auth/auth.constants';
import { SEQUELIZE } from '@/database/sequelize.provider';
import { validationExceptionFactory } from '@/common/errors/validation.exception-factory';
import { CSRF_COOKIE_NAME } from '@/modules/auth/session.constants';
import { FieldValueSourceRegistriesService } from '@/modules/field-value-sources/field-value-source-registries.service';
import { ScopeContext } from '@/common/scope/scope-context';
import { loginCompletingMfa } from '../auth/support/super-admin-mfa';
import {
  deletePortalUsersByEmail,
  emailCryptoOf,
  ensureEncryptionKeys,
  insertPortalUser,
  removeEncryptionKeys,
} from '../auth/support/portal-user-fixture';
import type { PortalUserEmailCrypto } from '@/common/data-protection/portal-user-email.crypto';

jest.setTimeout(300_000);

const SUITE = 't121';
const PASSWORD = 'correct horse battery staple 13!';
const SUPER_ADMIN_EMAIL = 't121-e2e-super@example.invalid';
const MAKER_EMAIL = 't121-e2e-maker@example.invalid';
const STAMP = Date.now();
const NEW_API_CODE = `T121_LOOKUP_${STAMP}`;
const NEW_CTX_CODE = `T121_CONTEXT_${STAMP}`;
/** The value that must never appear in a response body or in the raw column. */
const SECRET = `sk_live_t121_${STAMP}`;

/**
 * T-168 — the seeded `field_api_lookup_providers` rows, split by whether anything is expected to
 * activate them.
 *
 * These tests used to assert that *all four* seeded rows stay `planned` with a `PLACEHOLDER`
 * endpoint forever. That was never the real invariant, only the state that happened to be true
 * when T-121 wrote them: `T165_001` legitimately flips `PROMO_CODE_CONFIG_SERVICE` to `active`
 * with a real `endpoint_url`, which broke both assertions even though nothing was wrong.
 *
 * The property actually worth protecting is the one T-121's own comment describes — *a row must
 * never look silently "ready"* — which is a pairing between two columns, not a fixed status:
 *
 *   `planned` ⟺ endpoint is still the placeholder   ·   `active` ⟺ endpoint is a real URL
 *
 * That holds both before and after `T165_001` runs, so these tests no longer depend on whether
 * that migration has been applied to the database they are pointed at.
 */
const STILL_PLANNED_API_PROVIDERS = ['ACTIVITY_LIST', 'MERCHANT_LIST', 'PRODUCT_CATALOG'] as const;

/** Seeded `planned` by `T121_002`; `T165_001` activates it with a real endpoint. */
const ACTIVATABLE_API_PROVIDER = 'PROMO_CODE_CONFIG_SERVICE';

const SEEDED_API_PROVIDERS = [...STILL_PLANNED_API_PROVIDERS, ACTIVATABLE_API_PROVIDER]
  .slice()
  .sort();

/** The marker `T121_002` writes into `endpoint_url` for a provider whose endpoint is unconfirmed. */
const PLACEHOLDER_MARKER = 'PLACEHOLDER';

/**
 * The cross-column invariant above, asserted for a single row. Used by the seeded-state tests and
 * by the T-168 regression test, so both check the same rule rather than two similar-looking ones.
 */
function expectStatusMatchesEndpoint(providerCode: string, status: string, endpointUrl: string) {
  const placeholder = endpointUrl.includes(PLACEHOLDER_MARKER);
  if (status === 'planned') {
    // A planned row must still be carrying the placeholder — if someone gave it a real endpoint
    // but left it planned, the endpoint is unreachable-by-policy and the row is misleading.
    expect({ providerCode, status, placeholder }).toEqual({
      providerCode,
      status: 'planned',
      placeholder: true,
    });
    return;
  }
  // The case that matters: nothing may be `active` while still pointing at the placeholder.
  expect({ providerCode, status, placeholder }).toEqual({
    providerCode,
    status: 'active',
    placeholder: false,
  });
  expect(endpointUrl).toMatch(/^https?:\/\/\S+$/);
}

/**
 * The whole seeded-state expectation as read back over HTTP.
 *
 * Deliberately a shared function rather than assertions inlined into the test that reads the live
 * database: the T-168 regression test drives the row into the post-`T165_001` state and calls
 * *this exact code*. If these assertions ever go back to hardcoding `planned`/`PLACEHOLDER` for
 * all four rows, that regression test goes red — which is the only reason it can be trusted to
 * catch the defect coming back.
 */
function assertSeededProvidersFromApi(
  rows: Array<{ providerCode: string; status: string; endpointUrl: string }>,
) {
  const seeded = rows.filter((r) => SEEDED_API_PROVIDERS.includes(r.providerCode));
  expect(seeded.map((r) => r.providerCode).sort()).toEqual(SEEDED_API_PROVIDERS);

  for (const row of seeded) {
    expectStatusMatchesEndpoint(row.providerCode, row.status, row.endpointUrl);
  }
  // The three nothing has claimed yet must still be untouched, whatever happened to the fourth.
  for (const code of STILL_PLANNED_API_PROVIDERS) {
    expect(seeded.find((r) => r.providerCode === code)?.status).toBe('planned');
  }
}

/** The same expectation, against the raw columns. Shared for the same reason as above. */
function assertSeededProviderRowsFromDb(
  rows: Array<{ provider_code: string; status: string; endpoint_url: string }>,
) {
  expect(rows.map((r) => r.provider_code).sort()).toEqual(SEEDED_API_PROVIDERS);
  for (const row of rows) {
    expectStatusMatchesEndpoint(row.provider_code, row.status, row.endpoint_url);
  }
  for (const code of STILL_PLANNED_API_PROVIDERS) {
    expect(rows.find((r) => r.provider_code === code)?.status).toBe('planned');
  }
}

let app: INestApplication;
let db: Sequelize;
let emailCrypto: PortalUserEmailCrypto;

interface Actor {
  jar: string;
  csrf: string;
}
const actors = new Map<string, Actor>();

function http() {
  return request(app.getHttpServer());
}

function cookieValue(response: request.Response, name: string): string {
  const header = response.headers['set-cookie'];
  const entries = Array.isArray(header) ? header : header === undefined ? [] : [header];
  const match = entries.find((entry) => entry.startsWith(`${name}=`));
  if (match === undefined) throw new Error(`no Set-Cookie for ${name}`);
  return decodeURIComponent(match.split(';')[0].slice(name.length + 1));
}

function jarFrom(response: request.Response): string {
  const header = response.headers['set-cookie'];
  const entries = Array.isArray(header) ? header : header === undefined ? [] : [header];
  return entries
    .map((entry) => entry.split(';')[0])
    .filter((pair) => !pair.endsWith('='))
    .join('; ');
}

function as(key: string): Actor {
  const actor = actors.get(key);
  if (actor === undefined) throw new Error(`no actor "${key}"`);
  return actor;
}

function get(key: string, path: string) {
  return http().get(`/api/v1${path}`).set('Cookie', as(key).jar);
}

function post(key: string, path: string, body: unknown) {
  return http()
    .post(`/api/v1${path}`)
    .set('Cookie', as(key).jar)
    .set('X-CSRF-Token', as(key).csrf)
    .send(body as object);
}

function patch(key: string, path: string, body: unknown) {
  return http()
    .patch(`/api/v1${path}`)
    .set('Cookie', as(key).jar)
    .set('X-CSRF-Token', as(key).csrf)
    .send(body as object);
}

async function makeActor(
  key: string,
  email: string,
  role: string,
  scope: { countryId: number | null; tenantId: number | null; merchantId: number | null } = {
    countryId: null,
    tenantId: null,
    merchantId: null,
  },
): Promise<void> {
  await deletePortalUsersByEmail(db, emailCrypto, [email]);
  const userId = await insertPortalUser(db, emailCrypto, {
    email,
    displayName: `T-121 ${key}`,
    role,
    ...scope,
    mustChangePassword: false,
  });
  await db.query(
    `INSERT INTO reward_portal.portal_user_credentials (user_id, password_hash, password_algo)
     VALUES (:userId, :hash, 'argon2id')`,
    { replacements: { userId, hash: await argon2.hash(PASSWORD, ARGON2_OPTIONS) } },
  );
  const response = await loginCompletingMfa(app, { email, password: PASSWORD }, db);
  if (response.status !== 200) {
    throw new Error(`login for ${key} failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
  actors.set(key, { jar: jarFrom(response), csrf: cookieValue(response, CSRF_COOKIE_NAME) });
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      exceptionFactory: validationExceptionFactory,
    }),
  );
  await app.init();

  db = app.get<Sequelize>(SEQUELIZE);
  await ensureEncryptionKeys(db, SUITE);
  emailCrypto = emailCryptoOf(app);

  const [{ id: tenantId, countryId }] = await db.query<{ id: number; countryId: number }>(
    `SELECT id, country_id AS "countryId" FROM reward_config.tenants LIMIT 1`,
    { type: QueryTypes.SELECT },
  );

  await makeActor('super', SUPER_ADMIN_EMAIL, 'super_admin');
  await makeActor('maker', MAKER_EMAIL, 'maker', { countryId, tenantId, merchantId: null });
});

afterAll(async () => {
  await db.query(
    `DELETE FROM reward_config.field_api_lookup_providers WHERE provider_code LIKE 'T121\\_%'`,
    { type: QueryTypes.RAW },
  );
  await db.query(
    `DELETE FROM reward_config.field_context_providers WHERE provider_code LIKE 'T121\\_%'`,
    { type: QueryTypes.RAW },
  );
  await deletePortalUsersByEmail(db, emailCrypto, [SUPER_ADMIN_EMAIL, MAKER_EMAIL]);
  await removeEncryptionKeys(db, SUITE);
  await app.close();
});

describe('T-121 — seeded registry reads', () => {
  it('TC-1: GET /field-context-providers returns SIBLING_COMPONENTS and JOURNEY_COMPONENTS, both active', async () => {
    const res = await get('maker', '/field-context-providers');
    expect(res.status).toBe(200);

    const rows = res.body.data as Array<{ providerCode: string; status: string }>;
    const seeded = rows.filter((r) =>
      ['SIBLING_COMPONENTS', 'JOURNEY_COMPONENTS'].includes(r.providerCode),
    );
    expect(seeded.map((r) => r.providerCode).sort()).toEqual([
      'JOURNEY_COMPONENTS',
      'SIBLING_COMPONENTS',
    ]);
    expect(seeded.every((r) => r.status === 'active')).toBe(true);
  });

  it('TC-2: GET /field-api-lookup-providers returns all 4 seeded rows, each one status-consistent with its endpoint', async () => {
    const res = await get('maker', '/field-api-lookup-providers');
    expect(res.status).toBe(200);

    const rows = res.body.data as Array<{
      providerCode: string;
      status: string;
      endpointUrl: string;
    }>;
    // The point of the whole `planned` decision: a query against this table must never look
    // silently "ready". Asserted as the status↔endpoint pairing (see the helpers above) so that
    // activating a provider through a migration is allowed, but activating one while it still
    // points at the unconfirmed placeholder endpoint is not.
    assertSeededProvidersFromApi(rows);
  });

  it('verification step 2: no seeded row exposes a credential field of any kind', async () => {
    const res = await get('maker', '/field-api-lookup-providers');
    const rows = res.body.data as Array<Record<string, unknown>>;

    for (const row of rows) {
      expect(row).not.toHaveProperty('authConfig');
      expect(row).not.toHaveProperty('authConfigEnc');
      expect(row).not.toHaveProperty('auth_config');
      expect(row).not.toHaveProperty('auth_config_enc');
    }
    // The non-secret shape a UI needs is present.
    expect(Object.keys(rows[0]).sort()).toEqual(
      [
        'authType',
        'description',
        'endpointUrl',
        'httpMethod',
        'id',
        'name',
        'responseLabelKey',
        'responseValueKey',
        'status',
        'providerCode',
      ].sort(),
    );
  });

  it('TC-7: unauthenticated GET is rejected on both endpoints', async () => {
    expect((await http().get('/api/v1/field-context-providers')).status).toBe(401);
    expect((await http().get('/api/v1/field-api-lookup-providers')).status).toBe(401);
  });
});

describe('T-121 — writes are super_admin only', () => {
  let createdApiId: number;

  it('TC-4: super_admin creates an API lookup provider — 201', async () => {
    const res = await post('super', '/field-api-lookup-providers', {
      providerCode: NEW_API_CODE,
      name: 'T-121 E2E Lookup',
      endpointUrl: 'https://internal.invalid/t121',
      httpMethod: 'GET',
      authType: 'api_key',
      authConfig: { headerName: 'X-Api-Key', apiKey: SECRET },
      responseValueKey: 'id',
      responseLabelKey: 'label',
    });
    expect(res.status).toBe(201);
    createdApiId = res.body.data.id as number;

    // The credential must not come back in the creating caller's own response either.
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
    expect(res.body.data).not.toHaveProperty('authConfig');
  });

  it('verification step 3: the raw auth_config_enc column holds ciphertext, never the plaintext', async () => {
    const [row] = await db.query<{ auth_config_enc: string | null }>(
      `SELECT auth_config_enc FROM reward_config.field_api_lookup_providers WHERE id = :id`,
      { type: QueryTypes.SELECT, replacements: { id: createdApiId } },
    );

    expect(row.auth_config_enc).toEqual(expect.stringMatching(/^v1\./));
    expect(row.auth_config_enc).not.toContain(SECRET);
    expect(row.auth_config_enc).not.toContain('X-Api-Key');
  });

  it('the stored ciphertext decrypts back to the original credential under the real row id', async () => {
    // Proves the two-phase INSERT → rebind actually completed: had the rebind been skipped, the
    // ciphertext would still be bound to the provisional AAD and this would return null.
    //
    // The call is wrapped in an explicit `ScopeContext.run` because `getAuthConfigForLookup` goes
    // through `ScopedRepository`, which refuses to run unscoped (T-013's fail-closed
    // `MissingScopeContextError`). In production T-123 calls this inside a request, where
    // `TenancyScopeInterceptor` has already established the scope; a test calling it directly has
    // to supply one the same way. Establishing the real scope is the correct fix here — relaxing
    // the repository guard to make a test pass would be exactly the trade AGENT-PROTOCOL §7
    // forbids.
    const service = app.get(FieldValueSourceRegistriesService);
    const config = await ScopeContext.run(
      {
        userId: 1,
        role: 'super_admin',
        countryId: null,
        tenantId: null,
        merchantId: null,
      },
      () => service.getAuthConfigForLookup(createdApiId),
    );
    expect(config).toEqual({ headerName: 'X-Api-Key', apiKey: SECRET });
  });

  it('getAuthConfigForLookup refuses to run without a scope context at all', async () => {
    // The other half of the guarantee above: the credential path is not reachable from a cron
    // job, a CLI or anything else outside a scoped request.
    const service = app.get(FieldValueSourceRegistriesService);
    await expect(service.getAuthConfigForLookup(createdApiId)).rejects.toThrow(/no ScopeContext/i);
  });

  it('no seeded row carries a plaintext placeholder in the encrypted column', async () => {
    // The task file asked for a placeholder in auth_config; writing plaintext into an `_enc`
    // column would break its contract, so the seed stores NULL and puts the placeholder in
    // endpoint_url instead. This asserts that decision held.
    const rows = await db.query<{
      provider_code: string;
      status: string;
      auth_config_enc: string | null;
      endpoint_url: string;
    }>(
      `SELECT provider_code, status, auth_config_enc, endpoint_url
         FROM reward_config.field_api_lookup_providers
        WHERE provider_code IN (:providerCodes)`,
      { type: QueryTypes.SELECT, replacements: { providerCodes: SEEDED_API_PROVIDERS } },
    );
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      // Unchanged by T-168: `T165_001` explicitly leaves `auth_config_enc` alone, because a
      // migration cannot produce valid ciphertext (no key registry in the Umzug context).
      expect(row.auth_config_enc).toBeNull();
    }
    // T-168: the endpoint check was `toContain('PLACEHOLDER')` for all four, which an activated
    // provider must legitimately fail. Checked against each row's own status instead.
    assertSeededProviderRowsFromDb(rows);
  });

  /**
   * T-168 regression. The original defect was that two tests hardcoded `T121_002`'s seeded state
   * as permanent, so `T165_001` activating `PROMO_CODE_CONFIG_SERVICE` turned them red even though
   * the activation was correct and intended.
   *
   * This drives the row through the exact state `T165_001` writes — without depending on whether
   * that migration has actually been applied here, which is the coupling that caused the defect —
   * and checks the invariant survives it. It also proves the invariant still has teeth, by
   * confirming the genuinely bad combination (`active` while still pointing at the placeholder) is
   * rejected. The row is restored afterwards either way.
   */
  it('T-168: the seeded-state assertions survive T165_001 activating a provider, and still reject an active placeholder', async () => {
    const [original] = await db.query<{
      status: string;
      endpoint_url: string;
      response_value_key: string;
      response_label_key: string;
      auth_type: string;
    }>(
      `SELECT status, endpoint_url, response_value_key, response_label_key, auth_type
         FROM reward_config.field_api_lookup_providers
        WHERE provider_code = :providerCode`,
      { type: QueryTypes.SELECT, replacements: { providerCode: ACTIVATABLE_API_PROVIDER } },
    );
    expect(original).toBeDefined();

    const restore = () =>
      db.query(
        `UPDATE reward_config.field_api_lookup_providers
            SET status = :status, endpoint_url = :endpointUrl,
                response_value_key = :valueKey, response_label_key = :labelKey,
                auth_type = :authType
          WHERE provider_code = :providerCode`,
        {
          type: QueryTypes.UPDATE,
          replacements: {
            providerCode: ACTIVATABLE_API_PROVIDER,
            status: original.status,
            endpointUrl: original.endpoint_url,
            valueKey: original.response_value_key,
            labelKey: original.response_label_key,
            authType: original.auth_type,
          },
        },
      );

    try {
      // Exactly what T165_001's `up()` writes.
      await db.query(
        `UPDATE reward_config.field_api_lookup_providers
            SET status = 'active', endpoint_url = :endpointUrl,
                response_value_key = 'id', response_label_key = 'name', auth_type = 'bearer'
          WHERE provider_code = :providerCode`,
        {
          type: QueryTypes.UPDATE,
          replacements: {
            providerCode: ACTIVATABLE_API_PROVIDER,
            endpointUrl: 'http://localhost:3010/api/v1/promo-code-configs',
          },
        },
      );

      const res = await get('maker', '/field-api-lookup-providers');
      expect(res.status).toBe(200);
      const rows = res.body.data as Array<{
        providerCode: string;
        status: string;
        endpointUrl: string;
      }>;

      const activated = rows.find((r) => r.providerCode === ACTIVATABLE_API_PROVIDER);
      expect(activated?.status).toBe('active');

      // The whole point of this test: run the *same* assertions the two seeded-state tests above
      // run, but against the activated row. These are the calls that go red if those assertions
      // ever revert to hardcoding `planned`/`PLACEHOLDER` for all four providers.
      assertSeededProvidersFromApi(rows);

      const dbRows = await db.query<{
        provider_code: string;
        status: string;
        endpoint_url: string;
      }>(
        `SELECT provider_code, status, endpoint_url
           FROM reward_config.field_api_lookup_providers
          WHERE provider_code IN (:providerCodes)`,
        { type: QueryTypes.SELECT, replacements: { providerCodes: SEEDED_API_PROVIDERS } },
      );
      assertSeededProviderRowsFromDb(dbRows);

      // The guard must still fail on the combination it exists to catch.
      expect(() =>
        expectStatusMatchesEndpoint(
          ACTIVATABLE_API_PROVIDER,
          'active',
          'PLACEHOLDER — confirm with data owner before flipping to active',
        ),
      ).toThrow();
    } finally {
      await restore();
    }

    const [after] = await db.query<{ status: string; endpoint_url: string }>(
      `SELECT status, endpoint_url FROM reward_config.field_api_lookup_providers
        WHERE provider_code = :providerCode`,
      { type: QueryTypes.SELECT, replacements: { providerCode: ACTIVATABLE_API_PROVIDER } },
    );
    expect(after.status).toBe(original.status);
    expect(after.endpoint_url).toBe(original.endpoint_url);
  });

  it('TC-5: a maker creating either kind of provider gets 403', async () => {
    const apiRes = await post('maker', '/field-api-lookup-providers', {
      providerCode: `${NEW_API_CODE}_MAKER`,
      name: 'nope',
      endpointUrl: 'https://internal.invalid/nope',
      responseValueKey: 'id',
      responseLabelKey: 'label',
    });
    expect(apiRes.status).toBe(403);

    const ctxRes = await post('maker', '/field-context-providers', {
      providerCode: `${NEW_CTX_CODE}_MAKER`,
      name: 'nope',
    });
    expect(ctxRes.status).toBe(403);
  });

  it('TC-5: a maker patching an existing provider gets 403 — and the row is unchanged', async () => {
    const res = await patch('maker', `/field-api-lookup-providers/${createdApiId}`, {
      status: 'active',
    });
    expect(res.status).toBe(403);

    const [row] = await db.query<{ status: string }>(
      `SELECT status FROM reward_config.field_api_lookup_providers WHERE id = :id`,
      { type: QueryTypes.SELECT, replacements: { id: createdApiId } },
    );
    expect(row.status).toBe('planned');
  });

  it('TC-6: a duplicate providerCode is 409 on both registries', async () => {
    const apiRes = await post('super', '/field-api-lookup-providers', {
      providerCode: NEW_API_CODE,
      name: 'duplicate',
      endpointUrl: 'https://internal.invalid/dup',
      responseValueKey: 'id',
      responseLabelKey: 'label',
    });
    expect(apiRes.status).toBe(409);

    const ctxRes = await post('super', '/field-context-providers', {
      providerCode: 'SIBLING_COMPONENTS',
      name: 'duplicate',
    });
    expect(ctxRes.status).toBe(409);
  });

  it('a new API lookup provider defaults to planned when status is omitted', async () => {
    const res = await post('super', '/field-api-lookup-providers', {
      providerCode: `${NEW_API_CODE}_DEFAULT`,
      name: 'T-121 default status',
      endpointUrl: 'https://internal.invalid/default',
      responseValueKey: 'id',
      responseLabelKey: 'label',
    });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('planned');
    expect(res.body.data.authType).toBe('none');
  });

  it('TC-4: super_admin creates and patches a context provider', async () => {
    const created = await post('super', '/field-context-providers', {
      providerCode: NEW_CTX_CODE,
      name: 'T-121 E2E Context',
    });
    expect(created.status).toBe(201);
    expect(created.body.data.status).toBe('active');

    const updated = await patch('super', `/field-context-providers/${created.body.data.id}`, {
      status: 'inactive',
      name: 'T-121 E2E Context renamed',
    });
    expect(updated.status).toBe(200);
    expect(updated.body.data.status).toBe('inactive');
    expect(updated.body.data.name).toBe('T-121 E2E Context renamed');
    // providerCode is immutable — T-122 stores it as a field's value-source reference.
    expect(updated.body.data.providerCode).toBe(NEW_CTX_CODE);
  });

  it('providerCode is rejected as an unknown field on PATCH (whitelist), never silently applied', async () => {
    const created = await post('super', '/field-context-providers', {
      providerCode: `${NEW_CTX_CODE}_IMMUTABLE`,
      name: 'T-121 immutability probe',
    });
    expect(created.status).toBe(201);

    await patch('super', `/field-context-providers/${created.body.data.id}`, {
      providerCode: 'RENAMED_CODE',
    });

    const [row] = await db.query<{ provider_code: string }>(
      `SELECT provider_code FROM reward_config.field_context_providers WHERE id = :id`,
      { type: QueryTypes.SELECT, replacements: { id: created.body.data.id as number } },
    );
    expect(row.provider_code).toBe(`${NEW_CTX_CODE}_IMMUTABLE`);
  });

  it('a malformed providerCode is rejected with 400', async () => {
    const res = await post('super', '/field-context-providers', {
      providerCode: 'lower case code',
      name: 'bad code',
    });
    expect(res.status).toBe(400);
  });
});
