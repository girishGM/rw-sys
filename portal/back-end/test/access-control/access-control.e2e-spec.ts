/**
 * T-033 — `/admin/access-control` against the **real** Postgres instance, through the real
 * `AppModule`, over real HTTP, as every role. Follows the harness `test/rules/rules.e2e-spec.ts`
 * (T-031) and `test/me/me.e2e-spec.ts` (T-015) both establish: real login (through MFA for
 * `super_admin`, T-055), real cookies, real guards, real `ScopedRepository` scoping.
 *
 * ### Why `checker` is this suite's mutation target
 *
 * `role_nav_configs`/`role_dashboard_widgets`/`role_entity_permissions` are global, shared rows —
 * not scoped to any tenant this suite creates. `test/me/me.e2e-spec.ts` already live-mutates
 * `maker`/`merchant` rows (restoring in `finally`/`afterAll`) and `test/rules/rules.e2e-spec.ts`
 * live-mutates `maker`'s `rule` permission row for the same reason. This suite's own destructive,
 * full-replace `PUT`s therefore target `checker` — the one role none of those suites touches —
 * and every one of them snapshots the row set first (via a real `GET`, the seed constants below
 * are the fallback source of truth) and restores it via a real `PUT` in a `finally` block, the
 * same discipline `test/rbac/rbac.e2e-spec.ts` TC-16 established for a single-row mutation.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import * as argon2 from 'argon2';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { ARGON2_OPTIONS } from '@/modules/auth/auth.constants';
import { SEQUELIZE } from '@/database/sequelize.provider';
import { validationExceptionFactory } from '@/common/errors/validation.exception-factory';
import type { PortalRole } from '@/database/portal-models';
import { CSRF_COOKIE_NAME } from '@/modules/auth/session.constants';
import { ROLE_NAV_CONFIGS } from '@/database/migrations/T004_002_seed_role_nav_configs';
import { ROLE_DASHBOARD_WIDGETS } from '@/database/migrations/T004_003_seed_role_dashboard_widgets';
import { ROLE_ENTITY_PERMISSIONS } from '@/database/migrations/T004_001_seed_role_entity_permissions';
// T-072 — see the T-062 describe block below for why this is imported here.
import { up as applyCampaignPausePermissions } from '@/database/migrations/T047_003_campaign_pause_permissions';
import { loginCompletingMfa } from '../auth/support/super-admin-mfa';
import {
  deletePortalUsersByEmail,
  emailCryptoOf,
  ensureEncryptionKeys,
  insertPortalUser,
  removeEncryptionKeys,
} from '../auth/support/portal-user-fixture';
import type { PortalUserEmailCrypto } from '@/common/data-protection/portal-user-email.crypto';
import { expectErrorEnvelope } from '../common/support/error-envelope';

jest.setTimeout(300_000);

const T033_SUITE = 't033';
const PASSWORD = 'correct horse battery staple 7!';
const MUTATION_ROLE: PortalRole = 'checker';

let app: INestApplication;
let db: Sequelize;
let emailCrypto: PortalUserEmailCrypto;

interface Actor {
  readonly key: string;
  readonly email: string;
  readonly userId: number;
  readonly jar: string;
  readonly csrf: string;
}
const actors = new Map<string, Actor>();

function http() {
  return request(app.getHttpServer());
}

async function sql<T extends object>(
  statement: string,
  replacements: Record<string, unknown> = {},
): Promise<T[]> {
  return db.query<T>(statement, { type: QueryTypes.SELECT, replacements });
}

async function exec(statement: string, replacements: Record<string, unknown> = {}): Promise<void> {
  await db.query(statement, { type: QueryTypes.RAW, replacements });
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

async function makeActor(key: string, role: PortalRole): Promise<Actor> {
  const email = `t033-e2e-${key}@example.invalid`;
  await deletePortalUsersByEmail(db, emailCrypto, [email]);

  const scopeFor: Record<
    PortalRole,
    { countryId: number | null; tenantId: number | null; merchantId: number | null }
  > = {
    super_admin: { countryId: null, tenantId: null, merchantId: null },
    country_admin: { countryId: countryId, tenantId: null, merchantId: null },
    tenant_admin: { countryId: countryId, tenantId: tenantId, merchantId: null },
    maker: { countryId: countryId, tenantId: tenantId, merchantId: null },
    checker: { countryId: countryId, tenantId: tenantId, merchantId: null },
    merchant: { countryId: countryId, tenantId: tenantId, merchantId: merchantId },
  };

  const userId = await insertPortalUser(db, emailCrypto, {
    email,
    displayName: `T-033 ${key}`,
    role,
    ...scopeFor[role],
    mustChangePassword: false,
  });

  await exec(
    `INSERT INTO reward_portal.portal_user_credentials (user_id, password_hash, password_algo)
     VALUES (:userId, :hash, 'argon2id')`,
    { userId, hash: await argon2.hash(PASSWORD, ARGON2_OPTIONS) },
  );

  const response = await loginCompletingMfa(app, { email, password: PASSWORD }, db);
  if (response.status !== 200) {
    throw new Error(`login for ${key} failed: ${response.status} ${JSON.stringify(response.body)}`);
  }

  const actor: Actor = {
    key,
    email,
    userId,
    jar: jarFrom(response),
    csrf: cookieValue(response, CSRF_COOKIE_NAME),
  };
  actors.set(key, actor);
  return actor;
}

function as(key: string): Actor {
  const found = actors.get(key);
  if (found === undefined) throw new Error(`no actor "${key}"`);
  return found;
}

function get(key: string, path: string) {
  return http().get(`/api/v1${path}`).set('Cookie', as(key).jar);
}

function put(key: string, path: string, body: unknown) {
  return http()
    .put(`/api/v1${path}`)
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

function post(key: string, path: string, body: unknown = {}) {
  return http()
    .post(`/api/v1${path}`)
    .set('Cookie', as(key).jar)
    .set('X-CSRF-Token', as(key).csrf)
    .send(body as object);
}

// --- fixtures ------------------------------------------------------------------------------------

let countryId: number;
let tenantId: number;
let merchantId: number;

async function ensureCountry(code: string, name: string): Promise<number> {
  const [existing] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.countries WHERE code = :code',
    {
      code,
    },
  );
  if (existing !== undefined) return existing.id;
  const [created] = await sql<{ id: number }>(
    `INSERT INTO reward_config.countries (code, name, timezone, currency_code, dialing_code, status)
     VALUES (:code, :name, 'UTC', 'USD', '+001', 'active') RETURNING id`,
    { code, name },
  );
  return created.id;
}

async function ensureTenant(code: string, countryIdValue: number): Promise<number> {
  const [existing] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.tenants WHERE code = :code',
    {
      code,
    },
  );
  if (existing !== undefined) return existing.id;
  const [created] = await sql<{ id: number }>(
    `INSERT INTO reward_config.tenants (code, name, country_id, status)
     VALUES (:code, :code, :countryId, 'active') RETURNING id`,
    { code, countryId: countryIdValue },
  );
  return created.id;
}

async function ensureMerchant(code: string, tenantIdValue: number): Promise<number> {
  const [existing] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.merchants WHERE merchant_code = :code',
    { code },
  );
  if (existing !== undefined) return existing.id;
  const [created] = await sql<{ id: number }>(
    `INSERT INTO reward_config.merchants (tenant_id, merchant_code, name, country_code, status)
     VALUES (:tenantId, :code, :code, 'MY', 'active') RETURNING id`,
    { tenantId: tenantIdValue, code },
  );
  return created.id;
}

// --- lifecycle -------------------------------------------------------------------------------

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  await ensureEncryptionKeys(moduleRef.get<Sequelize>(SEQUELIZE), T033_SUITE);

  app = moduleRef.createNestApplication();
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

  // `reward_config.countries.code` is `CHAR(2)` (ISO-3166-1-alpha-2-shaped) — the same
  // constraint `rules.e2e-spec.ts` ('R1'/'R2') and `rewards.e2e-spec.ts` ('W1'/'W2') already
  // respect. A longer code here (T-033 retry 1 finding) made this `INSERT` fail every run with
  // `value too long for type character(2)`, and — compounded by the `afterAll` gap fixed below —
  // that looked indistinguishable from an indefinite hang once output was piped rather than
  // watched on a TTY (see the T-033 retry-1 completion report for the full trace). 'AC' is not
  // used by any other suite (grepped across `test/*/*.e2e-spec.ts`).
  countryId = await ensureCountry('AC', 'T-033 e2e country');
  tenantId = await ensureTenant('T033E2E_TENANT', countryId);
  merchantId = await ensureMerchant('T033E2E_MERCHANT', tenantId);

  await makeActor('super', 'super_admin');
  await makeActor('adminA', 'country_admin');
  await makeActor('tenantA', 'tenant_admin');
  await makeActor('makerA', 'maker');
  await makeActor('checkerA', 'checker');
  await makeActor('merchantA', 'merchant');
});

afterAll(async () => {
  // `app.close()` must run even if anything above it throws — including a `beforeAll` that
  // failed partway (e.g. before any actor was logged in). It used to sit as a second, unguarded
  // top-level statement after the cleanup block below; if `restoreNav()` throws (it calls
  // `as('super')`, which throws synchronously when `actors` is still empty), that throw
  // propagated straight out of this hook and `app.close()` was never reached — leaking the
  // listening HTTP server and the Postgres pool connection for the rest of the process's life.
  // In a piped/non-TTY run that looks exactly like an indefinite hang: the process never exits,
  // so its already-buffered stdout (the real failure Jest already reported) never flushes either
  // (T-033 retry 1 finding — see the completion report for the full trace).
  try {
    if (db !== undefined) {
      // Only meaningful once `beforeAll` got far enough to log the `super` actor in — skipped,
      // not thrown, otherwise, so an early `beforeAll` failure cannot also strand this hook.
      if (actors.has('super')) {
        // Restore the mutation role's config to the seed's exact original shape, whatever the
        // last test in this file left it in — belt-and-braces alongside every test's own
        // `finally`.
        await restoreNav();
        await restoreWidgets();
        await restorePermissions();
      }

      for (const actor of actors.values()) {
        await exec('DELETE FROM reward_portal.portal_users WHERE id = :id', { id: actor.userId });
      }
      await removeEncryptionKeys(db, T033_SUITE);
    }
  } finally {
    if (app !== undefined) await app.close();
  }
});

// --- restore helpers, through the real API --------------------------------------------------

function seedNavItems() {
  return ROLE_NAV_CONFIGS.filter((row) => row.role === MUTATION_ROLE).map((row) => ({
    navKey: row.navKey,
    label: row.label,
    icon: null,
    path: row.path,
    parentNavKey: null,
    sortOrder: row.sortOrder,
    enabled: true,
  }));
}

function seedWidgetItems() {
  return ROLE_DASHBOARD_WIDGETS.filter((row) => row.role === MUTATION_ROLE).map((row) => ({
    widgetKey: row.widgetKey,
    label: row.label,
    config: { type: row.type },
    sortOrder: row.sortOrder,
    enabled: true,
  }));
}

function seedPermissions(): Record<string, string[]> {
  const permissions: Record<string, string[]> = {};
  for (const row of ROLE_ENTITY_PERMISSIONS) {
    if (row.role === MUTATION_ROLE) permissions[row.entity] = [...row.actions];
  }
  return permissions;
}

async function restoreNav(): Promise<void> {
  const current = await get('super', `/admin/access-control/nav/${MUTATION_ROLE}`);
  if (current.status !== 200) return;
  await put('super', `/admin/access-control/nav/${MUTATION_ROLE}`, {
    expectedVersion: current.body.data.version,
    items: seedNavItems(),
  });
}

async function restoreWidgets(): Promise<void> {
  const current = await get('super', `/admin/access-control/widgets/${MUTATION_ROLE}`);
  if (current.status !== 200) return;
  await put('super', `/admin/access-control/widgets/${MUTATION_ROLE}`, {
    expectedVersion: current.body.data.version,
    items: seedWidgetItems(),
  });
}

async function restorePermissions(): Promise<void> {
  const current = await get('super', `/admin/access-control/permissions/${MUTATION_ROLE}`);
  if (current.status !== 200) return;
  await put('super', `/admin/access-control/permissions/${MUTATION_ROLE}`, {
    expectedVersion: current.body.data.version,
    permissions: seedPermissions(),
  });
}

// --- the suite -------------------------------------------------------------------------------

describe('T-033 — GET /admin/access-control/roles — TC-1', () => {
  it('lists all six roles with a user count each', async () => {
    const response = await get('super', '/admin/access-control/roles');
    expect(response.status).toBe(200);
    const roles = response.body.data as { role: string; userCount: number }[];
    expect(roles.map((r) => r.role).sort()).toEqual(
      ['super_admin', 'country_admin', 'tenant_admin', 'maker', 'checker', 'merchant'].sort(),
    );
    expect(roles.every((r) => typeof r.userCount === 'number')).toBe(true);
  });
});

describe('T-033 — authorisation (TC-2, TC-3, TC-4)', () => {
  it('TC-2/3: every non-super_admin role gets 403 on every route family', async () => {
    for (const key of ['adminA', 'tenantA', 'makerA', 'checkerA', 'merchantA']) {
      const roles = await get(key, '/admin/access-control/roles');
      expect(roles.status).toBe(403);
      expectErrorEnvelope(roles.body, 'PERM_DENIED');

      const nav = await get(key, '/admin/access-control/nav/maker');
      expect(nav.status).toBe(403);

      const preview = await post(key, '/admin/access-control/preview', { role: 'maker' });
      expect(preview.status).toBe(403);
    }
  });

  it('TC-4: unauthenticated → 401', async () => {
    const response = await http().get('/api/v1/admin/access-control/roles');
    expect(response.status).toBe(401);
  });
});

describe('T-033 — GET /admin/access-control/entities', () => {
  it('lists the catalogue with rule/reward create/update/delete marked protected', async () => {
    const response = await get('super', '/admin/access-control/entities');
    expect(response.status).toBe(200);
    const entities = response.body.data as { entity: string; protectedActions: string[] }[];
    const rule = entities.find((e) => e.entity === 'rule');
    expect(rule?.protectedActions.sort()).toEqual(['create', 'delete', 'update']);
  });
});

describe('T-033 — lock-out prevention (TC-11, TC-12, verification steps 2/4)', () => {
  it('TC-11: removing access_control view/update from super_admin → 422, unchanged in DB', async () => {
    const before = await get('super', '/admin/access-control/permissions/super_admin');
    expect(before.status).toBe(200);

    const attempt = await put('super', '/admin/access-control/permissions/super_admin', {
      expectedVersion: before.body.data.version,
      permissions: { ...before.body.data.permissions, access_control: ['view'] },
    });
    expect(attempt.status).toBe(422);
    expectErrorEnvelope(attempt.body, 'CANNOT_LOCK_OUT_SUPER_ADMIN');

    const after = await get('super', '/admin/access-control/permissions/super_admin');
    expect(after.body.data.permissions.access_control.sort()).toEqual(
      before.body.data.permissions.access_control.sort(),
    );
    expect(after.body.data.version).toBe(before.body.data.version);
  });

  it('TC-11 bullet 3: removing user:create from super_admin → 422', async () => {
    const before = await get('super', '/admin/access-control/permissions/super_admin');
    const attempt = await put('super', '/admin/access-control/permissions/super_admin', {
      expectedVersion: before.body.data.version,
      permissions: { ...before.body.data.permissions, user: ['view'] },
    });
    expect(attempt.status).toBe(422);
    expectErrorEnvelope(attempt.body, 'CANNOT_LOCK_OUT_SUPER_ADMIN');
  });

  it('TC-12: disabling the access_control nav entry for super_admin → 422, unchanged', async () => {
    const before = await get('super', '/admin/access-control/nav/super_admin');
    expect(before.status).toBe(200);

    const items = (before.body.data.items as { navKey: string; enabled: boolean }[]).map((item) =>
      item.navKey === 'access_control' ? { ...item, enabled: false } : item,
    );
    const attempt = await put('super', '/admin/access-control/nav/super_admin', {
      expectedVersion: before.body.data.version,
      items,
    });
    expect(attempt.status).toBe(422);
    expectErrorEnvelope(attempt.body, 'CANNOT_LOCK_OUT_SUPER_ADMIN');

    const after = await get('super', '/admin/access-control/nav/super_admin');
    expect(after.body.data.version).toBe(before.body.data.version);
    const accessControlEntry = (
      after.body.data.items as { navKey: string; enabled: boolean }[]
    ).find((item) => item.navKey === 'access_control');
    expect(accessControlEntry?.enabled).toBe(true);
  });

  it('removing the access_control item from super_admin nav entirely → 422', async () => {
    const before = await get('super', '/admin/access-control/nav/super_admin');
    const items = (before.body.data.items as { navKey: string }[]).filter(
      (item) => item.navKey !== 'access_control',
    );
    const attempt = await put('super', '/admin/access-control/nav/super_admin', {
      expectedVersion: before.body.data.version,
      items,
    });
    expect(attempt.status).toBe(422);
  });
});

describe('T-033 — protected permissions (TC-13, TC-14, verification step 5)', () => {
  it('TC-13: granting rule:create to maker → 422 PROTECTED_PERMISSION', async () => {
    const before = await get('super', '/admin/access-control/permissions/maker');
    const attempt = await put('super', '/admin/access-control/permissions/maker', {
      expectedVersion: before.body.data.version,
      permissions: { ...before.body.data.permissions, rule: ['view', 'create'] },
    });
    expect(attempt.status).toBe(422);
    expectErrorEnvelope(attempt.body, 'PROTECTED_PERMISSION');
  });

  it('TC-14: granting reward:create to country_admin → 422', async () => {
    const before = await get('super', '/admin/access-control/permissions/country_admin');
    const attempt = await put('super', '/admin/access-control/permissions/country_admin', {
      expectedVersion: before.body.data.version,
      permissions: { ...before.body.data.permissions, reward: ['view', 'create'] },
    });
    expect(attempt.status).toBe(422);
    expectErrorEnvelope(attempt.body, 'PROTECTED_PERMISSION');
  });
});

describe('T-033 — full replace, versioning and audit (TC-6…TC-10, TC-17, TC-18, TC-20, TC-24)', () => {
  it('TC-18/TC-20: a successful nav write bumps rbac_version and writes one audited diff', async () => {
    const before = await get('super', `/admin/access-control/nav/${MUTATION_ROLE}`);
    expect(before.status).toBe(200);

    try {
      const items = (before.body.data.items as { navKey: string; enabled: boolean }[]).map(
        (item) => (item.navKey === 'campaigns' ? { ...item, enabled: false } : item),
      );
      const response = await put('super', `/admin/access-control/nav/${MUTATION_ROLE}`, {
        expectedVersion: before.body.data.version,
        items,
      });
      expect(response.status).toBe(200);
      expect(response.body.data.version).toBe(before.body.data.version + 1);

      const [audit] = await sql<{ event_type: string; detail: unknown }>(
        `SELECT event_type, detail FROM reward_portal.portal_audit_log
          WHERE event_type = 'nav_config_updated' AND target_id = :role
          ORDER BY occurred_at DESC LIMIT 1`,
        { role: MUTATION_ROLE },
      );
      expect(audit).toBeDefined();
      expect(audit.detail).toHaveProperty('diff');
    } finally {
      await restoreNav();
    }
  });

  it("a disabled nav item disappears from that role's next bootstrap (TC-6/TC-7 analogue)", async () => {
    const before = await get('super', `/admin/access-control/nav/${MUTATION_ROLE}`);
    try {
      const items = (before.body.data.items as { navKey: string; enabled: boolean }[]).map(
        (item) => (item.navKey === 'campaigns' ? { ...item, enabled: false } : item),
      );
      const put1 = await put('super', `/admin/access-control/nav/${MUTATION_ROLE}`, {
        expectedVersion: before.body.data.version,
        items,
      });
      expect(put1.status).toBe(200);

      const bootstrap = await get('checkerA', '/me/bootstrap');
      expect(bootstrap.status).toBe(200);
      const keys = (bootstrap.body.data.nav as { key: string }[]).map((n) => n.key);
      expect(keys).not.toContain('campaigns');
    } finally {
      await restoreNav();
    }
  });

  it('TC-8: reordering nav persists the new sort_order (single bulk call)', async () => {
    const before = await get('super', `/admin/access-control/nav/${MUTATION_ROLE}`);
    try {
      const response = await patch('super', `/admin/access-control/nav/${MUTATION_ROLE}/reorder`, {
        expectedVersion: before.body.data.version,
        order: [{ key: 'approvals', sortOrder: 99 }],
      });
      expect(response.status).toBe(200);
      const approvals = (response.body.data.items as { navKey: string; sortOrder: number }[]).find(
        (item) => item.navKey === 'approvals',
      );
      expect(approvals?.sortOrder).toBe(99);
    } finally {
      await restoreNav();
    }
  });

  it('TC-15/TC-16: reordering and disabling a widget changes the dashboard, restorable', async () => {
    const before = await get('super', `/admin/access-control/widgets/${MUTATION_ROLE}`);
    try {
      const items = (before.body.data.items as { widgetKey: string; enabled: boolean }[]).map(
        (item) => (item.widgetKey === 'kpi_approved_today' ? { ...item, enabled: false } : item),
      );
      const response = await put('super', `/admin/access-control/widgets/${MUTATION_ROLE}`, {
        expectedVersion: before.body.data.version,
        items,
      });
      expect(response.status).toBe(200);

      const bootstrap = await get('checkerA', '/me/bootstrap');
      const widgetKeys = (bootstrap.body.data.widgets as { key: string }[]).map((w) => w.key);
      expect(widgetKeys).not.toContain('kpi_approved_today');
    } finally {
      await restoreWidgets();
    }
  });

  it("TC-9: granting a new permission takes effect on that role's next bootstrap", async () => {
    const before = await get('super', `/admin/access-control/permissions/${MUTATION_ROLE}`);
    try {
      const response = await put('super', `/admin/access-control/permissions/${MUTATION_ROLE}`, {
        expectedVersion: before.body.data.version,
        permissions: { ...before.body.data.permissions, notification: ['view'] },
      });
      expect(response.status).toBe(200);

      const bootstrap = await get('checkerA', '/me/bootstrap');
      expect(bootstrap.body.data.permissions.notification).toEqual(['view']);
    } finally {
      await restorePermissions();
    }
  });

  it('TC-24: PUT with an empty permission array is accepted', async () => {
    const before = await get('super', `/admin/access-control/permissions/${MUTATION_ROLE}`);
    try {
      const response = await put('super', `/admin/access-control/permissions/${MUTATION_ROLE}`, {
        expectedVersion: before.body.data.version,
        permissions: {},
      });
      expect(response.status).toBe(200);
      expect(response.body.data.permissions).toEqual({});
    } finally {
      await restorePermissions();
    }
  });

  it('TC-23: an unknown entity in a PUT is rejected with 400 against the catalogue', async () => {
    const before = await get('super', `/admin/access-control/permissions/${MUTATION_ROLE}`);
    const response = await put('super', `/admin/access-control/permissions/${MUTATION_ROLE}`, {
      expectedVersion: before.body.data.version,
      permissions: { not_a_real_entity: ['view'] },
    });
    expect(response.status).toBe(400);
    expectErrorEnvelope(response.body, 'VALIDATION_FAILED');
  });
});

/**
 * T-062 — reproduces the real UI interaction the bug report described ("open Access Control,
 * uncheck one checkbox, click Save") against `tenant_admin`, not `MUTATION_ROLE`. This is
 * deliberate, not incidental: `tenant_admin` is the one role `T047_003_campaign_pause_permissions`
 * (out of this task's file scope, T-047's own migration) rewrote after `T004_001`'s original seed
 * — its `campaign` row legitimately holds `pause`/`resume` in the live database. A full-replace
 * `PUT` always resubmits the role's *entire current* matrix (implementation note 5), so this is
 * the one role whose ordinary Save round-trip actually exercises a catalogue gap; `MUTATION_ROLE`
 * (`checker`) never held `pause`/`resume` and could not have caught this. Snapshots and restores
 * `tenant_admin`'s real permissions itself, the same discipline this file's own header describes
 * for `MUTATION_ROLE`, since `tenant_admin` is a globally shared row several other suites rely on.
 *
 * ### T-072 — why this block re-applies `T047_003` in `beforeAll`
 *
 * Filed after this exact test started failing live: `before.body.data.permissions.campaign` came
 * back as plain `['view']` — `T047_003`'s effect gone — even though `npm run db:status` showed
 * `T047_003` applied. Root-caused (not guessed) by diffing `reward_config.role_entity_permissions`
 * against `reward_portal.portal_audit_log`: no `PUT /admin/access-control/permissions/tenant_admin`
 * audit row ever touched `campaign` for this role, which rules out a stray UI/API write, but the
 * live row's `id`/`created_at`/`updated_at` were all fresh — the signature of a `DELETE` + re-`INSERT`,
 * not an in-place edit. `test/database/t004-seeds-bootstrap.e2e-spec.ts`'s own TC-14 (out of this
 * task's file scope, R9) calls `T004_001`'s exported `up()`/`down()` directly to prove the seed
 * migration's own idempotency and rollback — legitimate for what *that* task owns, but `down()`
 * deletes every `(role, entity)` pair in `T004_001`'s baseline array (which includes
 * `tenant_admin`/`campaign`) and its matching `up()` only knows `T004_001`'s own original values
 * (`['view']`), not `T047_003`'s later in-place `UPDATE` layered on top of that same row. Every time
 * that suite's rollback/reseed cycle runs against this shared dev database, `T047_003`'s effect is
 * silently lost — invisibly to `db:status`, which only tracks whether a migration *ran*, not whether
 * its effect still holds.
 *
 * That is a real defect in `T004_001`/`T047_003`'s interaction, but neither file is in this task's
 * `Files owned` (R9), and re-running the *real* migration is exactly what re-establishes the state
 * `T047_003` itself defines — so this test re-applies it directly (the same "import a migration's
 * exported `up()`/`down()` and call it from a test" pattern `t004-seeds-bootstrap.e2e-spec.ts`
 * already uses for `T004_001` itself) before trusting the row's content, rather than assuming the
 * shared database's ambient state already matches every migration that has ever run against it.
 * This does not weaken what the test proves: `T047_003`'s `up()` is the authoritative
 * definition of what `tenant_admin`'s `campaign` row *should* contain, so asserting against a row
 * this test just confirmed carries that migration's real effect is still "the real, currently-seeded
 * matrix" — just made deterministic instead of hoping nothing else touched it first. See T-072's
 * completion report for the full trace and why the residue itself was left to a defect filed against
 * `T004_001`/`T047_003` rather than "fixed" here by editing files this task does not own.
 */
describe("T-062 — full-replace PUT accepts a role's real, currently-seeded permission matrix", () => {
  const REGRESSION_ROLE: PortalRole = 'tenant_admin';

  beforeAll(async () => {
    // T-072 — re-establish T047_003's effect before this test trusts it. See the block comment
    // above for the full root-cause trace of why this cannot be assumed from ambient DB state.
    await applyCampaignPausePermissions({ context: db });
  });

  it('unchecking one unrelated permission for tenant_admin saves (200), not 400', async () => {
    const before = await get('super', `/admin/access-control/permissions/${REGRESSION_ROLE}`);
    expect(before.status).toBe(200);

    // The real currently-seeded matrix legitimately carries `campaign: [..., 'pause', 'resume']`
    // (T047_003) — proof this test would have caught the actual defect, not just a synthetic one.
    expect(before.body.data.permissions.campaign).toEqual(
      expect.arrayContaining(['pause', 'resume']),
    );

    try {
      // The one, unrelated change a real operator makes: uncheck `merchant:create`. Everything
      // else — including the `pause`/`resume` cells — is resubmitted completely unmodified, the
      // same shape `PermissionsMatrixEditor.save()` sends.
      const merchantActions = (before.body.data.permissions.merchant as string[]).filter(
        (action) => action !== 'create',
      );
      const response = await put('super', `/admin/access-control/permissions/${REGRESSION_ROLE}`, {
        expectedVersion: before.body.data.version,
        permissions: { ...before.body.data.permissions, merchant: merchantActions },
      });

      expect(response.status).toBe(200);
      expect(response.body.data.permissions.merchant).toEqual(merchantActions);
      // Untouched cells — including the ones that previously tripped the catalogue gap — round-trip
      // unchanged.
      expect(response.body.data.permissions.campaign).toEqual(
        before.body.data.permissions.campaign,
      );
    } finally {
      const current = await get('super', `/admin/access-control/permissions/${REGRESSION_ROLE}`);
      if (current.status === 200) {
        await put('super', `/admin/access-control/permissions/${REGRESSION_ROLE}`, {
          expectedVersion: current.body.data.version,
          permissions: before.body.data.permissions,
        });
      }
    }
  });

  it('T-072: surviving the exact residue class that broke this suite — row reset to the T004_001 baseline is repaired before the assertion trusts it', async () => {
    // Reproduces, directly and deterministically, what `t004-seeds-bootstrap.e2e-spec.ts`'s TC-14
    // does to this shared row (see the describe block's doc comment): `DELETE` the seeded
    // `(tenant_admin, campaign)` row, `INSERT` it back with only `T004_001`'s original baseline
    // value. No HTTP call in this test can cause this — it is the same class of foreign residue
    // T-072 root-caused, reproduced here on demand instead of waited for.
    await exec(
      `DELETE FROM reward_config.role_entity_permissions WHERE role = :role AND entity = :entity;`,
      { role: REGRESSION_ROLE, entity: 'campaign' },
    );
    await exec(
      `INSERT INTO reward_config.role_entity_permissions (role, entity, actions)
       VALUES (:role, :entity, :actions);`,
      { role: REGRESSION_ROLE, entity: 'campaign', actions: JSON.stringify(['view']) },
    );

    // Without the fix, this is exactly TC-1's failure: the row has been reset to `['view']` and
    // nothing re-establishes `T047_003`'s effect before the assertion runs.
    await applyCampaignPausePermissions({ context: db });

    const response = await get('super', `/admin/access-control/permissions/${REGRESSION_ROLE}`);
    expect(response.status).toBe(200);
    expect(response.body.data.permissions.campaign).toEqual(
      expect.arrayContaining(['pause', 'resume']),
    );
  });
});

describe('T-033 — POST /admin/access-control/preview — TC-17, verification step 7', () => {
  it('returns the merchant shell and writes nothing', async () => {
    const beforeNav = await get('super', '/admin/access-control/nav/merchant');
    const beforePermissions = await get('super', '/admin/access-control/permissions/merchant');

    const response = await post('super', '/admin/access-control/preview', {
      role: 'merchant',
      nav: [
        {
          navKey: 'dashboard',
          label: 'Dashboard',
          path: '/dashboard',
          sortOrder: 10,
          enabled: true,
        },
      ],
    });
    expect(response.status).toBe(200);
    expect(response.body.data.role).toBe('merchant');
    expect(response.body.data.nav).toEqual([
      expect.objectContaining({ key: 'dashboard', children: [] }),
    ]);

    const afterNav = await get('super', '/admin/access-control/nav/merchant');
    const afterPermissions = await get('super', '/admin/access-control/permissions/merchant');
    expect(afterNav.body.data.version).toBe(beforeNav.body.data.version);
    expect(afterNav.body.data.items).toEqual(beforeNav.body.data.items);
    expect(afterPermissions.body.data).toEqual(beforePermissions.body.data);
  });

  it("previews checker's current, committed config when no draft is supplied", async () => {
    const response = await post('super', '/admin/access-control/preview', { role: 'checker' });
    expect(response.status).toBe(200);
    expect(response.body.data.permissions).toHaveProperty('approval');
  });
});

describe('T-033 — optimistic concurrency (TC-22)', () => {
  it('a stale expectedVersion → 409, not a silent overwrite', async () => {
    const before = await get('super', `/admin/access-control/widgets/${MUTATION_ROLE}`);
    try {
      const first = await put('super', `/admin/access-control/widgets/${MUTATION_ROLE}`, {
        expectedVersion: before.body.data.version,
        items: before.body.data.items,
      });
      expect(first.status).toBe(200);

      // Retrying with the now-stale version the caller originally read.
      const second = await put('super', `/admin/access-control/widgets/${MUTATION_ROLE}`, {
        expectedVersion: before.body.data.version,
        items: before.body.data.items,
      });
      expect(second.status).toBe(409);
      expectErrorEnvelope(second.body, 'ACCESS_CONTROL_VERSION_CONFLICT');
    } finally {
      await restoreWidgets();
    }
  });
});

describe('T-033 — changing another role does not affect the acting super_admin (TC-21)', () => {
  it("super_admin's own session stays valid after editing checker", async () => {
    const own = await get('super', '/me/bootstrap');
    expect(own.status).toBe(200);

    const before = await get('super', `/admin/access-control/widgets/${MUTATION_ROLE}`);
    try {
      const response = await put('super', `/admin/access-control/widgets/${MUTATION_ROLE}`, {
        expectedVersion: before.body.data.version,
        items: before.body.data.items,
      });
      expect(response.status).toBe(200);

      const ownAfter = await get('super', '/me/bootstrap');
      expect(ownAfter.status).toBe(200);
      expect(ownAfter.body.data.user.role).toBe('super_admin');
    } finally {
      await restoreWidgets();
    }
  });
});
