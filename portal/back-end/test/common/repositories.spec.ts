/**
 * T-014 — `AuditRepository` and `SystemMessageRepository`: the SQL, and what is bound into it.
 *
 * These specs assert the *shape* of each statement — which table, which columns, and that every
 * value travels as a bound replacement rather than as text. The `audit.e2e-spec.ts` in this
 * directory proves the same statements actually run against the real schema; a unit test cannot,
 * and a spec that only checked strings would be a spec of this file's own opinions.
 *
 * The one property worth stating: **no value is ever concatenated into a statement.** Every
 * query below is a compile-time constant string plus a `replacements` map, so there is no
 * injection surface even though the audit path handles attacker-influenced data (a route, an
 * IP, a detail object) by design.
 */
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { AuditRepository } from '@/common/audit/audit.repository';
import { SystemMessageRepository } from '@/common/messages/message.repository';

interface RecordedQuery {
  sql: string;
  options: { type?: string; replacements?: Record<string, unknown> };
}

function fakeSequelize(rows: unknown[] = []): { sequelize: Sequelize; queries: RecordedQuery[] } {
  const queries: RecordedQuery[] = [];
  const sequelize = {
    async query(sql: string, options: RecordedQuery['options']) {
      queries.push({ sql, options });
      return rows;
    },
  } as unknown as Sequelize;
  return { sequelize, queries };
}

describe('AuditRepository', () => {
  it('inserts into reward_portal.portal_audit_log with every value bound', async () => {
    const { sequelize, queries } = fakeSequelize();

    await new AuditRepository(sequelize).insertPortalEvent({
      eventType: 'permission_denied',
      actorId: 42,
      actorRole: 'merchant',
      targetType: 'route',
      targetId: '/api/v1/campaigns/:id',
      countryId: 3,
      tenantId: 7,
      ipAddress: '10.0.0.4',
      detail: { method: 'PATCH' },
    });

    const [{ sql, options }] = queries;
    expect(sql).toContain('INSERT INTO reward_portal.portal_audit_log');
    expect(sql).toContain('CAST(:ipAddress AS inet)');
    expect(sql).toContain('CAST(:detail AS jsonb)');
    expect(options.type).toBe(QueryTypes.INSERT);
    expect(options.replacements).toEqual({
      eventType: 'permission_denied',
      actorId: 42,
      actorRole: 'merchant',
      targetType: 'route',
      targetId: '/api/v1/campaigns/:id',
      countryId: 3,
      tenantId: 7,
      ipAddress: '10.0.0.4',
      detail: '{"method":"PATCH"}',
      // T-019 added `correlation_id`. Bound from the ambient `TraceContext`, not from the row —
      // see `audit.repository.ts`. This spec runs outside a request, so it is `null`;
      // `test/tracing/audit-correlation.spec.ts` covers the populated case.
      correlationId: null,
    });
  });

  it('binds a null detail as NULL rather than the string "null"', async () => {
    const { sequelize, queries } = fakeSequelize();

    await new AuditRepository(sequelize).insertPortalEvent({
      eventType: 'login_failure',
      actorId: null,
      actorRole: null,
      targetType: null,
      targetId: null,
      countryId: null,
      tenantId: null,
      ipAddress: null,
      detail: null,
    });

    expect(queries[0].options.replacements?.detail).toBeNull();
  });

  it('inserts into reward_config.campaign_audit_trail, letting the defaults set retention', async () => {
    const { sequelize, queries } = fakeSequelize();

    await new AuditRepository(sequelize).insertDomainEvent({
      tenantId: 7,
      campaignId: 8821,
      entityType: 'campaign',
      entityId: 8821,
      action: 'updated',
      fieldChanges: { name: { before: 'A', after: 'B' } },
      performedBy: 900,
      approvalRequestId: null,
      comment: null,
    });

    const [{ sql, options }] = queries;
    expect(sql).toContain('INSERT INTO reward_config.campaign_audit_trail');
    // `retention_expires_at` has a 7-year default on the table (08-OBSERVABILITY.md §7) and is
    // deliberately not set here — overriding it from application code would let a caller shorten
    // the retention of the record of their own action.
    expect(sql).not.toContain('retention_expires_at');
    expect(options.replacements).toEqual({
      tenantId: 7,
      campaignId: 8821,
      entityType: 'campaign',
      entityId: 8821,
      action: 'updated',
      fieldChanges: '{"name":{"before":"A","after":"B"}}',
      performedBy: 900,
      approvalRequestId: null,
      comment: null,
    });
  });

  it('binds a null field_changes and comment as NULL', async () => {
    const { sequelize, queries } = fakeSequelize();

    await new AuditRepository(sequelize).insertDomainEvent({
      tenantId: 7,
      campaignId: 8821,
      entityType: 'tracker',
      entityId: null,
      action: 'created',
      fieldChanges: null,
      performedBy: 900,
      approvalRequestId: null,
      comment: null,
    });

    expect(queries[0].options.replacements?.fieldChanges).toBeNull();
  });

  it('has no update, delete or destroy method — the tables are append-only', () => {
    const methods = Object.getOwnPropertyNames(AuditRepository.prototype);

    expect(methods.sort()).toEqual(
      ['constructor', 'findAdminUserId', 'insertDomainEvent', 'insertPortalEvent'].sort(),
    );
  });

  describe('findAdminUserId', () => {
    it('returns the linked reward_config.admin_users id', async () => {
      const { sequelize, queries } = fakeSequelize([{ admin_user_id: 900 }]);

      await expect(new AuditRepository(sequelize).findAdminUserId(42)).resolves.toBe(900);
      expect(queries[0].options.replacements).toEqual({ portalUserId: 42 });
    });

    it('returns null for an unlinked account, and for a portal user that does not exist', async () => {
      const unlinked = fakeSequelize([{ admin_user_id: null }]);
      const missing = fakeSequelize([]);

      await expect(new AuditRepository(unlinked.sequelize).findAdminUserId(42)).resolves.toBeNull();
      await expect(new AuditRepository(missing.sequelize).findAdminUserId(99)).resolves.toBeNull();
    });
  });
});

describe('SystemMessageRepository', () => {
  it('reads the catalogue and maps it to {key, text}', async () => {
    const { sequelize, queries } = fakeSequelize([
      { message_key: 'PERM_DENIED', message_text: 'Nope.' },
    ]);

    await expect(new SystemMessageRepository(sequelize).loadAll()).resolves.toEqual([
      { key: 'PERM_DENIED', text: 'Nope.' },
    ]);
    expect(queries[0].sql).toBe(
      'SELECT message_key, message_text FROM reward_config.system_messages',
    );
    expect(queries[0].options.type).toBe(QueryTypes.SELECT);
    expect(queries[0].options.replacements).toBeUndefined();
  });
});
