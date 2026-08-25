/**
 * T-019, TC-16 — **the correlation id reaches the audit tables.**
 *
 * 08-OBSERVABILITY.md §2 lists them among the stores the id must propagate to, and §6's
 * trace-retrieval endpoint (T-045) assembles its narrative from every store *"keyed by
 * `correlation_id`"*. Without this, `GET /audit/trace/:correlationId` has nothing to join on and
 * the acceptance question ("reconstruct the complete story") is answerable from logs alone —
 * which is exactly the "almost-useful but not quite" outcome §1 warns about.
 *
 * ### Two tables, two mechanisms, and why they differ
 *
 *  - `reward_portal.portal_audit_log` gets a **column** (`T019_001`). It is the portal's own
 *    table.
 *  - `reward_config.campaign_audit_trail` gets a **reserved key in its `field_changes` JSON**,
 *    because AGENT-PROTOCOL R1 forbids DDL against `reward_config` and the table has no such
 *    column. Escalated in the completion report; asserted here so the workaround is at least
 *    tested and greppable rather than folklore.
 *
 * The id is read from the ambient `TraceContext` **inside the repository**, not passed in by a
 * caller — so this suite also pins that no caller can omit it and no caller can forge it.
 */
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { AuditRepository, DOMAIN_CORRELATION_KEY } from '@/common/audit/audit.repository';
import { AuditService } from '@/common/audit/audit.service';
import { TraceContext } from '@/common/tracing/trace-context';
import { makeTrace } from './support/trace-fixtures';

interface RecordedQuery {
  sql: string;
  replacements: Record<string, unknown>;
}

function fakeSequelize(rows: unknown[] = []): {
  sequelize: Sequelize;
  queries: RecordedQuery[];
} {
  const queries: RecordedQuery[] = [];
  const sequelize = {
    async query(sql: string, options: { replacements?: Record<string, unknown> }) {
      queries.push({ sql, replacements: options.replacements ?? {} });
      return rows;
    },
  } as unknown as Sequelize;
  return { sequelize, queries };
}

describe('TC-16 — portal_audit_log.correlation_id', () => {
  it('is populated from the ambient trace on a row written inside a request', async () => {
    const { sequelize, queries } = fakeSequelize();
    const repository = new AuditRepository(sequelize);

    await TraceContext.run(makeTrace({ correlationId: 'audited-op-01' }), () =>
      repository.insertPortalEvent({
        eventType: 'permission_denied',
        actorId: 42,
        actorRole: 'maker',
        targetType: 'route',
        targetId: '/api/v1/campaigns/:id',
        countryId: 3,
        tenantId: 7,
        ipAddress: '10.0.0.4',
        detail: null,
      }),
    );

    expect(queries[0].sql).toContain('correlation_id');
    expect(queries[0].replacements.correlationId).toBe('audited-op-01');
  });

  it('is bound as a replacement, never concatenated into the statement', () => {
    // The id is validated at the edge, but the audit path handles attacker-influenced data by
    // design and this is the property that makes that safe regardless.
    const { sequelize, queries } = fakeSequelize();
    return TraceContext.run(makeTrace({ correlationId: 'bound-value-1' }), async () => {
      await new AuditRepository(sequelize).insertPortalEvent({
        eventType: 'x',
        actorId: null,
        actorRole: null,
        targetType: null,
        targetId: null,
        countryId: null,
        tenantId: null,
        ipAddress: null,
        detail: null,
      });
      expect(queries[0].sql).not.toContain('bound-value-1');
      expect(queries[0].sql).toContain(':correlationId');
    });
  });

  it('is NULL outside a request, which the column accepts', async () => {
    const { sequelize, queries } = fakeSequelize();

    await new AuditRepository(sequelize).insertPortalEvent({
      eventType: 'cli_bootstrap',
      actorId: null,
      actorRole: null,
      targetType: null,
      targetId: null,
      countryId: null,
      tenantId: null,
      ipAddress: null,
      detail: null,
    });

    expect(queries[0].replacements.correlationId).toBeNull();
  });

  it('reaches a row written through AuditService, which is how the application writes them', async () => {
    const { sequelize, queries } = fakeSequelize();
    const service = new AuditService(new AuditRepository(sequelize));

    await TraceContext.run(makeTrace({ correlationId: 'through-svc1' }), () =>
      service.recordPortalEvent({ eventType: 'login_success', actorId: 42 }),
    );

    expect(queries[0].replacements.correlationId).toBe('through-svc1');
  });

  it('is written for a *failed* request too, which is the case that matters most', async () => {
    const { sequelize, queries } = fakeSequelize();
    const service = new AuditService(new AuditRepository(sequelize));

    await TraceContext.run(makeTrace({ correlationId: 'denied-op-01' }), () =>
      service.recordRequestFailure({
        request: {
          method: 'PATCH',
          path: '/api/v1/campaigns/1',
          headers: {},
          ip: '10.0.0.4',
        } as never,
        status: 403,
        code: 'PERM_DENIED',
        traceId: 'denied-op-01',
      }),
    );

    expect(queries[0].replacements.correlationId).toBe('denied-op-01');
  });
});

describe('TC-16 — campaign_audit_trail carries the id in field_changes (R1 workaround)', () => {
  const row = {
    tenantId: 7,
    campaignId: 8821,
    entityType: 'campaign' as const,
    entityId: 8821,
    action: 'updated' as const,
    performedBy: 900,
    approvalRequestId: null,
    comment: null,
  };

  it('merges the reserved key alongside the real diff', async () => {
    const { sequelize, queries } = fakeSequelize();

    await TraceContext.run(makeTrace({ correlationId: 'domain-op-01' }), () =>
      new AuditRepository(sequelize).insertDomainEvent({
        ...row,
        fieldChanges: { name: { before: 'A', after: 'B' } },
      }),
    );

    expect(JSON.parse(String(queries[0].replacements.fieldChanges))).toEqual({
      name: { before: 'A', after: 'B' },
      [DOMAIN_CORRELATION_KEY]: 'domain-op-01',
    });
  });

  it('writes the key even when there is no diff — a submit has nothing to diff', async () => {
    const { sequelize, queries } = fakeSequelize();

    await TraceContext.run(makeTrace({ correlationId: 'submit-op-01' }), () =>
      new AuditRepository(sequelize).insertDomainEvent({
        ...row,
        action: 'submitted',
        fieldChanges: null,
      }),
    );

    expect(JSON.parse(String(queries[0].replacements.fieldChanges))).toEqual({
      [DOMAIN_CORRELATION_KEY]: 'submit-op-01',
    });
  });

  it('leaves field_changes NULL outside a request, exactly as before this task', async () => {
    const { sequelize, queries } = fakeSequelize();

    await new AuditRepository(sequelize).insertDomainEvent({ ...row, fieldChanges: null });

    expect(queries[0].replacements.fieldChanges).toBeNull();
  });

  it('does not disturb an existing diff when there is no trace', async () => {
    const { sequelize, queries } = fakeSequelize();

    await new AuditRepository(sequelize).insertDomainEvent({
      ...row,
      fieldChanges: { name: { before: 'A', after: 'B' } },
    });

    expect(queries[0].replacements.fieldChanges).toBe('{"name":{"before":"A","after":"B"}}');
  });

  it('uses a double-underscored key, so it cannot be confused with a changed column', () => {
    expect(DOMAIN_CORRELATION_KEY).toBe('__correlationId');
    expect(DOMAIN_CORRELATION_KEY.startsWith('__')).toBe(true);
  });

  it('produces JSON a Postgres query can key on', async () => {
    // The shape T-045 will need: `field_changes::jsonb ->> '__correlationId' = :cid`.
    const { sequelize, queries } = fakeSequelize();

    await TraceContext.run(makeTrace({ correlationId: 'queryable-01' }), () =>
      new AuditRepository(sequelize).insertDomainEvent({ ...row, fieldChanges: null }),
    );

    const parsed = JSON.parse(String(queries[0].replacements.fieldChanges)) as Record<
      string,
      unknown
    >;
    expect(parsed[DOMAIN_CORRELATION_KEY]).toBe('queryable-01');
  });
});

describe('the statement itself', () => {
  it('still binds every other value and inserts the same columns as before', async () => {
    const { sequelize, queries } = fakeSequelize();

    await new AuditRepository(sequelize).insertPortalEvent({
      eventType: 'x',
      actorId: 1,
      actorRole: 'maker',
      targetType: 't',
      targetId: '1',
      countryId: 3,
      tenantId: 7,
      ipAddress: '10.0.0.4',
      detail: { a: 1 },
    });

    expect(queries[0].sql).toContain('INSERT INTO reward_portal.portal_audit_log');
    expect(queries[0].sql).toContain('CAST(:ipAddress AS inet)');
    expect(queries[0].sql).toContain('CAST(:detail AS jsonb)');
    // Exactly the T-014 set plus `correlationId` — nothing dropped, nothing else added.
    expect(Object.keys(queries[0].replacements).sort()).toEqual([
      'actorId',
      'actorRole',
      'correlationId',
      'countryId',
      'detail',
      'eventType',
      'ipAddress',
      'targetId',
      'targetType',
      'tenantId',
    ]);
  });

  it('uses QueryTypes.INSERT, so Sequelize does not try to parse a result set', async () => {
    const queries: { type?: unknown }[] = [];
    const sequelize = {
      async query(_sql: string, options: { type?: unknown }) {
        queries.push(options);
        return [];
      },
    } as unknown as Sequelize;

    await new AuditRepository(sequelize).insertDomainEvent({
      tenantId: 7,
      campaignId: 1,
      entityType: 'campaign',
      entityId: null,
      action: 'created',
      fieldChanges: null,
      performedBy: 900,
      approvalRequestId: null,
      comment: null,
    });

    expect(queries[0].type).toBe(QueryTypes.INSERT);
  });
});
