/**
 * T-040 — `NotificationsService`, against in-memory doubles. `notifications.e2e-spec.ts` proves
 * the same properties against the real database and the real, already-shipped scope strategy;
 * this suite proves the decisions fast and without a live Postgres.
 */
import { NotFoundError } from '@/common/errors/app-error';
import type { AuthenticatedUser } from '@/modules/auth/decorators/current-user.decorator';
import { NotificationsService } from '@/modules/notifications/notifications.service';
import {
  NOTIFICATION_ENTITY_LABEL_LIMIT,
  NOTIFICATION_MAX_PAGE_SIZE,
  NOTIFICATION_MESSAGE_LIMIT,
  NOTIFICATION_TITLE_LIMIT,
  NOTIFICATION_TYPE,
} from '@/modules/notifications/notifications.constants';
import {
  asScopedRepository,
  FakeNotificationStore,
  FakeScopedRepository,
} from './support/notifications-doubles';

function actor(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return {
    userId: 7,
    sessionId: 'sess-1',
    role: 'maker',
    countryId: 3,
    tenantId: 9,
    merchantId: null,
    rbacVersion: 1,
    tokenId: 'tok-1',
    mustChangePassword: false,
    ...overrides,
  };
}

function makeService(
  overrides: { scoped?: FakeScopedRepository; store?: FakeNotificationStore } = {},
) {
  const scoped = overrides.scoped ?? new FakeScopedRepository();
  const store = overrides.store ?? new FakeNotificationStore();
  const service = new NotificationsService(asScopedRepository(scoped), store);
  return { service, scoped, store };
}

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    tenantId: 9,
    userId: 7,
    notificationType: 'campaign_approved',
    title: 'Campaign approved',
    message: 'Your campaign was approved.',
    entityType: 'campaign',
    entityId: 55,
    entityLabel: 'Ramadan promo',
    isRead: false,
    readAt: null,
    createdAt: new Date('2026-08-19T00:00:00.000Z'),
    ...overrides,
  };
}

describe("TC-1 — list is always the caller's own", () => {
  it('adds userId to the where clause explicitly, on top of whatever ScopedRepository contributes', async () => {
    const { service, scoped } = makeService();
    scoped.rows = [row({ id: 1, userId: 7 }), row({ id: 2, userId: 99 })];

    const page = await service.list(actor({ userId: 7 }));

    expect(page.items.map((item) => (item as unknown as { id: number }).id)).toEqual([1]);
    const call = scoped.callsOf('listAll')[0];
    expect((call.options as { where: Record<string, unknown> }).where).toMatchObject({
      userId: 7,
    });
  });

  it("never returns another actor's rows, even for super_admin (implementation note 1)", async () => {
    const { service, scoped } = makeService();
    scoped.rows = [row({ id: 1, userId: 7 }), row({ id: 2, userId: 99 })];

    // ScopedRepository's own strategy contributes NOTHING for super_admin (`unrestricted()`), so
    // this proves the explicit filter — not the registered strategy — is what protects this role.
    const page = await service.list(
      actor({ userId: 7, role: 'super_admin', tenantId: null, countryId: null }),
    );

    expect(page.items).toHaveLength(1);
  });
});

describe('TC-9 — pagination', () => {
  it('defaults to page 1 and caps pageSize at the documented maximum', async () => {
    const { service, scoped } = makeService();
    scoped.rows = Array.from({ length: 5 }, (_, i) => row({ id: i + 1 }));

    await service.list(actor(), undefined, 99_999);

    const call = scoped.callsOf('listAll')[0];
    expect((call.options as { limit: number }).limit).toBe(NOTIFICATION_MAX_PAGE_SIZE);
    expect((call.options as { offset: number }).offset).toBe(0);
  });

  it('treats an explicit page below 1 the same as no page at all', async () => {
    const { service, scoped } = makeService();
    scoped.rows = [row({ id: 1 })];

    await service.list(actor(), 0);

    const call = scoped.callsOf('listAll')[0];
    expect((call.options as { offset: number }).offset).toBe(0);
  });

  it('treats an explicit pageSize below 1 the same as no pageSize at all', async () => {
    const { service, scoped } = makeService();
    scoped.rows = [row({ id: 1 })];

    await service.list(actor(), undefined, 0);

    const call = scoped.callsOf('listAll')[0];
    expect((call.options as { limit: number }).limit).toBe(20);
  });

  it('paginates to a later page with the requested pageSize', async () => {
    const { service, scoped } = makeService();
    scoped.rows = Array.from({ length: 5 }, (_, i) => row({ id: i + 1 }));

    const page = await service.list(actor(), 2, 2);

    expect(page.page).toBe(2);
    expect(page.pageSize).toBe(2);
    const call = scoped.callsOf('listAll')[0];
    expect((call.options as { offset: number }).offset).toBe(2);
    expect((call.options as { limit: number }).limit).toBe(2);
  });
});

describe('TC-3 — unread count', () => {
  it('matches SELECT count(*) … WHERE is_read=false AND user_id=<actor>', async () => {
    const { service, scoped } = makeService();
    scoped.rows = [
      row({ id: 1, userId: 7, isRead: false }),
      row({ id: 2, userId: 7, isRead: true }),
      row({ id: 3, userId: 99, isRead: false }),
    ];

    await expect(service.unreadCount(actor({ userId: 7 }))).resolves.toBe(1);
  });
});

describe('TC-4 — mark one read', () => {
  it("sets isRead and readAt on the caller's own row", async () => {
    const { service, scoped } = makeService();
    scoped.rows = [row({ id: 1, userId: 7, isRead: false, readAt: null })];

    await service.markRead(actor({ userId: 7 }), '1');

    expect(scoped.rows[0]).toMatchObject({ isRead: true });
    expect(scoped.rows[0]['readAt']).toBeInstanceOf(Date);
  });
});

describe("TC-6 — mark another user's notification read", () => {
  it('answers 404 and leaves the row unchanged', async () => {
    const { service, scoped } = makeService();
    scoped.rows = [row({ id: 1, userId: 99, isRead: false, readAt: null })];

    await expect(service.markRead(actor({ userId: 7 }), '1')).rejects.toBeInstanceOf(NotFoundError);
    expect(scoped.rows[0]).toMatchObject({ isRead: false, readAt: null });
  });

  it('answers 404 for a malformed id without ever reaching a query', async () => {
    const { service, scoped } = makeService();
    scoped.rows = [row({ id: 1, userId: 7 })];

    await expect(service.markRead(actor({ userId: 7 }), 'not-a-number')).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(scoped.callsOf('update')).toHaveLength(0);
  });
});

describe('TC-5 — mark all read', () => {
  it("affects only the caller's own unread rows", async () => {
    const { service, scoped } = makeService();
    scoped.rows = [
      row({ id: 1, userId: 7, isRead: false }),
      row({ id: 2, userId: 7, isRead: false }),
      row({ id: 3, userId: 7, isRead: true }),
      row({ id: 4, userId: 99, isRead: false }),
    ];

    const affected = await service.markAllRead(actor({ userId: 7 }));

    expect(affected).toBe(2);
    expect(scoped.rows.filter((r) => r['userId'] === 7).every((r) => r['isRead'] === true)).toBe(
      true,
    );
    expect(scoped.rows.find((r) => r['id'] === 4)).toMatchObject({ isRead: false });
  });
});

describe('notify() — the producer-facing write', () => {
  it('clamps title/message to their column widths and forwards the recipient id', async () => {
    const { service, store } = makeService();

    await service.notify({
      tenantId: 9,
      recipientPortalUserId: 42,
      notificationType: NOTIFICATION_TYPE.CAMPAIGN_APPROVED,
      title: 'x'.repeat(NOTIFICATION_TITLE_LIMIT + 50),
      message: 'y'.repeat(NOTIFICATION_MESSAGE_LIMIT + 50),
    });

    expect(store.inserted).toHaveLength(1);
    expect(store.inserted[0].recipientPortalUserId).toBe(42);
    expect(store.inserted[0].title).toHaveLength(NOTIFICATION_TITLE_LIMIT);
    expect(store.inserted[0].message).toHaveLength(NOTIFICATION_MESSAGE_LIMIT);
  });

  it('clamps a supplied entityLabel to its column width', async () => {
    const { service, store } = makeService();

    await service.notify({
      tenantId: 9,
      recipientPortalUserId: 42,
      notificationType: NOTIFICATION_TYPE.CAMPAIGN_APPROVED,
      title: 'Campaign approved',
      message: 'Your campaign was approved.',
      entityType: 'campaign',
      entityId: 55,
      entityLabel: 'z'.repeat(300),
    });

    expect(store.inserted[0].entityLabel).toHaveLength(NOTIFICATION_ENTITY_LABEL_LIMIT);
  });

  it("never rejects when the store throws — mirrors AuditService's never-fail contract (T-014)", async () => {
    const store = new FakeNotificationStore();
    store.failWith = new Error('violates foreign key constraint "fk_un_user"');
    const { service } = makeService({ store });

    await expect(
      service.notify({
        tenantId: 9,
        recipientPortalUserId: 42,
        notificationType: NOTIFICATION_TYPE.CAMPAIGN_SUBMITTED,
        title: 'Campaign submitted',
        message: 'A campaign is waiting for your review.',
      }),
    ).resolves.toBeUndefined();
  });
});
