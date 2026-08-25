/**
 * T-040 — `ListCampaignAuditQueryDto`/`ListPortalAuditQueryDto` validation. The controller-level
 * whitelist behaviour (TC-16 — an injected column name is a 400) is proved end to end against
 * the real global `ValidationPipe` in `audit-viewer.e2e-spec.ts`; this suite proves the DTOs'
 * own field-level rules fast, including the `IsIn` enum check that whitelist relies on.
 */
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  ListCampaignAuditQueryDto,
  ListPortalAuditQueryDto,
} from '@/modules/audit/dto/list-audit-query.dto';

async function errorsFor(cls: new () => object, input: Record<string, unknown>) {
  const dto = plainToInstance(cls, input);
  return validate(dto, { whitelist: true, forbidNonWhitelisted: true });
}

describe('ListCampaignAuditQueryDto', () => {
  it('accepts a fully-populated, valid filter set', async () => {
    const errors = await errorsFor(ListCampaignAuditQueryDto, {
      dateFrom: '2026-01-01T00:00:00.000Z',
      dateTo: '2026-06-01T00:00:00.000Z',
      actorId: '42',
      action: 'submitted',
      entityType: 'campaign',
      campaignId: '55',
      page: '1',
      pageSize: '20',
    });
    expect(errors).toHaveLength(0);
  });

  it('rejects an action outside the transcribed CHECK-constraint vocabulary', async () => {
    const errors = await errorsFor(ListCampaignAuditQueryDto, { action: 'not_a_real_action' });
    expect(errors).not.toHaveLength(0);
  });

  it('rejects an entityType outside the whitelist', async () => {
    const errors = await errorsFor(ListCampaignAuditQueryDto, { entityType: 'password_hash' });
    expect(errors).not.toHaveLength(0);
  });

  it('TC-16 — rejects an unknown query key entirely (an injected column name)', async () => {
    const errors = await errorsFor(ListCampaignAuditQueryDto, {
      orderByColumn: 'password_hash',
    } as unknown as Record<string, unknown>);
    expect(errors).not.toHaveLength(0);
  });

  it('rejects a malformed date', async () => {
    const errors = await errorsFor(ListCampaignAuditQueryDto, { dateFrom: 'not-a-date' });
    expect(errors).not.toHaveLength(0);
  });
});

describe('ListPortalAuditQueryDto', () => {
  it('accepts a valid eventType/targetType', async () => {
    const errors = await errorsFor(ListPortalAuditQueryDto, {
      eventType: 'login_succeeded',
      targetType: 'portal_user',
    });
    expect(errors).toHaveLength(0);
  });

  it('rejects an eventType containing SQL metacharacters (TC-16)', async () => {
    const errors = await errorsFor(ListPortalAuditQueryDto, {
      eventType: "'; DROP TABLE portal_audit_log; --",
    });
    expect(errors).not.toHaveLength(0);
  });

  it('rejects an eventType with uppercase or spaces — outside the token pattern', async () => {
    const errors = await errorsFor(ListPortalAuditQueryDto, { eventType: 'Login Succeeded' });
    expect(errors).not.toHaveLength(0);
  });

  it('accepts a valid actorId/page/pageSize and rejects an invalid actorId', async () => {
    expect(
      await errorsFor(ListPortalAuditQueryDto, { actorId: '7', page: '1', pageSize: '20' }),
    ).toHaveLength(0);
    expect(await errorsFor(ListPortalAuditQueryDto, { actorId: '0' })).not.toHaveLength(0);
  });
});
