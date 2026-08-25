/**
 * T-056 TC-1 / TC-6 — the bootstrap CLI writes an encrypted Super Admin, and that Super Admin can
 * then log in.
 *
 * This is the end-to-end proof that the two halves of T-056 agree with each other. They are written
 * by different code, in different processes, and could each be self-consistently wrong:
 *
 *  - `bootstrap-superadmin.ts` runs standalone with no Nest container, builds its own
 *    `KeyRegistryService`, and writes ciphertext plus a blind index with raw SQL.
 *  - `CredentialRepository` runs inside the application, gets its crypto from DI, and finds the
 *    account by recomputing that blind index from what the user typed.
 *
 * If the two disagree about normalisation, about the AAD, or about which key ring to use, the
 * account is created successfully and then simply cannot log in — with no error at write time and a
 * plain "invalid credentials" at read time. That failure is invisible to any test that exercises
 * only one side, which is why this file exercises both against the real database.
 *
 * `bootstrapSuperAdmin()` is called as a function rather than by spawning `npm run
 * bootstrap:superadmin`, exactly as `t004-seeds-bootstrap.e2e-spec.ts` documents: the module is
 * deliberately split so the work is testable without a TTY or a child process. The CLI wrapper
 * around it adds only prompting and exit codes.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { SEQUELIZE } from '@/database/sequelize.provider';
import { looksLikeCiphertext } from '@/common/crypto';
import { bootstrapSuperAdmin } from '@/cli/bootstrap-superadmin';
import { PortalUserEmailCrypto } from '@/common/data-protection/portal-user-email.crypto';
import {
  ensureEncryptionKeys,
  insertPortalUser,
  removeEncryptionKeys,
} from './support/portal-user-fixture';

jest.setTimeout(300_000);

const T056_SUITE = 't056boot';
const DISPLAY_NAME = 'T-056 bootstrap probe';

/** Mixed case on purpose: TC-6 asks that login work with *that exact email*, and TC-4 with others. */
const EMAIL = 'T056.Bootstrap@Example.invalid';
const PASSWORD = 'Tr0ub4dor&9xample!';

let app: INestApplication;
let db: Sequelize;
let emailCrypto: PortalUserEmailCrypto;

/** Removes only what this suite creates — identified by its display name, which is not encrypted. */
async function removeProbeUsers(): Promise<void> {
  await db.query(`DELETE FROM reward_portal.portal_users WHERE display_name = :displayName`, {
    type: QueryTypes.DELETE,
    replacements: { displayName: DISPLAY_NAME },
  });
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

  // Both keys, before `app.init()` — and before `bootstrapSuperAdmin`, which resolves them too.
  await ensureEncryptionKeys(moduleRef.get<Sequelize>(SEQUELIZE), T056_SUITE);

  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  // T-085: `app.init()` alone never binds a TCP listener, so `request(app.getHttpServer())` below
  // made supertest call `server.listen(0)`/`server.close()` itself, once per request — see
  // `test/e2e-infra/bound-http-server.e2e-spec.ts` for the reproduction. `listen(0)` binds once,
  // here, before any request runs, and already calls `init()` internally.
  await app.listen(0);

  db = app.get<Sequelize>(SEQUELIZE);
  emailCrypto = app.get(PortalUserEmailCrypto);

  await removeProbeUsers();
});

afterAll(async () => {
  if (db !== undefined) {
    await removeProbeUsers();
    await removeEncryptionKeys(db, T056_SUITE);
  }
  if (app !== undefined) await app.close();
});

describe('TC-6 — bootstrap:superadmin, then log in as that Super Admin', () => {
  it('creates an encrypted, blind-indexed Super Admin that can then authenticate', async () => {
    // The command refuses outright if a super_admin already exists (rule 1), so this suite is only
    // meaningful on a database that has none. Asserted rather than assumed: a silent skip here
    // would let TC-6 quietly stop being tested.
    const [{ count }] = await db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM reward_portal.portal_users
        WHERE role = 'super_admin' AND deleted_at IS NULL`,
      { type: QueryTypes.SELECT },
    );
    expect(count).toBe(0);

    const { userId } = await bootstrapSuperAdmin(db, {
      email: EMAIL,
      displayName: DISPLAY_NAME,
      password: PASSWORD,
    });

    // --- TC-1: what a raw SELECT sees -------------------------------------------------------
    const [row] = await db.query<{ email: string; email_bidx: string; role: string }>(
      `SELECT email, email_bidx, role FROM reward_portal.portal_users WHERE id = :id`,
      { type: QueryTypes.SELECT, replacements: { id: userId } },
    );

    expect(row.role).toBe('super_admin');
    expect(looksLikeCiphertext(row.email)).toBe(true);
    expect(row.email).not.toContain('T056.Bootstrap');
    expect(row.email).not.toContain('Example.invalid');

    // The blind index is present — without it the account exists and can never be found — and is
    // the index of the *normalised* address, so the stored casing is irrelevant to the lookup.
    expect(row.email_bidx).toMatch(/^[0-9a-f]{64}$/);
    expect(row.email_bidx).toBe(emailCrypto.blindIndexFor(EMAIL));
    expect(row.email_bidx).toBe(emailCrypto.blindIndexFor(EMAIL.toLowerCase()));

    // The ciphertext is bound to this row's id and recovers the address exactly as entered,
    // preserving the casing the operator typed.
    expect(emailCrypto.decryptForRow(userId, row.email)).toBe(EMAIL);

    // --- TC-6: the account actually works ---------------------------------------------------
    // `super_admin` logins end in an MFA challenge rather than a session (T-055), so a 200 with
    // `mfaRequired` is the correct "the credentials were accepted" outcome here. What matters for
    // T-056 is that the account was *found and its password verified* — anything wrong with the
    // blind index would produce a 401 from the same endpoint.
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: EMAIL, password: PASSWORD });

    expect(login.status).toBe(200);
    expect(login.body?.data?.mfaRequired).toBe(true);
  });

  it('TC-4: the same account authenticates through a different casing', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: EMAIL.toUpperCase(), password: PASSWORD });

    expect(login.status).toBe(200);
    expect(login.body?.data?.mfaRequired).toBe(true);
  });

  /**
   * The other half of TC-4's normalisation — surrounding whitespace — never reaches the blind
   * index: `LoginDto`'s `@IsEmail` rejects it as a malformed address first, and has since T-011.
   * Asserted here so the boundary is explicit rather than looking like a T-056 gap. The
   * whitespace-tolerance of the index itself is real and is pinned directly, without the DTO in
   * the way, by `credential.repository.spec.ts`'s TC-2.
   */
  it('rejects a padded address at validation, before the lookup is reached', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: `  ${EMAIL}  `, password: PASSWORD });

    expect(login.status).toBe(400);
  });

  /**
   * TC-7 — `uq_portal_users_email_live` still means what it meant, now that it sits on `email_bidx`
   * instead of `lower(email)`.
   *
   * This property used to be covered by `test/database/portal-schema.e2e-spec.ts` TC-7/TC-8 (T-002),
   * which inserts plaintext rows with raw SQL and no blind index. Those inserts can no longer
   * exercise the constraint — a unique index treats NULLs as distinct, so two indexless rows do not
   * collide — and that file belongs to another task (R9), so the coverage is re-established here
   * against rows written the way the application writes them. Flagged for the architect in the
   * completion report: T-002's own two cases need updating by their owner.
   */
  it('TC-7: rejects a duplicate live address, and releases it again on soft delete', async () => {
    const address = 't056.dup@example.invalid';
    const insert = async (): Promise<number> =>
      insertPortalUser(db, emailCrypto, {
        email: address,
        displayName: DISPLAY_NAME,
        role: 'super_admin',
      });

    const firstId = await insert();

    // A second *live* row with the same address collides on the blind index.
    await expect(insert()).rejects.toMatchObject({
      name: 'SequelizeUniqueConstraintError',
      parent: expect.objectContaining({ constraint: 'uq_portal_users_email_live' }),
    });

    // Case and whitespace normalise to the same index, so this is the same collision — the
    // property the old `lower(email)` index provided, preserved.
    await expect(
      insertPortalUser(db, emailCrypto, {
        email: '  T056.DUP@Example.invalid  ',
        displayName: DISPLAY_NAME,
        role: 'super_admin',
      }),
    ).rejects.toMatchObject({ name: 'SequelizeUniqueConstraintError' });

    // Soft-deleting the first frees the address, because the index is partial on `deleted_at IS
    // NULL` — the T-002 fix of 2026-08-15, still working after the column swap.
    await db.query(`UPDATE reward_portal.portal_users SET deleted_at = now() WHERE id = :id`, {
      type: QueryTypes.UPDATE,
      replacements: { id: firstId },
    });

    await expect(insert()).resolves.toEqual(expect.any(Number));
  });

  it('TC-5: an address with no account is refused, and says nothing more than that', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: 't056.nobody@example.invalid', password: PASSWORD });

    expect(login.status).toBe(401);
    // The same answer a real account with a wrong password gets — no hint that the address is
    // unknown. (The identical-shape guarantee itself is pinned in `credential.repository.spec.ts`.)
    const wrongPassword = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: EMAIL, password: 'Wr0ng&Password!x' });

    expect(wrongPassword.status).toBe(401);
    expect(login.body?.error?.code).toBe(wrongPassword.body?.error?.code);
  });
});
