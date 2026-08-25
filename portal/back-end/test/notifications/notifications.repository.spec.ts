/**
 * T-040 — `NotificationsRepository.insert`, against a fake `Sequelize` — proves the SQL shape
 * and that every value is bound through `replacements`, never string-built. That the live
 * `reward_portal.portal_user_notifications.user_id` FK actually accepts a real recipient for
 * every role (retry 1's fix) is proved against the real database in `notifications.e2e-spec.ts`.
 */
import { NotificationsRepository } from '@/modules/notifications/notifications.repository';
import { NOTIFICATION_TYPE } from '@/modules/notifications/notifications.constants';

describe('NotificationsRepository.insert', () => {
  it('binds every value through replacements and inserts into reward_portal.portal_user_notifications', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const repository = new NotificationsRepository({ query } as never);

    await repository.insert({
      tenantId: 9,
      recipientPortalUserId: 42,
      notificationType: NOTIFICATION_TYPE.CAMPAIGN_SUBMITTED,
      title: 'Campaign submitted',
      message: 'A campaign is waiting for your review.',
      entityType: 'campaign',
      entityId: 55,
      entityLabel: 'Ramadan promo',
    });

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, options] = query.mock.calls[0] as [
      string,
      { replacements: Record<string, unknown> },
    ];
    expect(sql).toContain('INSERT INTO reward_portal.portal_user_notifications');
    expect(options.replacements).toEqual({
      tenantId: 9,
      userId: 42,
      notificationType: 'campaign_submitted',
      title: 'Campaign submitted',
      message: 'A campaign is waiting for your review.',
      entityType: 'campaign',
      entityId: 55,
      entityLabel: 'Ramadan promo',
    });
  });

  it('defaults the optional entity fields to null', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const repository = new NotificationsRepository({ query } as never);

    await repository.insert({
      tenantId: 9,
      recipientPortalUserId: 42,
      notificationType: NOTIFICATION_TYPE.TENANT_ACTIVATED,
      title: 'Tenant activated',
      message: 'Your tenant is now active.',
    });

    const [, options] = query.mock.calls[0] as [string, { replacements: Record<string, unknown> }];
    expect(options.replacements).toMatchObject({
      entityType: null,
      entityId: null,
      entityLabel: null,
    });
  });
});
