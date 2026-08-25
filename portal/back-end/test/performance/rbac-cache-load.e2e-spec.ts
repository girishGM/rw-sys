/**
 * T-053 — the RBAC permission cache (T-013's `PermissionCacheService`) under load, across two
 * independent instances sharing the same Postgres, and with a store failure injected.
 *
 * Covers:
 *  - TC-9  (cache hit rate under load > 95%)
 *  - TC-10 (a version bump propagates to every instance's next check, under concurrency)
 *  - TC-11 (a cache/store failure denies the request, not allows it)
 *
 * T-013's own `permission-cache.service.spec.ts` already proves the fail-closed *decision* at
 * 100% coverage with a fake store (`rejects.toThrow`). What it cannot prove — because it never
 * boots a guard or an HTTP server — is that the decision actually reaches the wire as a denial
 * rather than an unhandled 500 or, worse, a fallback allow. TC-11 below does that: it makes the
 * **real** `PermissionCacheService` instance the **real**, already-running `PermissionsGuard`
 * depends on throw once, and asserts the HTTP response.
 *
 * "Two instances" for TC-10 is two separately-compiled Nest module refs sharing the one Postgres
 * connection string — `RbacModule` alone (not the whole `AppModule`) is enough, since the property
 * under test is entirely inside `PermissionCacheService`/`PermissionRepository`, and a second
 * lightweight module ref is materially cheaper than a second full HTTP-listening app. That mirrors
 * a real multi-instance deployment more honestly than reusing one process's own cache twice would:
 * two `PermissionCacheService` objects with no shared in-memory state, exactly as two pods behind a
 * load balancer would have.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { Sequelize } from 'sequelize-typescript';
import { AppModule } from '@/app.module';
import { SEQUELIZE } from '@/database/sequelize.provider';
import { RbacModule } from '@/common/rbac/rbac.module';
import { PermissionCacheService } from '@/common/rbac/permission-cache.service';
import { PERMISSION_STORE, type PermissionStore } from '@/common/rbac/permission.repository';
import { validationExceptionFactory } from '@/common/errors/validation.exception-factory';
import type { PortalUserEmailCrypto } from '@/common/data-protection/portal-user-email.crypto';
import * as argon2 from 'argon2';
import { QueryTypes } from 'sequelize';
import { ARGON2_OPTIONS } from '@/modules/auth/auth.constants';
import {
  deletePortalUsersByEmail,
  emailCryptoOf,
  ensureEncryptionKeys,
  insertPortalUser,
  removeEncryptionKeys,
} from '../auth/support/portal-user-fixture';
import { loginCompletingMfa } from '../auth/support/super-admin-mfa';
import {
  clearProvidedKeyMaterial,
  provideMissingKeyMaterial,
} from '../campaigns/support/foreign-key-material';
import { ensureCountry, ensureTenant } from './support/perf-fixtures';

jest.setTimeout(300_000);

const SUITE = 't053rbac';
const PREFIX = 'T053RBAC';
const PASSWORD = 'correct horse battery staple 7!';

let app: INestApplication;
let secondary: TestingModule;
let db: Sequelize;
let emailCrypto: PortalUserEmailCrypto;
let borrowedKeyVars: string[] = [];

let checkerEmail: string;
let checkerJar: string;

function http() {
  return request(app.getHttpServer());
}

function jarFrom(response: request.Response): string {
  const cookies = response.headers['set-cookie'];
  const entries = Array.isArray(cookies) ? cookies : cookies === undefined ? [] : [cookies];
  return entries
    .map((entry) => entry.split(';')[0])
    .filter((pair) => !pair.endsWith('='))
    .join('; ');
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  await ensureEncryptionKeys(moduleRef.get<Sequelize>(SEQUELIZE), SUITE);
  borrowedKeyVars = await provideMissingKeyMaterial(moduleRef.get<Sequelize>(SEQUELIZE));

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

  // A second, independent module ref — a different `PermissionCacheService` instance with its
  // own empty in-memory map, sharing only the database. Simulates a second application instance
  // behind a load balancer (TC-10).
  secondary = await Test.createTestingModule({ imports: [RbacModule] }).compile();

  const countryId = await ensureCountry(db, 'RB', 'T-053 rbac perf country');
  const tenantId = await ensureTenant(db, `${PREFIX}_T`, countryId);

  checkerEmail = `${PREFIX.toLowerCase()}-checker@example.invalid`;
  await deletePortalUsersByEmail(db, emailCrypto, [checkerEmail]);
  const checkerId = await insertPortalUser(db, emailCrypto, {
    email: checkerEmail,
    displayName: 'T-053 rbac checker',
    role: 'checker',
    countryId,
    tenantId,
    merchantId: null,
    mustChangePassword: false,
  });
  await db.query(
    `INSERT INTO reward_portal.portal_user_credentials (user_id, password_hash, password_algo)
     VALUES (:userId, :hash, 'argon2id')`,
    {
      type: QueryTypes.INSERT,
      replacements: { userId: checkerId, hash: await argon2.hash(PASSWORD, ARGON2_OPTIONS) },
    },
  );
  const login = await loginCompletingMfa(app, { email: checkerEmail, password: PASSWORD }, db);
  if (login.status !== 200) {
    throw new Error(`checker login failed: ${login.status} ${JSON.stringify(login.body)}`);
  }
  checkerJar = jarFrom(login);
}, 120_000);

afterAll(async () => {
  if (db !== undefined) {
    await deletePortalUsersByEmail(db, emailCrypto, [checkerEmail]);
    await removeEncryptionKeys(db, SUITE);
    clearProvidedKeyMaterial(borrowedKeyVars);
  }
  if (secondary !== undefined) await secondary.close();
  if (app !== undefined) await app.close();
}, 120_000);

describe('T-053 TC-9 — RBAC cache hit rate under load', () => {
  it('serves > 95% of checks from cache without re-reading the permission matrix', async () => {
    const cache = app.get(PermissionCacheService);
    const store = app.get<PermissionStore>(PERMISSION_STORE);
    cache.invalidate('checker');

    // Warm the cache with one *awaited* call before the concurrent burst below. Without this, all
    // 300 concurrent calls start before any of them has populated the map — a classic cache
    // stampede — and every one of them would (correctly) miss. TC-9 asks about the *steady-state*
    // hit rate under load, not about the very first cold request, so the warm-up is the honest
    // baseline: exactly what a long-running process looks like moments after boot.
    await cache.isGranted('checker', 'approval', 'view');

    const findGrantsSpy = jest.spyOn(store, 'findGrantsForRole');
    findGrantsSpy.mockClear();

    const iterations = 300;
    const now = new Date();
    const results = await Promise.all(
      Array.from({ length: iterations }, () => cache.isGranted('checker', 'approval', 'view', now)),
    );

    expect(results.every((granted) => typeof granted === 'boolean')).toBe(true);
    const misses = findGrantsSpy.mock.calls.length;
    const hitRate = 1 - misses / iterations;
    // eslint-disable-next-line no-console -- recorded for docs/PERFORMANCE.md
    console.log(
      `[T-053 TC-9] ${iterations} checks, ${misses} store read(s), hit rate ${(hitRate * 100).toFixed(2)}%`,
    );
    expect(hitRate).toBeGreaterThan(0.95);

    findGrantsSpy.mockRestore();
  });
});

describe('T-053 TC-10 — version bump propagates across instances under concurrent load', () => {
  /**
   * Counting store reads (as TC-9 does) cannot prove *freshness* on its own: a version bump that
   * lands mid-burst still leaves every in-flight concurrent call on the *same* instance racing
   * the same cold miss, so "how many store reads happened" is not deterministic without also
   * controlling for that stampede. The property TC-10 actually asks for — *"all instances see
   * fresh permissions"* — is instead proven the way Access Control really exercises it: revoke a
   * grant, bump the version, and assert every instance's answer **changes**, under concurrent
   * traffic on both instances at once. The row is restored in `finally` no matter what, the same
   * discipline `me.e2e-spec.ts` uses for global seed state (T-013's own `role_entity_permissions`
   * row for `checker`/`approval`, not a fixture this suite owns).
   */
  it('a revoke-and-bump is visible to every instance, under concurrent traffic on both', async () => {
    const primaryCache = app.get(PermissionCacheService);
    const secondaryCache = secondary.get(PermissionCacheService);

    primaryCache.invalidate('checker');
    secondaryCache.invalidate('checker');

    const [before] = await db.query<{ actions: string }>(
      `SELECT actions FROM reward_config.role_entity_permissions
        WHERE role = 'checker' AND entity = 'approval'`,
      { type: QueryTypes.SELECT },
    );
    if (before === undefined) throw new Error('seeded checker/approval permission row not found');
    const originalActions = before.actions;

    // Warm both instances at the *granted* state.
    const primaryBefore = await primaryCache.isGranted('checker', 'approval', 'view');
    const secondaryBefore = await secondaryCache.isGranted('checker', 'approval', 'view');
    expect(primaryBefore).toBe(true);
    expect(secondaryBefore).toBe(true);

    try {
      await db.query(
        `UPDATE reward_config.role_entity_permissions
            SET actions = :actions
          WHERE role = 'checker' AND entity = 'approval'`,
        {
          type: QueryTypes.UPDATE,
          replacements: { actions: JSON.stringify(['approve', 'reject']) },
        },
      );
      await primaryCache.bumpVersion('checker');

      // Concurrent traffic on *both* instances, simultaneously — the scenario TC-10 names
      // explicitly. Every single answer, on both instances, must reflect the revoke: a version
      // mismatch is a miss regardless of how many other checks are racing it.
      const results = await Promise.all([
        ...Array.from({ length: 15 }, () => primaryCache.isGranted('checker', 'approval', 'view')),
        ...Array.from({ length: 15 }, () =>
          secondaryCache.isGranted('checker', 'approval', 'view'),
        ),
      ]);

      // eslint-disable-next-line no-console -- recorded for docs/PERFORMANCE.md
      console.log(
        `[T-053 TC-10] 30 concurrent checks across 2 instances immediately after a revoke+bump: ` +
          `${results.filter((granted) => !granted).length}/30 correctly denied`,
      );
      expect(results.every((granted) => granted === false)).toBe(true);
    } finally {
      await db.query(
        `UPDATE reward_config.role_entity_permissions
            SET actions = :actions
          WHERE role = 'checker' AND entity = 'approval'`,
        { type: QueryTypes.UPDATE, replacements: { actions: originalActions } },
      );
      await primaryCache.bumpVersion('checker');
      primaryCache.invalidate('checker');
      secondaryCache.invalidate('checker');
    }
  });
});

describe('T-053 TC-11 — a cache/store failure denies, not allows', () => {
  it('GET /campaigns 403s when the permission cache throws, through the real guard', async () => {
    const cache = app.get(PermissionCacheService);
    const failure = jest
      .spyOn(cache, 'isGranted')
      .mockRejectedValueOnce(new Error('T-053 injected store failure'));

    const response = await http().get('/api/v1/campaigns').set('Cookie', checkerJar);

    expect(response.status).toBe(403);
    expect(response.body?.error?.code).toBe('PERM_DENIED');

    failure.mockRestore();

    // Sanity check: the same call succeeds once the injected failure is gone, proving the 403
    // above was the injected failure and not some other misconfiguration of the fixture.
    const recovered = await http().get('/api/v1/campaigns').set('Cookie', checkerJar);
    expect(recovered.status).not.toBe(403);
  });
});
