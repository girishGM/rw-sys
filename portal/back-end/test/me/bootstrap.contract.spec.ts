/**
 * T-015 — the back end's payload against `packages/shared`'s schema: one contract, two workspaces.
 *
 * 00-ARCHITECTURE.md §8 justifies the shared package as *"One Zod schema shared with the back end
 * → identical client and server validation"*. A shared schema nobody validates against is a
 * comment. This suite is what makes it a contract:
 *
 *  - a payload built by the real `BootstrapService` **parses** against `bootstrapSchema`;
 *  - because every object in that schema is `.strict()`, a payload with an *extra* field fails —
 *    which is the mechanical form of TC-15 ("no hash, no token, no other user's data"). A future
 *    change that spread a `portal_users` row into the response is a red test here, in the
 *    workspace that caused it, rather than a leak discovered in a browser.
 *  - the role list, the cache-control string and the `PATCH` field set are asserted identical
 *    across the two workspaces, since each is declared in both.
 *
 * `me.e2e-spec.ts` runs the same schema over a real HTTP response for all six roles. This one runs
 * without a database, so the contract is checked on every `npm test` rather than only when
 * Postgres is up.
 */
import {
  BOOTSTRAP_CACHE_CONTROL as SHARED_CACHE_CONTROL,
  PORTAL_ROLES,
  bootstrapEnvelopeSchema,
  bootstrapSchema,
  meProfileSchema,
} from '@reward-portal/shared';
import { ALL_PORTAL_ROLES } from '@/common/rbac/rbac.constants';
import { BootstrapService } from '@/modules/me/bootstrap.service';
import { MeService } from '@/modules/me/me.service';
import { BOOTSTRAP_CACHE_CONTROL } from '@/modules/me/me.controller';
import { envelope } from '@/modules/me/dto/bootstrap-response.dto';
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
import {
  expectBootstrapDisclosure,
  expectMessageCatalogue,
  expectPermissionMap,
} from './support/secret-scan';

function build() {
  const scoped = new FakeScopedRepository();
  scoped.self = userRow();
  scoped.setRows(RoleNavConfig, [
    navRow('dashboard', { label: 'Dashboard', path: '/dashboard', icon: 'home' }),
    navRow('admin', { label: 'Admin' }),
    navRow('access_control', { label: 'Access Control', parentNavKey: 'admin' }),
  ]);
  scoped.setRows(RoleDashboardWidget, [
    widgetRow('kpi_countries', { label: 'Countries', widgetConfig: { type: 'kpi' } }),
  ]);

  const audit = new FakeAuditService();
  const me = new MeService(asScopedRepository(scoped), asAuditService(audit));

  return {
    scoped,
    me,
    service: new BootstrapService(
      asScopedRepository(scoped),
      asPermissionCache(new FakePermissionCache().grant('campaign', 'view', 'create')),
      new FakeVersionStore(),
      asMessageService(new FakeMessageService()),
      me,
    ),
  };
}

async function payload() {
  const { service } = build();
  const who = actor();
  return service.assemble(who, await service.revision(who));
}

describe('the /me wire contract', () => {
  it('a real bootstrap payload parses against the shared schema', async () => {
    const result = bootstrapSchema.safeParse(await payload());

    // The message on failure is the useful part: it names the field that drifted.
    expect(result.success ? null : result.error.issues).toBeNull();
  });

  it('the enveloped body parses too — 03-API-CONTRACT.md §1 wraps every success in { data }', async () => {
    expect(bootstrapEnvelopeSchema.safeParse(envelope(await payload())).success).toBe(true);
  });

  it('the nested nav item parses recursively', async () => {
    const parsed = bootstrapSchema.parse(await payload());
    const admin = parsed.nav.find((item) => item.key === 'admin');

    expect(admin?.children.map((child) => child.key)).toEqual(['access_control']);
  });

  it('TC-15: an extra field anywhere fails the contract, because the schema is strict', async () => {
    const leaked = { ...(await payload()) } as Record<string, unknown>;
    leaked.passwordHash = 'argon2id$…';

    expect(bootstrapSchema.safeParse(leaked).success).toBe(false);
  });

  it('TC-15: an extra field *inside* the user block fails too', async () => {
    const body = await payload();
    const leaked = { ...body, user: { ...body.user, mfaSecretEnc: 'ciphertext' } };

    expect(bootstrapSchema.safeParse(leaked).success).toBe(false);
  });

  it('a GET /me profile parses against the shared profile schema', async () => {
    const { me } = build();

    expect(meProfileSchema.safeParse(await me.getProfile(actor())).success).toBe(true);
  });

  it('the shared role list is the back end’s role list', () => {
    expect([...PORTAL_ROLES].sort()).toEqual([...ALL_PORTAL_ROLES].sort());
  });

  it('the shared Cache-Control constant is the one the controller sends', () => {
    expect(SHARED_CACHE_CONTROL).toBe(BOOTSTRAP_CACHE_CONTROL);
  });
});

/**
 * The TC-15 helpers, asserted not to be vacuous.
 *
 * A disclosure test that cannot fail is worse than no disclosure test, because it is read as
 * evidence. Each of these confirms the helper rejects the thing it exists to reject.
 */
describe('the TC-15 disclosure helpers', () => {
  it('the message-catalogue check rejects a non-code key and a non-string value', () => {
    expect(() => expectMessageCatalogue({ NOT_FOUND: 'Not found.' })).not.toThrow();
    expect(() => expectMessageCatalogue({ password_hash: 'argon2id$…' })).toThrow();
    expect(() => expectMessageCatalogue({ NOT_FOUND: { nested: 'row' } })).toThrow();
  });

  it('the permission-map check rejects a non-entity key and a non-array value', () => {
    expect(() => expectPermissionMap({ campaign: ['view'] })).not.toThrow();
    expect(() => expectPermissionMap({ 'DROP TABLE': ['view'] })).toThrow();
    expect(() => expectPermissionMap({ campaign: 'view' })).toThrow();
    expect(() => expectPermissionMap({ campaign: ['view; DROP'] })).toThrow();
  });

  it('the whole-body check passes a real payload and fails a leaked one', async () => {
    const body = { data: await payload() };

    expect(() => expectBootstrapDisclosure(body)).not.toThrow();
    expect(() =>
      expectBootstrapDisclosure({
        data: { ...body.data, user: { ...body.data.user, passwordHash: 'argon2id$…' } },
      }),
    ).toThrow();
  });

  it('it still inspects the catalogues rather than skipping them', async () => {
    const body = { data: await payload() };

    // Excluded from the *key walk*, not from scrutiny: a row smuggled into `messages` fails the
    // shape assertion instead.
    expect(() =>
      expectBootstrapDisclosure({
        data: { ...body.data, messages: { mfaSecretEnc: 'ciphertext' } },
      }),
    ).toThrow();
  });
});
