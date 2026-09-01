/**
 * T-165 — AGENT-PROTOCOL R7 for this task's one migration ("every migration has a working
 * `down()`, proven by migrate → rollback → migrate on a clean DB"), plus TC-1…TC-6 and
 * verification steps 1–3.
 *
 * Runs the migration's own `up()`/`down()` directly (the same pattern
 * `test/campaigns/t127-migrations.e2e-spec.ts` uses for its own seed migration) against the
 * shared local dev Postgres, rather than through `npm run db:rollback -- --all` — that command
 * is blocked on this database by an earlier crypto-building migration's own irreversible `down()`
 * (see that file's header), so proving R7 on the one file this task owns is the only option that
 * does not destroy every other agent's in-progress work on the same database.
 *
 * ### Deviation from this task's own "Files owned" filename (flagged per AGENT-PROTOCOL §3)
 *
 * The task file names this spec `T165_001_activate_promo_code_config_service_provider.spec.ts`.
 * That exact name would not run under either Jest config in this workspace:
 * `jest.config.js`'s `roots` do not include `test/database` (so it is invisible to `npm test`),
 * and `test/jest-e2e.json`'s `testRegex` (`.e2e-spec.ts$`) does not match a bare `.spec.ts`
 * suffix (so it is also invisible to `npm run test:e2e`). Every other migration-behaviour test in
 * this codebase (`t102`, `t119`, `t126`, `t127-migrations`, ...) is instead named `*.e2e-spec.ts`
 * — the only suffix that is actually discovered and actually runs against the real database this
 * suite needs (TC-1…TC-6 all depend on real Postgres constraints/behaviour, not a fake). This
 * file keeps the task-specified directory and base name but uses that working suffix instead, so
 * R10 ("no failing check", including "a test nobody ever runs") is genuinely satisfied.
 *
 * ### A pre-existing, out-of-scope consequence (filed, not fixed here — R9)
 *
 * Activating `PROMO_CODE_CONFIG_SERVICE` on the shared dev database is the entire point of this
 * task, and it makes two already-`done` tasks' own e2e assertions about that one row's permanent
 * `planned`/placeholder state stale (`test/field-value-sources/field-value-source-registries
 * .e2e-spec.ts`, `test/field-value-sources/field-value-source-lookup.e2e-spec.ts`). Neither file
 * is in this task's `Files owned`, so R9 forbids fixing them here — filed as T-168 (owner
 * agent-security) and T-169 (owner agent-qa) instead. See T-165's own completion report.
 */
import 'reflect-metadata';
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
import type { PortalUserEmailCrypto } from '@/common/data-protection/portal-user-email.crypto';
import * as activateProvider from '@/database/migrations/T165_001_activate_promo_code_config_service_provider';
import { loginCompletingMfa } from '../../auth/support/super-admin-mfa';
import {
  deletePortalUsersByEmail,
  emailCryptoOf,
  ensureEncryptionKeys,
  insertPortalUser,
  removeEncryptionKeys,
} from '../../auth/support/portal-user-fixture';

jest.setTimeout(120_000);

const SUITE = 't165';
const PASSWORD = 'correct horse battery staple 13!';
const MAKER_EMAIL = 't165-e2e-maker@example.invalid';
const REAL_BASE_URL = 'http://localhost:3010';

let app: INestApplication;
let db: Sequelize;
let emailCrypto: PortalUserEmailCrypto;

interface ProviderRow {
  status: string;
  endpoint_url: string;
  response_value_key: string;
  response_label_key: string;
  auth_type: string;
  auth_config_enc: string | null;
}

async function providerRow(): Promise<ProviderRow> {
  const rows = await db.query<ProviderRow>(
    `SELECT status, endpoint_url, response_value_key, response_label_key, auth_type, auth_config_enc
       FROM reward_config.field_api_lookup_providers
      WHERE provider_code = :code`,
    { type: QueryTypes.SELECT, replacements: { code: activateProvider.PROVIDER_CODE } },
  );
  if (rows.length !== 1) {
    throw new Error(
      `expected exactly 1 ${activateProvider.PROVIDER_CODE} row, found ${rows.length}`,
    );
  }
  return rows[0];
}

async function providerRowCount(): Promise<number> {
  const [row] = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM reward_config.field_api_lookup_providers
      WHERE provider_code = :code`,
    { type: QueryTypes.SELECT, replacements: { code: activateProvider.PROVIDER_CODE } },
  );
  return Number(row.count);
}

/** Runs `up()` with a real, valid `PROMO_CODE_SERVICE_BASE_URL` in scope for the call only. */
async function runUp(): Promise<void> {
  const original = process.env.PROMO_CODE_SERVICE_BASE_URL;
  process.env.PROMO_CODE_SERVICE_BASE_URL = REAL_BASE_URL;
  try {
    await activateProvider.up({ context: db });
  } finally {
    if (original === undefined) delete process.env.PROMO_CODE_SERVICE_BASE_URL;
    else process.env.PROMO_CODE_SERVICE_BASE_URL = original;
  }
}

function assertActiveState(row: ProviderRow): void {
  expect(row.status).toBe('active');
  expect(row.endpoint_url).toBe(`${REAL_BASE_URL}/api/v1/promo-code-configs`);
  expect(row.response_value_key).toBe('id');
  expect(row.response_label_key).toBe('name');
  expect(row.auth_type).toBe('bearer');
  // Implementation note 3 / this file's header: a migration cannot produce valid ciphertext,
  // so this column is never written by T165_001, in either direction.
  expect(row.auth_config_enc).toBeNull();
}

function assertPlannedState(row: ProviderRow): void {
  expect(row.status).toBe('planned');
  expect(row.endpoint_url).toBe(activateProvider.PLACEHOLDER_ENDPOINT_FROM_T121_002);
  expect(row.response_value_key).toBe(activateProvider.PLACEHOLDER_RESPONSE_VALUE_KEY);
  expect(row.response_label_key).toBe(activateProvider.PLACEHOLDER_RESPONSE_LABEL_KEY);
  expect(row.auth_type).toBe('none');
  expect(row.auth_config_enc).toBeNull();
}

// --- HTTP fixture (TC-6 / verification step 3) --------------------------------------------

function http() {
  return request(app.getHttpServer());
}

function jarFrom(response: request.Response): string {
  const header = response.headers['set-cookie'];
  const entries = Array.isArray(header) ? header : header === undefined ? [] : [header];
  return entries
    .map((entry) => entry.split(';')[0])
    .filter((pair) => !pair.endsWith('='))
    .join('; ');
}

let makerJar: string;

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

  const [tenantRow] = await db.query<{ id: number; countryId: number }>(
    `SELECT id, country_id AS "countryId" FROM reward_config.tenants LIMIT 1`,
    { type: QueryTypes.SELECT },
  );

  await deletePortalUsersByEmail(db, emailCrypto, [MAKER_EMAIL]);
  const makerId = await insertPortalUser(db, emailCrypto, {
    email: MAKER_EMAIL,
    displayName: 'T-165 maker',
    role: 'maker',
    countryId: tenantRow.countryId,
    tenantId: tenantRow.id,
    merchantId: null,
    mustChangePassword: false,
  });
  await db.query(
    `INSERT INTO reward_portal.portal_user_credentials (user_id, password_hash, password_algo)
     VALUES (:userId, :hash, 'argon2id')`,
    { replacements: { userId: makerId, hash: await argon2.hash(PASSWORD, ARGON2_OPTIONS) } },
  );
  const login = await loginCompletingMfa(app, { email: MAKER_EMAIL, password: PASSWORD }, db);
  if (login.status !== 200) {
    throw new Error(`maker login failed: ${login.status} ${JSON.stringify(login.body)}`);
  }
  makerJar = jarFrom(login);
});

afterAll(async () => {
  // Leave the shared dev database exactly as every other suite expects to find it going
  // forward: the migration applied (13-REWARD-MASTER-VALUE-SOURCES.md's whole point for this
  // task). Idempotent — a no-op if the last test already left it active.
  await runUp();

  await deletePortalUsersByEmail(db, emailCrypto, [MAKER_EMAIL]);
  await removeEncryptionKeys(db, SUITE);
  await app.close();
});

describe('T165_001 — up()/down() against reward_config.field_api_lookup_providers', () => {
  it('TC-1: applying up() against the T121_002 baseline updates the row in place — count stays 1', async () => {
    // Establish the T121_002 baseline this TC names explicitly, regardless of what state an
    // earlier run of this same suite (or another agent's `db:migrate`) left behind.
    await activateProvider.down({ context: db });
    expect(await providerRowCount()).toBe(1);
    assertPlannedState(await providerRow());

    await runUp();

    expect(await providerRowCount()).toBe(1);
    assertActiveState(await providerRow());
  });

  it('TC-2: the post-migration row state matches exactly', async () => {
    assertActiveState(await providerRow());
  });

  it('TC-3: re-running up() on an already-activated row is a no-op — no error, no duplicate row', async () => {
    await expect(runUp()).resolves.toBeUndefined();
    expect(await providerRowCount()).toBe(1);
    assertActiveState(await providerRow());
  });

  it('TC-4: down() then up() returns to the exact TC-2 state', async () => {
    await activateProvider.down({ context: db });
    assertPlannedState(await providerRow());

    await runUp();
    assertActiveState(await providerRow());
  });

  it('TC-5: a missing PROMO_CODE_SERVICE_BASE_URL throws and never writes a malformed endpoint_url', async () => {
    // Start from the `planned` baseline so a bug that silently activated anyway would be visible.
    await activateProvider.down({ context: db });
    const before = await providerRow();

    const original = process.env.PROMO_CODE_SERVICE_BASE_URL;
    delete process.env.PROMO_CODE_SERVICE_BASE_URL;
    try {
      await expect(activateProvider.up({ context: db })).rejects.toThrow(
        /PROMO_CODE_SERVICE_BASE_URL/,
      );
    } finally {
      if (original === undefined) delete process.env.PROMO_CODE_SERVICE_BASE_URL;
      else process.env.PROMO_CODE_SERVICE_BASE_URL = original;
    }

    const after = await providerRow();
    expect(after).toEqual(before);
    expect(after.endpoint_url).not.toContain('undefined');
    assertPlannedState(after);

    // Restore the active state the rest of this suite (and every other agent's own e2e run)
    // expects to find.
    await runUp();
  });

  it('verification step 3 / TC-6: GET .../PROMO_CODE_CONFIG_SERVICE is 502, not 501, before the manual auth_config step', async () => {
    // TC-2 already proved status=active/auth_type=bearer/auth_config_enc=NULL is the state this
    // migration leaves behind; this proves what that state means to the live endpoint T-123
    // already ships: a provider genuinely "active but not yet credentialed" is a clean upstream
    // failure (502), never the "not available yet" 501 a `planned`/`inactive` provider gets, and
    // never a silent, unauthenticated call.
    assertActiveState(await providerRow());

    const res = await http()
      .get(`/api/v1/field-value-sources/api/${activateProvider.PROVIDER_CODE}`)
      .set('Cookie', makerJar);

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('FIELD_API_LOOKUP_UPSTREAM_ERROR');
  });
});
