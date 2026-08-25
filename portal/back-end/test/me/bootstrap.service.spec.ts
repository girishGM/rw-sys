/**
 * T-015 — `BootstrapService`: what it asks the database for, and what it assembles from the answer.
 *
 * The e2e suite proves the payload is right for all six roles against the real seed. This one
 * proves the properties an e2e cannot isolate:
 *
 *  - the nav and widget queries are filtered on **the actor's own role** and on `enabled = true`,
 *    and ordered by `sort_order` — a query that dropped the `role` predicate would still pass an
 *    e2e run in which only one role's rows exist;
 *  - `rbac_version` is read **live on every request**, never taken from the JWT (TC-13);
 *  - phase one does no nav, widget or permission work at all, which is what makes a 304 cheap;
 *  - the scope block is the token's, not the row's (AGENT-PROTOCOL R3).
 */
import { BootstrapService } from '@/modules/me/bootstrap.service';
import { MeService } from '@/modules/me/me.service';
import { ScopeViolationError } from '@/common/scope/scope.exceptions';
import {
  FakeAuditService,
  FakeMessageService,
  FakePermissionCache,
  FakeScopedRepository,
  FakeVersionStore,
  RoleDashboardWidget,
  RoleNavConfig,
  actor,
  asAuditService,
  asMessageService,
  asPermissionCache,
  asScopedRepository,
  navRow,
  userRow,
  widgetRow,
} from './support/me-doubles';

describe('BootstrapService', () => {
  let scoped: FakeScopedRepository;
  let permissions: FakePermissionCache;
  let versions: FakeVersionStore;
  let messages: FakeMessageService;
  let service: BootstrapService;

  beforeEach(() => {
    scoped = new FakeScopedRepository();
    scoped.self = userRow();
    permissions = new FakePermissionCache().grant('campaign', 'view', 'create');
    versions = new FakeVersionStore();
    messages = new FakeMessageService();

    const me = new MeService(asScopedRepository(scoped), asAuditService(new FakeAuditService()));
    service = new BootstrapService(
      asScopedRepository(scoped),
      asPermissionCache(permissions),
      versions,
      asMessageService(messages),
      me,
    );
  });

  // --- phase one ------------------------------------------------------------------------------

  describe('revision', () => {
    it('builds the ETag from the live rbac_version, not the token’s claim (TC-13)', async () => {
      versions.setVersion('maker', 9);

      const revision = await service.revision(actor({ rbacVersion: 1 }));

      // The token says 1; the row says 9. If the claim were used, a Super Admin's permission
      // change would keep being 304'd for the fifteen-minute life of every outstanding token.
      expect(revision.etag).toContain('-9-');
      expect(versions.versionReads).toBe(1);
    });

    it('reads nothing but the user row and the version — a 304 must be cheap', async () => {
      await service.revision(actor());

      expect(scoped.callsTo('listAll')).toHaveLength(0);
      expect(permissions.reads).toBe(0);
      expect(scoped.callsTo('findByPkOrFail')).toHaveLength(1);
    });

    it('reports the token’s role and the row’s profile fields', async () => {
      scoped.self = userRow({
        displayName: 'Renamed',
        preferredLocale: 'fr',
        preferredTimezone: null,
      });

      const revision = await service.revision(actor({ role: 'checker' }));

      expect(revision.user).toEqual({
        id: 12,
        displayName: 'Renamed',
        role: 'checker',
        locale: 'fr',
        timezone: null,
      });
    });

    it('substitutes the default locale when the column is null', async () => {
      scoped.self = userRow({ preferredLocale: null });

      await expect(service.revision(actor())).resolves.toMatchObject({
        user: expect.objectContaining({ locale: 'en' }),
      });
    });

    it('404s when the caller’s own row has vanished', async () => {
      scoped.self = null;

      const thrown: unknown = await service.revision(actor()).catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(ScopeViolationError);
      expect((thrown as ScopeViolationError).getStatus()).toBe(404);
    });
  });

  // --- phase two ------------------------------------------------------------------------------

  describe('assemble', () => {
    async function assembleFor(role: Parameters<typeof actor>[0] = {}) {
      const who = actor(role);
      return { who, body: await service.assemble(who, await service.revision(who)) };
    }

    it('queries role_nav_configs for the actor’s role, enabled only, ordered by sort_order', async () => {
      await assembleFor({ role: 'country_admin' });

      const call = scoped.callsTo('listAll').find((entry) => entry.model === RoleNavConfig.name);

      expect(call?.options).toEqual({
        where: { role: 'country_admin', enabled: true },
        order: [
          ['sortOrder', 'ASC'],
          ['navKey', 'ASC'],
        ],
      });
    });

    it('queries role_dashboard_widgets the same way', async () => {
      await assembleFor({ role: 'merchant' });

      const call = scoped
        .callsTo('listAll')
        .find((entry) => entry.model === RoleDashboardWidget.name);

      expect(call?.options).toEqual({
        where: { role: 'merchant', enabled: true },
        order: [
          ['sortOrder', 'ASC'],
          ['widgetKey', 'ASC'],
        ],
      });
    });

    it('goes through ScopedRepository for both tables (AGENT-PROTOCOL R2)', async () => {
      await assembleFor();

      expect(
        scoped
          .callsTo('listAll')
          .map((call) => call.model)
          .sort(),
      ).toEqual([RoleDashboardWidget.name, RoleNavConfig.name].sort());
    });

    it('returns the §7 shape and nothing else', async () => {
      const { body } = await assembleFor();

      expect(Object.keys(body).sort()).toEqual([
        'messages',
        'nav',
        'permissions',
        'scope',
        'user',
        'widgets',
      ]);
    });

    it('reports the scope from the verified token, not from the row (R3)', async () => {
      const { body } = await assembleFor({ countryId: 5, tenantId: 11, merchantId: 2 });

      expect(body.scope).toEqual({ countryId: 5, tenantId: 11, merchantId: 2 });
    });

    it('reports a super_admin’s three null scope values as null, not as absent', async () => {
      const { body } = await assembleFor({
        role: 'super_admin',
        countryId: null,
        tenantId: null,
        merchantId: null,
      });

      expect(body.scope).toEqual({ countryId: null, tenantId: null, merchantId: null });
    });

    it('nests the nav rows and drops orphans', async () => {
      scoped.setRows(RoleNavConfig, [
        navRow('dashboard'),
        navRow('admin'),
        navRow('access_control', { parentNavKey: 'admin' }),
        navRow('stray', { parentNavKey: 'disabled_parent' }),
      ]);

      const { body } = await assembleFor();

      expect(body.nav.map((item) => item.key)).toEqual(['dashboard', 'admin']);
      expect(JSON.stringify(body.nav)).not.toContain('stray');
    });

    it('maps widgets to key/label/config and normalises a malformed config to {} (TC-11)', async () => {
      scoped.setRows(RoleDashboardWidget, [
        widgetRow('kpi_countries', { label: 'Countries', widgetConfig: { type: 'kpi' } }),
        widgetRow('broken', { widgetConfig: 'not-an-object' }),
      ]);

      const { body } = await assembleFor();

      expect(body.widgets).toEqual([
        { key: 'kpi_countries', label: 'Countries', config: { type: 'kpi' } },
        { key: 'broken', label: 'broken', config: {} },
      ]);
    });

    it('serves the permission matrix from the cache, flattened', async () => {
      const { body } = await assembleFor();

      expect(body.permissions).toEqual({ campaign: ['view', 'create'] });
      expect(permissions.reads).toBe(1);
    });

    it('ships the whole message catalogue', async () => {
      messages.catalogue = { NOT_FOUND: 'Not found.', PERM_DENIED: 'Denied.' };

      const { body } = await assembleFor();

      expect(body.messages).toEqual({ NOT_FOUND: 'Not found.', PERM_DENIED: 'Denied.' });
    });

    it('reuses phase one’s user block rather than re-reading the row', async () => {
      const who = actor();
      const revision = await service.revision(who);
      scoped.calls.length = 0;

      const body = await service.assemble(who, revision);

      expect(body.user).toBe(revision.user);
      expect(scoped.callsTo('findByPkOrFail')).toHaveLength(0);
    });

    it('returns empty collections for a role with no rows, rather than failing', async () => {
      const { body } = await assembleFor({ role: 'merchant' });

      expect(body.nav).toEqual([]);
      expect(body.widgets).toEqual([]);
    });
  });

  // --- TC-20 ------------------------------------------------------------------------------------

  describe('TC-20 — two roles concurrently', () => {
    it('gives each actor its own role’s query, with no bleed', async () => {
      const maker = actor({ role: 'maker', userId: 12 });
      const checker = actor({ role: 'checker', userId: 13 });

      const [makerBody, checkerBody] = await Promise.all([
        service.revision(maker).then((revision) => service.assemble(maker, revision)),
        service.revision(checker).then((revision) => service.assemble(checker, revision)),
      ]);

      expect(makerBody.user.role).toBe('maker');
      expect(checkerBody.user.role).toBe('checker');

      const roles = scoped
        .callsTo('listAll')
        .map((call) => (call.options as { where: { role: string } }).where.role);

      expect(roles.filter((role) => role === 'maker')).toHaveLength(2);
      expect(roles.filter((role) => role === 'checker')).toHaveLength(2);
    });
  });
});
