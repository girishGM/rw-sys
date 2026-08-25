/**
 * T-003 regression suite — `DatabaseModule` / model layer. Runs against a real Postgres
 * instance (this dev machine has no working Docker daemon — same convention as every prior
 * `test/database/*.e2e-spec.ts`). Two connections are used deliberately:
 *  - `app` — the **only** Sequelize instance with T-003's models registered in this file,
 *    connected as `reward_app` (least privilege, same role the real app uses), built by
 *    `build-app-sequelize.ts`. Every assertion under test runs through this connection,
 *    proving the models work under the grants the app actually has. (Deliberately not
 *    constructed twice: `sequelize-typescript`'s `@Table`-decorated classes are singletons
 *    bound to whichever `Sequelize` instance last called `models: [...]`/`addModels` on
 *    them — building a second instance mid-suite would silently rebind every model out
 *    from under the earlier tests.) SQL logging is captured into `capturedLogLines` for
 *    the whole suite so TC-10 can assert over it without a second connection.
 *  - `migration` — the privileged role, used **only** for fixture setup/teardown that
 *    `reward_app` cannot do itself (hard `DELETE`; `reward_app` has none anywhere —
 *    01-DATABASE.md §3, "the portal soft-deletes"). Never used for an assertion.
 *
 * Fixture rows are inserted with raw parameterised SQL through `app`, not `Model.create()` —
 * the same convention `src/common/caps/legacy-budget-sync.ts` (T-006) already established
 * and documents: every model here extends `Model<Self>` with a single generic argument
 * (matching `campaign-cap.model.ts`'s own pattern), which makes Sequelize's core
 * `.create()`/`.build()` typings demand the *entire* model-instance shape — including
 * inherited methods like `destroy`/`restore` — as "required" input properties. Reads
 * (`findAll`/`findOne`/`findByPk`) and instance methods (`.destroy()`) on an
 * already-typed found instance are unaffected and used normally throughout.
 *
 * Fixtures reuse the existing `countries`/`tenants` seed row (id 1 for both, confirmed live)
 * rather than inserting new ones, same convention T-006's suite documents. All portal-side
 * fixture rows are tagged `t003test` and hard-deleted in `afterAll`.
 */
import 'reflect-metadata';
import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { createMigrationConnection } from '@/database/migration-connection';
import { buildAppSequelize } from './build-app-sequelize';
import { PortalUser } from '@/database/portal-models/portal-user.model';
import { PortalUserCredential } from '@/database/portal-models/portal-user-credential.model';
import { Tenant } from '@/database/models/tenant.model';
import { RuleMaster } from '@/database/models/rule-master.model';
import { RoleEntityPermission } from '@/database/models/role-entity-permission.model';

describe('T-003 — DatabaseModule / Sequelize models', () => {
  let app: Sequelize;
  let migration: Sequelize;
  const capturedLogLines: string[] = [];

  const portalUserIds: number[] = [];
  const tenantIds: number[] = [];
  const ruleMasterIds: number[] = [];
  const roleEntityPermissionIds: number[] = [];

  async function insertPortalUser(overrides: {
    email: string;
    mfaSecretEnc?: string;
  }): Promise<number> {
    const [row] = await app.query<{ id: number }>(
      `INSERT INTO reward_portal.portal_users
         (email, display_name, role, country_id, tenant_id, mfa_secret_enc)
       VALUES (:email, 'T003 Fixture', 'maker', 1, 1, :mfaSecretEnc)
       RETURNING id`,
      {
        replacements: { email: overrides.email, mfaSecretEnc: overrides.mfaSecretEnc ?? null },
        type: QueryTypes.SELECT,
      },
    );
    portalUserIds.push(row.id);
    return row.id;
  }

  beforeAll(async () => {
    app = buildAppSequelize({ captureLogLines: capturedLogLines });
    await app.authenticate();
    migration = createMigrationConnection();
    await migration.authenticate();
  });

  afterAll(async () => {
    // reward_app has no DELETE anywhere (01-DATABASE.md §3) — all hard cleanup goes
    // through the privileged connection.
    if (portalUserIds.length) {
      await migration.query(
        `DELETE FROM reward_portal.portal_user_credentials WHERE user_id IN (:ids)`,
        { replacements: { ids: portalUserIds }, type: QueryTypes.RAW },
      );
      await migration.query(`DELETE FROM reward_portal.portal_users WHERE id IN (:ids)`, {
        replacements: { ids: portalUserIds },
        type: QueryTypes.RAW,
      });
    }
    if (tenantIds.length) {
      await migration.query(`DELETE FROM reward_config.tenants WHERE id IN (:ids)`, {
        replacements: { ids: tenantIds },
        type: QueryTypes.RAW,
      });
    }
    if (ruleMasterIds.length) {
      await migration.query(`DELETE FROM reward_config.rule_master WHERE id IN (:ids)`, {
        replacements: { ids: ruleMasterIds },
        type: QueryTypes.RAW,
      });
    }
    if (roleEntityPermissionIds.length) {
      await migration.query(
        `DELETE FROM reward_config.role_entity_permissions WHERE id IN (:ids)`,
        { replacements: { ids: roleEntityPermissionIds }, type: QueryTypes.RAW },
      );
    }
    await app.close();
    await migration.close();
  });

  it('TC-1: DatabaseModule boots and authenticates, pool sized 20/2', async () => {
    await expect(app.authenticate()).resolves.toBeUndefined();
    const pool = app.options.pool;
    expect(pool?.max).toBe(20);
    expect(pool?.min).toBe(2);
  });

  it('TC-3: a valid maker-scoped row inserts and PortalUser.findByPk() returns it', async () => {
    const id = await insertPortalUser({ email: `t003test-maker-${Date.now()}@example.com` });
    const found = await PortalUser.findByPk(id);
    expect(found?.id).toBe(id);
    expect(found?.role).toBe('maker');
  });

  it('TC-4: PortalUser.findAll() default scope never returns mfa_secret_enc', async () => {
    const id = await insertPortalUser({
      email: `t003test-scope-${Date.now()}@example.com`,
      mfaSecretEnc: 'super-secret-ciphertext',
    });

    const [found] = await PortalUser.findAll({ where: { id } });
    const plain = found.get({ plain: true }) as unknown as Record<string, unknown>;
    expect(plain).not.toHaveProperty('mfaSecretEnc');
  });

  it('TC-5 / TC-6: PortalUserCredential default scope hides password_hash; .unscoped() reveals it', async () => {
    const userId = await insertPortalUser({ email: `t003test-cred-${Date.now()}@example.com` });
    const rawHash = '$argon2id$v=19$m=19456,t=2,p=1$notarealhash';
    await app.query(
      `INSERT INTO reward_portal.portal_user_credentials (user_id, password_hash, password_updated_at)
       VALUES (:userId, :rawHash, now())`,
      { replacements: { userId, rawHash }, type: QueryTypes.RAW },
    );

    const scoped = await PortalUserCredential.findOne({ where: { userId } });
    expect(scoped?.get({ plain: true })).not.toHaveProperty('passwordHash');

    const unscoped = await PortalUserCredential.unscoped().findOne({ where: { userId } });
    expect(unscoped?.passwordHash).toBe(rawHash);
  });

  it('TC-7: soft-deleting a Tenant excludes it from findAll() (paranoid works)', async () => {
    const [row] = await app.query<{ id: number }>(
      `INSERT INTO reward_config.tenants (code, name, country_id)
       VALUES (:code, 'T003 Test Tenant', 1)
       RETURNING id`,
      { replacements: { code: `t003${Date.now() % 1_000_000}` }, type: QueryTypes.SELECT },
    );
    tenantIds.push(row.id);

    const tenant = await Tenant.findByPk(row.id);
    await tenant?.destroy();

    const found = await Tenant.findAll({ where: { id: row.id } });
    expect(found).toHaveLength(0);

    const withDeleted = await Tenant.findByPk(row.id, { paranoid: false });
    expect(withDeleted?.deletedAt).not.toBeNull();
  });

  it('TC-8: a rule_master row with malformed parameters JSON returns {} from the getter, never throws', async () => {
    const [row] = await app.query<{ id: number }>(
      `INSERT INTO reward_config.rule_master (tenant_id, sub_category_id, rule_code, name, parameters, status)
       VALUES (1, 13, :ruleCode, 'T003 Malformed Parameters', '{not valid json', 'active')
       RETURNING id`,
      { replacements: { ruleCode: `t003test_${Date.now()}` }, type: QueryTypes.SELECT },
    );
    ruleMasterIds.push(row.id);

    const found = await RuleMaster.findByPk(row.id);
    expect(() => found?.parameters).not.toThrow();
    expect(found?.parameters).toEqual({});
  });

  it('TC-9: role_entity_permissions.actions round-trips as a string[]', async () => {
    const [row] = await app.query<{ id: number }>(
      `INSERT INTO reward_config.role_entity_permissions (role, entity, actions)
       VALUES ('maker', :entity, '["view","create","update"]')
       RETURNING id`,
      { replacements: { entity: `t003test_entity_${Date.now()}` }, type: QueryTypes.SELECT },
    );
    roleEntityPermissionIds.push(row.id);

    const found = await RoleEntityPermission.findByPk(row.id);
    expect(Array.isArray(found?.actions)).toBe(true);
    expect(found?.actions).toEqual(['view', 'create', 'update']);
  });

  it('TC-10: SQL logging never contains a password hash for a credential query', async () => {
    const userId = await insertPortalUser({ email: `t003test-logging-${Date.now()}@example.com` });
    const rawHash = '$argon2id$v=19$m=19456,t=2,p=1$loggingtesthash';
    await app.query(
      `INSERT INTO reward_portal.portal_user_credentials (user_id, password_hash, password_updated_at)
       VALUES (:userId, :rawHash, now())`,
      { replacements: { userId, rawHash }, type: QueryTypes.RAW },
    );
    await PortalUserCredential.unscoped().findOne({ where: { userId } });

    expect(capturedLogLines.length).toBeGreaterThan(0);
    for (const line of capturedLogLines) {
      expect(line).not.toContain(rawHash);
    }
  });

  it('TC-11: PortalUser → Tenant is a working cross-schema association', async () => {
    const id = await insertPortalUser({ email: `t003test-assoc-${Date.now()}@example.com` });

    const withTenant = await PortalUser.findByPk(id, { include: [Tenant] });
    expect(withTenant?.tenant).toBeDefined();
    expect(withTenant?.tenant?.id).toBe(1);
  });
});
