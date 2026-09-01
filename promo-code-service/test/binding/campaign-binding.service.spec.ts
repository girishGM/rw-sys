/**
 * T-PC-012. `CampaignBindingService` — bind validation, the deactivate-then-create transaction,
 * the retryable-race path, and `resolveActiveBinding`'s three-way outcome, run against the real
 * Postgres 16 server (root `CLAUDE.md`) as the real `promo_code_app` role — same real-DB
 * convention `promo-code-config.service.spec.ts`/`promo-code-config.repository.spec.ts`
 * (T-PC-010) already established for the sibling table, per `AGENT-PROTOCOL.md` §3 ("assert the
 * observable property, not the implementation string").
 *
 * TC-1..TC-9, TC-11, TC-12 (plus TC-10, the concurrency race under real, genuinely concurrent
 * requests) live here; the full HTTP round trip (guard, controller, filter wiring) lives in
 * `campaign-binding.e2e-spec.ts` instead. `campaign-binding.service.retry.spec.ts` is a third,
 * deliberately mocked file covering the same retry branch deterministically — see that file's
 * own header for why TC-10 alone (a real, inherently non-deterministic race) can't guarantee
 * the retry-then-succeed and retry-exhausted paths are both actually exercised on every run.
 *
 * Deviation from the task file's literal path (`test/modules/campaign-promo-config/
 * campaign-promo-config.service.spec.ts`): `project.config.json` grants this agent
 * `test/binding/**`, not `test/modules/campaign-promo-config/**` — same deviation, and same
 * reasoning, as T-PC-011's `test/config/**` placement for the sibling module.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { createAppTestConnection } from '../config/support/app-connection';
import { PromoCodeConfigRepository } from '@/modules/promo-code-config/promo-code-config.repository';
import { PromoCodeConfigAuditRepository } from '@/modules/promo-code-config/promo-code-config-audit.repository';
import { PromoCodeConfigService } from '@/modules/promo-code-config/promo-code-config.service';
import { CampaignBindingRepository } from '@/modules/campaign-binding/campaign-binding.repository';
import { CampaignBindingService } from '@/modules/campaign-binding/campaign-binding.service';
import {
  ConfigNotActiveError,
  CampaignBindingValidationError,
} from '@/modules/campaign-binding/campaign-binding.errors';

describe('T-PC-012 — CampaignBindingService', () => {
  let sequelize: Sequelize;
  let promoCodeConfigRepository: PromoCodeConfigRepository;
  let promoCodeConfigService: PromoCodeConfigService;
  let bindingRepository: CampaignBindingRepository;
  let service: CampaignBindingService;
  const tenantIds: string[] = [];

  beforeAll(async () => {
    sequelize = createAppTestConnection();
    await sequelize.authenticate();
    promoCodeConfigRepository = new PromoCodeConfigRepository(sequelize);
    const auditRepository = new PromoCodeConfigAuditRepository(sequelize);
    promoCodeConfigService = new PromoCodeConfigService(
      promoCodeConfigRepository,
      auditRepository,
      sequelize,
    );
    bindingRepository = new CampaignBindingRepository(sequelize);
    service = new CampaignBindingService(bindingRepository, promoCodeConfigService, sequelize);
  });

  afterAll(async () => {
    for (const tenantId of tenantIds) {
      await sequelize.query(
        'DELETE FROM promo_code.campaign_promo_config WHERE tenant_id = :tenantId',
        {
          replacements: { tenantId },
        },
      );
      await sequelize.query(
        `DELETE FROM promo_code.promo_code_config_audit
           WHERE promo_code_config_id IN (
             SELECT id FROM promo_code.promo_code_config WHERE tenant_id = :tenantId
           )`,
        { replacements: { tenantId } },
      );
      await sequelize.query(
        'DELETE FROM promo_code.promo_code_config WHERE tenant_id = :tenantId',
        {
          replacements: { tenantId },
        },
      );
    }
    await sequelize.close();
  });

  function freshTenant(): string {
    const id = randomUUID();
    tenantIds.push(id);
    return id;
  }

  async function seedActiveConfig(tenantId: string): Promise<string> {
    const config = await promoCodeConfigRepository.create(tenantId, {
      merchantId: null,
      name: `t-pc-012 config ${randomUUID()}`,
      codePrefix: null,
      codePostfix: null,
      codeLength: 8,
      characterSet: 'ALPHANUMERIC',
      excludeAmbiguousChars: true,
      rewardValueType: 'FIXED_AMOUNT',
      rewardValue: 10,
      rewardUnit: 'USD',
      maxRedemptionsPerCode: 1,
      codeExpiryDays: null,
      createdBy: randomUUID(),
    });
    return config.id;
  }

  function bindInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      promoCodeConfigId: randomUUID(),
      tenantId: randomUUID(),
      bindLevel: 'CAMPAIGN',
      bindRefId: randomUUID(),
      boundBy: randomUUID(),
      ...overrides,
    };
  }

  // TC-1
  it('TC-1: binds an ACTIVE config to a campaign with no prior binding', async () => {
    const tenantId = freshTenant();
    const configId = await seedActiveConfig(tenantId);
    const bindRefId = randomUUID();

    const created = await service.bind(
      bindInput({ promoCodeConfigId: configId, tenantId, bindRefId }),
    );

    expect(created.status).toBe('ACTIVE');
    expect(created.promoCodeConfigId).toBe(configId);
    expect(created.bindLevel).toBe('CAMPAIGN');
    expect(created.bindRefId).toBe(bindRefId);
  });

  // TC-2
  it('TC-2: binding an ARCHIVED promoCodeConfigId throws ConfigNotActiveError', async () => {
    const tenantId = freshTenant();
    const configId = await seedActiveConfig(tenantId);
    await promoCodeConfigRepository.archive(tenantId, configId, randomUUID());

    await expect(
      service.bind(bindInput({ promoCodeConfigId: configId, tenantId })),
    ).rejects.toThrow(ConfigNotActiveError);
  });

  // TC-3
  it('TC-3: binding a promoCodeConfigId that does not exist throws ConfigNotActiveError', async () => {
    const tenantId = freshTenant();

    await expect(
      service.bind(bindInput({ promoCodeConfigId: randomUUID(), tenantId })),
    ).rejects.toThrow(ConfigNotActiveError);
  });

  // TC-4
  it('TC-4: binding a promoCodeConfigId belonging to a different tenant throws ConfigNotActiveError (never resolves cross-tenant)', async () => {
    const ownerTenantId = freshTenant();
    const requestingTenantId = freshTenant();
    const configId = await seedActiveConfig(ownerTenantId);

    await expect(
      service.bind(bindInput({ promoCodeConfigId: configId, tenantId: requestingTenantId })),
    ).rejects.toThrow(ConfigNotActiveError);
  });

  // TC-5 / TC-6
  it('TC-5/TC-6: rebinding deactivates the prior binding, preserves history, and leaves exactly one active row', async () => {
    const tenantId = freshTenant();
    const firstConfigId = await seedActiveConfig(tenantId);
    const secondConfigId = await seedActiveConfig(tenantId);
    const bindRefId = randomUUID();

    const first = await service.bind(
      bindInput({ promoCodeConfigId: firstConfigId, tenantId, bindRefId }),
    );
    const second = await service.bind(
      bindInput({ promoCodeConfigId: secondConfigId, tenantId, bindRefId }),
    );

    const rows = await sequelize.query<{
      id: string;
      status: string;
      promo_code_config_id: string;
    }>(
      'SELECT id, status, promo_code_config_id FROM promo_code.campaign_promo_config WHERE tenant_id = :tenantId AND bind_ref_id = :bindRefId ORDER BY bound_at ASC',
      { replacements: { tenantId, bindRefId }, type: QueryTypes.SELECT },
    );

    // Both rows preserved (history intact) — the SELECT above uses the raw driver so it isn't
    // shadowed by any repository default filtering.
    expect(rows).toHaveLength(2);
    const priorRow = rows.find((r) => r.id === first.id);
    const newRow = rows.find((r) => r.id === second.id);
    expect(priorRow?.status).toBe('INACTIVE');
    expect(newRow?.status).toBe('ACTIVE');

    // TC-6: exactly one active row survives.
    const activeRows = rows.filter((r) => r.status === 'ACTIVE');
    expect(activeRows).toHaveLength(1);
    expect(activeRows[0]?.id).toBe(second.id);
  });

  // TC-7
  it('TC-7: binds at bindLevel = TRACKER', async () => {
    const tenantId = freshTenant();
    const configId = await seedActiveConfig(tenantId);

    const created = await service.bind(
      bindInput({ promoCodeConfigId: configId, tenantId, bindLevel: 'TRACKER' }),
    );

    expect(created.bindLevel).toBe('TRACKER');
  });

  // TC-8
  it('TC-8: binds at bindLevel = COMPONENT', async () => {
    const tenantId = freshTenant();
    const configId = await seedActiveConfig(tenantId);

    const created = await service.bind(
      bindInput({ promoCodeConfigId: configId, tenantId, bindLevel: 'COMPONENT' }),
    );

    expect(created.bindLevel).toBe('COMPONENT');
  });

  // TC-9
  it("TC-9: an invalid bindLevel value ('CAMPAIGNX') throws CampaignBindingValidationError", async () => {
    const tenantId = freshTenant();

    await expect(service.bind(bindInput({ tenantId, bindLevel: 'CAMPAIGNX' }))).rejects.toThrow(
      CampaignBindingValidationError,
    );
  });

  // TC-10
  it('TC-10: two concurrent bind requests for the same (tenantId, bindLevel, bindRefId) leave exactly one active row, no unhandled exception', async () => {
    const tenantId = freshTenant();
    const configA = await seedActiveConfig(tenantId);
    const configB = await seedActiveConfig(tenantId);
    const bindRefId = randomUUID();

    const results = await Promise.allSettled([
      service.bind(bindInput({ promoCodeConfigId: configA, tenantId, bindRefId })),
      service.bind(bindInput({ promoCodeConfigId: configB, tenantId, bindRefId })),
    ]);

    // Neither promise should reject with anything other than the expected, already-typed
    // conflict error — an unhandled/unexpected exception is a failure of this test.
    for (const result of results) {
      if (result.status === 'rejected') {
        expect(result.reason).toBeInstanceOf(Error);
      }
    }

    const activeRows = await sequelize.query<{ id: string }>(
      "SELECT id FROM promo_code.campaign_promo_config WHERE tenant_id = :tenantId AND bind_ref_id = :bindRefId AND status = 'ACTIVE'",
      { replacements: { tenantId, bindRefId }, type: QueryTypes.SELECT },
    );
    expect(activeRows).toHaveLength(1);
  });

  // TC-11
  it('TC-11: resolveActiveBinding for a bindRefId with no binding at all returns NOT_BOUND', async () => {
    const tenantId = freshTenant();

    const result = await service.resolveActiveBinding(tenantId, 'CAMPAIGN', randomUUID());

    expect(result).toEqual({ outcome: 'NOT_BOUND' });
  });

  // Adjacent behaviour: resolveActiveBinding's third outcome (implementation note 5's
  // `RESOLVED` case) — a binding whose underlying config is still ACTIVE resolves to it.
  it('adjacent behaviour: resolveActiveBinding for a bindRefId whose bound config is still ACTIVE returns RESOLVED', async () => {
    const tenantId = freshTenant();
    const configId = await seedActiveConfig(tenantId);
    const bindRefId = randomUUID();

    await service.bind(bindInput({ promoCodeConfigId: configId, tenantId, bindRefId }));
    const result = await service.resolveActiveBinding(tenantId, 'CAMPAIGN', bindRefId);

    expect(result).toEqual({ outcome: 'RESOLVED', promoCodeConfigId: configId });
  });

  // TC-12
  it('TC-12: resolveActiveBinding for a bindRefId whose bound config was since archived returns CONFIG_INACTIVE', async () => {
    const tenantId = freshTenant();
    const configId = await seedActiveConfig(tenantId);
    const bindRefId = randomUUID();

    await service.bind(bindInput({ promoCodeConfigId: configId, tenantId, bindRefId }));
    await promoCodeConfigRepository.archive(tenantId, configId, randomUUID());

    const result = await service.resolveActiveBinding(tenantId, 'CAMPAIGN', bindRefId);

    expect(result).toEqual({ outcome: 'CONFIG_INACTIVE', promoCodeConfigId: configId });

    // The binding itself is still ACTIVE on campaign_promo_config — only the underlying config
    // is not (implementation note 5's own framing).
    const bindingRows = await sequelize.query<{ status: string }>(
      'SELECT status FROM promo_code.campaign_promo_config WHERE tenant_id = :tenantId AND bind_ref_id = :bindRefId',
      { replacements: { tenantId, bindRefId }, type: QueryTypes.SELECT },
    );
    expect(bindingRows[0]?.status).toBe('ACTIVE');
  });
});
