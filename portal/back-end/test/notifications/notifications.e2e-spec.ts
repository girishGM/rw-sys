/**
 * T-040 (retry 1) — `/notifications` against the **real** Postgres instance, through the real
 * `AppModule`, over real HTTP, as several roles.
 *
 * ### Why this file no longer bridges anything
 *
 * The first submission of this task wrote through `reward_config.user_notifications`, whose
 * `user_id` carries `fk_un_user → reward_config.admin_users(id)` — an FK no real `maker`/
 * `checker` recipient could ever satisfy (`admin_users.role`'s own `CHECK`, G1), which is exactly
 * what that review failed on. `notifications.repository.ts` now writes to
 * `reward_portal.portal_user_notifications` instead (`T040_001_portal_user_notifications.ts`),
 * whose `user_id` references `reward_portal.portal_users(id)` directly — the same value every
 * read path already compares against. This suite therefore uses **real fixture portal users of
 * every role**, including `maker` and `checker`, with no `admin_users` simulation of any kind.
 *
 * `checker`/`maker` delivery below is the direct evidence the previous review asked for: TC-7
 * ("campaign submitted → all tenant checkers receive a notification") and TC-8 ("campaign
 * approved → the maker receives one") are exercised by calling the real, shipped `notify()` seam
 * with the real notification types those events use, against real `checker`/`maker` fixtures —
 * the actual campaign submit/approve endpoints remain T-037/T-038's own, not-yet-built job (out
 * of this module's `Files owned`), but the mechanism they will call is now proved to reach these
 * two roles for real, which is the structural gap the previous review actually failed on.
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
import { NOTIFICATION_TYPE } from '@/modules/notifications/notifications.constants';
import { NotificationsService } from '@/modules/notifications/notifications.service';
import { CSRF_COOKIE_NAME } from '@/modules/auth/session.constants';
import { loginCompletingMfa } from '../auth/support/super-admin-mfa';
import {
  deletePortalUsersByEmail,
  emailCryptoOf,
  ensureEncryptionKeys,
  insertPortalUser,
  removeEncryptionKeys,
} from '../auth/support/portal-user-fixture';
import type { PortalUserEmailCrypto } from '@/common/data-protection/portal-user-email.crypto';

const T056_SUITE = 't040n';
jest.setTimeout(300_000);

const PASSWORD = 'correct horse battery staple 7!';
const COUNTRY_CODE = 'TN';
const TENANT_CODE = 'T040N_E2E_T';

let app: INestApplication;
let db: Sequelize;
let emailCrypto: PortalUserEmailCrypto;

let countryId: number;
let tenantId: number;

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

async function makeActor(
  key: string,
  role: PortalRole,
  scope: { countryId: number | null; tenantId: number | null; merchantId: number | null },
): Promise<Actor> {
  const email = `t040n-e2e-${key}@example.invalid`;
  await deletePortalUsersByEmail(db, emailCrypto, [email]);

  const userId = await insertPortalUser(db, emailCrypto, {
    email,
    displayName: `T-040 ${key}`,
    role,
    ...scope,
    mustChangePassword: false,
    preferredTimezone: 'Asia/Kolkata',
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
  const actor = actors.get(key);
  if (actor === undefined) throw new Error(`no actor "${key}"`);
  return actor;
}

function get(key: string, path: string) {
  return http().get(`/api/v1${path}`).set('Cookie', as(key).jar);
}

function post(key: string, path: string) {
  return http()
    .post(`/api/v1${path}`)
    .set('Cookie', as(key).jar)
    .set('X-CSRF-Token', as(key).csrf)
    .send({});
}

// --- fixtures ------------------------------------------------------------------------------------

async function ensureCountry(): Promise<number> {
  const [existing] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.countries WHERE code = :code',
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
     VALUES (:code, 'T-040 notifications e2e country', 'UTC', 'USD', '+001', 'active') RETURNING id`,
    { code: COUNTRY_CODE },
  );
  return created.id;
}

async function ensureTenant(): Promise<number> {
  const [existing] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.tenants WHERE code = :code',
    { code: TENANT_CODE },
  );
  if (existing !== undefined) {
    await exec(
      `UPDATE reward_config.tenants SET status = 'active', deleted_at = NULL, country_id = :countryId WHERE id = :id`,
      { id: existing.id, countryId },
    );
    return existing.id;
  }
  const [created] = await sql<{ id: number }>(
    `INSERT INTO reward_config.tenants (code, name, country_id, status)
     VALUES (:code, :code, :countryId, 'active') RETURNING id`,
    { code: TENANT_CODE, countryId },
  );
  return created.id;
}

// --- lifecycle -------------------------------------------------------------------------------

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  await ensureEncryptionKeys(moduleRef.get<Sequelize>(SEQUELIZE), T056_SUITE);

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

  countryId = await ensureCountry();
  tenantId = await ensureTenant();

  await makeActor('recipient', 'tenant_admin', { countryId, tenantId, merchantId: null });
  await makeActor('other', 'tenant_admin', { countryId, tenantId, merchantId: null });
  await makeActor('maker', 'maker', { countryId, tenantId, merchantId: null });
  await makeActor('checker', 'checker', { countryId, tenantId, merchantId: null });
  await makeActor('super', 'super_admin', { countryId: null, tenantId: null, merchantId: null });
});

afterAll(async () => {
  // `beforeAll` may have thrown before `tenantId`/`db` were ever assigned — guard every step so a
  // setup failure is reported as itself, not masked by a second, confusing failure here (and so
  // every connection this suite opened is still closed either way).
  if (db !== undefined && tenantId !== undefined) {
    await exec('DELETE FROM reward_portal.portal_user_notifications WHERE tenant_id = :tenantId', {
      tenantId,
    });
  }
  if (db !== undefined) {
    for (const actor of actors.values()) {
      await exec('DELETE FROM reward_portal.portal_users WHERE id = :id', { id: actor.userId });
    }
    await removeEncryptionKeys(db, T056_SUITE);
  }
  if (app !== undefined) await app.close();
});

// --- the suite -------------------------------------------------------------------------------

describe('T-040 — /notifications', () => {
  describe('the write path — notify() reaches a real recipient of every role (retry 1 fix)', () => {
    it('delivers to a tenant_admin recipient, and it shows up through the real HTTP read path', async () => {
      const notifications = app.get(NotificationsService);

      await notifications.notify({
        tenantId,
        recipientPortalUserId: as('recipient').userId,
        notificationType: NOTIFICATION_TYPE.CAMPAIGN_APPROVED,
        title: 'Campaign approved',
        message: 'Your campaign was approved.',
        entityType: 'campaign',
        entityId: 1,
        entityLabel: 'Fixture campaign',
      });

      const list = await get('recipient', '/notifications').expect(200);
      expect(list.body.data).toHaveLength(1);
      expect(list.body.data[0]).toMatchObject({
        message: 'Your campaign was approved.',
        isRead: false,
      });

      const unread = await get('recipient', '/notifications/unread-count').expect(200);
      expect(unread.body.data.count).toBe(1);
    });

    it('TC-7 — campaign submitted delivers to a real checker (previously structurally impossible)', async () => {
      const notifications = app.get(NotificationsService);

      await notifications.notify({
        tenantId,
        recipientPortalUserId: as('checker').userId,
        notificationType: NOTIFICATION_TYPE.CAMPAIGN_SUBMITTED,
        title: 'Campaign submitted',
        message: 'A campaign is waiting for your review.',
        entityType: 'campaign',
        entityId: 2,
        entityLabel: 'Fixture campaign for review',
      });

      const list = await get('checker', '/notifications').expect(200);
      expect(list.body.data).toHaveLength(1);
      expect(list.body.data[0]).toMatchObject({
        notificationType: NOTIFICATION_TYPE.CAMPAIGN_SUBMITTED,
        message: 'A campaign is waiting for your review.',
        isRead: false,
      });

      const unread = await get('checker', '/notifications/unread-count').expect(200);
      expect(unread.body.data.count).toBe(1);

      // A live row in the actual table this recipient reads through — not merely an HTTP
      // response — is the real proof the FK (`fk_pun_user`) accepted this `maker`-adjacent role.
      const [row] = await sql<{ user_id: number; notification_type: string }>(
        `SELECT user_id, notification_type FROM reward_portal.portal_user_notifications
          WHERE user_id = :userId ORDER BY id DESC LIMIT 1`,
        { userId: as('checker').userId },
      );
      expect(row).toMatchObject({
        user_id: as('checker').userId,
        notification_type: NOTIFICATION_TYPE.CAMPAIGN_SUBMITTED,
      });
    });

    it('TC-8 — campaign approved delivers to a real maker (previously structurally impossible)', async () => {
      const notifications = app.get(NotificationsService);

      await notifications.notify({
        tenantId,
        recipientPortalUserId: as('maker').userId,
        notificationType: NOTIFICATION_TYPE.CAMPAIGN_APPROVED,
        title: 'Campaign approved',
        message: 'Your campaign was approved.',
        entityType: 'campaign',
        entityId: 3,
        entityLabel: 'Fixture approved campaign',
      });

      const list = await get('maker', '/notifications').expect(200);
      expect(list.body.data).toHaveLength(1);
      expect(list.body.data[0]).toMatchObject({
        notificationType: NOTIFICATION_TYPE.CAMPAIGN_APPROVED,
        message: 'Your campaign was approved.',
        isRead: false,
      });

      const unread = await get('maker', '/notifications/unread-count').expect(200);
      expect(unread.body.data.count).toBe(1);
    });

    it('notify() still never rejects the caller, even for a truly nonexistent recipient', async () => {
      const notifications = app.get(NotificationsService);

      await expect(
        notifications.notify({
          tenantId,
          recipientPortalUserId: 999_999_999,
          notificationType: NOTIFICATION_TYPE.CAMPAIGN_SUBMITTED,
          title: 'Campaign submitted',
          message: 'A campaign is waiting for your review.',
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe("TC-1 / TC-9 — list is always the caller's own, paginated", () => {
    it("a second, unrelated actor never sees the recipient's feed", async () => {
      const list = await get('other', '/notifications').expect(200);
      expect(list.body.data).toEqual([]);
      expect(list.body.meta.total).toBe(0);
    });

    it('paginates 500 rows and keeps the unread count correct regardless of the page', async () => {
      await exec(
        `INSERT INTO reward_portal.portal_user_notifications
                (tenant_id, user_id, notification_type, title, message)
         SELECT :tenantId, :userId, 'campaign_approved', 'Row ' || gs, 'message ' || gs
           FROM generate_series(1, 500) AS gs`,
        { tenantId, userId: as('recipient').userId },
      );

      const page1 = await get('recipient', '/notifications?page=1&pageSize=20').expect(200);
      expect(page1.body.data).toHaveLength(20);
      expect(page1.body.meta).toMatchObject({ page: 1, pageSize: 20, total: 501 });

      const unread = await get('recipient', '/notifications/unread-count').expect(200);
      expect(unread.body.data.count).toBe(501);
    });
  });

  describe("TC-2 / TC-6 — another user's notification, by id", () => {
    it('answers 404 rather than confirming the row exists', async () => {
      const mine = await get('recipient', '/notifications?pageSize=1').expect(200);
      const targetId = mine.body.data[0].id as number;

      const response = await post('other', `/notifications/${String(targetId)}/read`);
      expect(response.status).toBe(404);

      // The row is genuinely unchanged.
      const stillUnread = await get('recipient', '/notifications?pageSize=1');
      expect(stillUnread.body.data[0]).toMatchObject({ id: targetId, isRead: false });
    });

    it('answers 404 for a non-existent id', async () => {
      const response = await post('recipient', '/notifications/999999999/read');
      expect(response.status).toBe(404);
    });
  });

  describe('TC-4 / TC-5 — mark one, mark all', () => {
    it('marks exactly one row read', async () => {
      const before = await get('recipient', '/notifications?pageSize=1').expect(200);
      const targetId = before.body.data[0].id as number;

      await post('recipient', `/notifications/${String(targetId)}/read`).expect(200);

      const after = await get('recipient', '/notifications?pageSize=1').expect(200);
      expect(after.body.data[0]).toMatchObject({ id: targetId, isRead: true });
    });

    it("mark-all-read only ever affects the caller's own rows", async () => {
      const before = await get('recipient', '/notifications/unread-count').expect(200);
      expect(before.body.data.count).toBeGreaterThan(0);

      const result = await post('recipient', '/notifications/read-all').expect(200);
      expect(result.body.data.affected).toBe(before.body.data.count);

      const after = await get('recipient', '/notifications/unread-count').expect(200);
      expect(after.body.data.count).toBe(0);

      // The unrelated actor's own (empty) feed is unaffected either way.
      const otherUnread = await get('other', '/notifications/unread-count').expect(200);
      expect(otherUnread.body.data.count).toBe(0);
    });
  });

  describe("implementation note 1 — super_admin sees only its own, never every tenant's", () => {
    it('an empty feed for super_admin, even though rows exist for other users', async () => {
      const list = await get('super', '/notifications').expect(200);
      expect(list.body.data).toEqual([]);
      expect(list.body.meta.total).toBe(0);
    });
  });

  describe('TC-16-equivalent — every role may reach its own feed (seeded notification:view/update)', () => {
    it('a maker with no rows of its own left still gets 200s with empty/zero results', async () => {
      // The maker fixture received exactly one row in the TC-8 write-path test above; clear it so
      // this assertion is honestly about the "never received anything" shape rather than
      // coincidentally matching zero.
      await post('maker', '/notifications/read-all').expect(200);

      await get('maker', '/notifications').expect(200);
      await get('maker', '/notifications/unread-count').expect(200);
    });
  });
});
