/**
 * T-040 — `NotificationsController`, against a mocked `NotificationsService`. Guard behaviour
 * (`@RequirePermission`) is proved for real in `notifications.e2e-spec.ts`; this suite proves
 * the controller's own shaping — the envelope, the pagination `meta`, and that a 404 the service
 * throws reaches the caller unchanged.
 */
import { NotFoundError } from '@/common/errors/app-error';
import type { AuthenticatedUser } from '@/modules/auth/decorators/current-user.decorator';
import { NotificationsController } from '@/modules/notifications/notifications.controller';
import type { NotificationsService } from '@/modules/notifications/notifications.service';

function actor(): AuthenticatedUser {
  return {
    userId: 7,
    sessionId: 's',
    role: 'maker',
    countryId: 3,
    tenantId: 9,
    merchantId: null,
    rbacVersion: 1,
    tokenId: 't',
    mustChangePassword: false,
  };
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
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
  } as unknown as import('@/database/portal-models/portal-user-notification.model').PortalUserNotification;
}

describe('NotificationsController', () => {
  it('GET / envelopes the list with page/pageSize/total meta', async () => {
    const service = {
      list: jest.fn().mockResolvedValue({ items: [row()], page: 1, pageSize: 20, total: 1 }),
    } as unknown as NotificationsService;
    const controller = new NotificationsController(service);

    const result = await controller.list(actor(), {});

    expect(result.meta).toEqual({ page: 1, pageSize: 20, total: 1 });
    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({ id: 1, message: 'Your campaign was approved.' });
  });

  it('GET /unread-count envelopes { count }', async () => {
    const service = {
      unreadCount: jest.fn().mockResolvedValue(3),
    } as unknown as NotificationsService;
    const controller = new NotificationsController(service);

    await expect(controller.unreadCount(actor())).resolves.toEqual({ data: { count: 3 } });
  });

  it('POST /:id/read envelopes the id on success', async () => {
    const service = {
      markRead: jest.fn().mockResolvedValue(undefined),
    } as unknown as NotificationsService;
    const controller = new NotificationsController(service);

    await expect(controller.markRead(actor(), '1')).resolves.toEqual({ data: { id: '1' } });
  });

  it("POST /:id/read propagates the service's 404 for another user's row", async () => {
    const service = {
      markRead: jest.fn().mockRejectedValue(new NotFoundError()),
    } as unknown as NotificationsService;
    const controller = new NotificationsController(service);

    await expect(controller.markRead(actor(), '999')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('POST /read-all envelopes { affected }', async () => {
    const service = {
      markAllRead: jest.fn().mockResolvedValue(4),
    } as unknown as NotificationsService;
    const controller = new NotificationsController(service);

    await expect(controller.markAllRead(actor())).resolves.toEqual({ data: { affected: 4 } });
  });
});
