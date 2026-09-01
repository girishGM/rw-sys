/**
 * T-PC-021. `PromoCodeGenerationService.generateCode` — idempotency, binding resolution,
 * transactional insert (`promo_code` + `promo_code_outbox`), concurrency races and the
 * reward-value/expiry snapshot, run against the real Postgres 16 server (root `CLAUDE.md`) as the
 * real `promo_code_app` role — same real-DB convention `campaign-binding.service.spec.ts`
 * (T-PC-012) already established, per `AGENT-PROTOCOL.md` §3 ("assert the observable property,
 * not the implementation string").
 *
 * TC-1..4, TC-7..14, TC-16, TC-17 live here. The deterministic collision-retry/exhaustion branch
 * (TC-5, TC-6, TC-15) and the deterministic correlation-conflict-race branch live in
 * `promo-code-generation.service.retry.spec.ts` instead — same reasoning
 * `campaign-binding.service.retry.spec.ts`'s own header already gives: a real `23505` race is
 * inherently non-deterministic, so a mocked repository is the only way to *guarantee* every
 * branch is actually exercised on every run (Verification step 3's "100% on the
 * idempotency/retry/transaction branches"). TC-18 (the full bind → generate → idempotent
 * re-generate → snapshot-immutability round trip against a real migrated DB, booting the full
 * `AppModule`) lives in `promo-code-generation.e2e-spec.ts`.
 *
 * Deviation from the task file's literal test path (`test/modules/generation/
 * promo-code-generation.service.spec.ts` is actually followed here verbatim — but note the
 * broader deviation from `project.config.json`'s literal `test/generation/**` grant, matching the
 * precedent T-PC-020 already established (`test/modules/generation/code-generator.spec.ts`) and
 * accepted on review: the task file's own "Files owned" path wins.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';
import { createAppTestConnection } from '../../config/support/app-connection';
import { PromoCodeConfigRepository } from '@/modules/promo-code-config/promo-code-config.repository';
import { PromoCodeConfigAuditRepository } from '@/modules/promo-code-config/promo-code-config-audit.repository';
import { PromoCodeConfigService } from '@/modules/promo-code-config/promo-code-config.service';
import { CampaignBindingRepository } from '@/modules/campaign-binding/campaign-binding.repository';
import { CampaignBindingService } from '@/modules/campaign-binding/campaign-binding.service';
import { CodeGenerator } from '@/modules/generation/code-generator';
import { PromoCodeRepository } from '@/modules/generation/promo-code.repository';
import { PromoCodeGenerationService } from '@/modules/generation/promo-code-generation.service';
import { DEFAULT_GENERATION_MAX_RETRY_ATTEMPTS } from '@/modules/generation/promo-code-generation.constants';
import type { GenerationResult } from '@/modules/generation/generation-result.types';

describe('T-PC-021 — PromoCodeGenerationService', () => {
  let sequelize: Sequelize;
  let promoCodeConfigRepository: PromoCodeConfigRepository;
  let promoCodeConfigService: PromoCodeConfigService;
  let bindingRepository: CampaignBindingRepository;
  let bindingService: CampaignBindingService;
  let promoCodeRepository: PromoCodeRepository;
  let service: PromoCodeGenerationService;
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
    bindingService = new CampaignBindingService(
      bindingRepository,
      promoCodeConfigService,
      sequelize,
    );
    promoCodeRepository = new PromoCodeRepository(sequelize);
    service = new PromoCodeGenerationService(
      promoCodeRepository,
      bindingService,
      promoCodeConfigService,
      new CodeGenerator(),
      sequelize,
      DEFAULT_GENERATION_MAX_RETRY_ATTEMPTS,
    );
  });

  afterAll(async () => {
    for (const tenantId of tenantIds) {
      await sequelize.query(
        `DELETE FROM promo_code.promo_code_outbox
           WHERE promo_code_id IN (SELECT id FROM promo_code.promo_code WHERE tenant_id = :tenantId)`,
        { replacements: { tenantId } },
      );
      await sequelize.query('DELETE FROM promo_code.promo_code WHERE tenant_id = :tenantId', {
        replacements: { tenantId },
      });
      await sequelize.query(
        'DELETE FROM promo_code.campaign_promo_config WHERE tenant_id = :tenantId',
        { replacements: { tenantId } },
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

  async function seedActiveConfig(
    tenantId: string,
    overrides: Partial<{
      rewardValue: number;
      codeExpiryDays: number | null;
      codeLength: number;
    }> = {},
  ): Promise<string> {
    const config = await promoCodeConfigRepository.create(tenantId, {
      merchantId: null,
      name: `t-pc-021 config ${randomUUID()}`,
      codePrefix: null,
      codePostfix: null,
      codeLength: overrides.codeLength ?? 12,
      characterSet: 'ALPHANUMERIC',
      excludeAmbiguousChars: true,
      rewardValueType: 'FIXED_AMOUNT',
      rewardValue: overrides.rewardValue ?? 10,
      rewardUnit: 'USD',
      maxRedemptionsPerCode: 1,
      codeExpiryDays: overrides.codeExpiryDays ?? null,
      createdBy: randomUUID(),
    });
    return config.id;
  }

  async function bindConfig(
    tenantId: string,
    promoCodeConfigId: string,
    bindLevel: 'CAMPAIGN' | 'TRACKER' | 'COMPONENT' = 'CAMPAIGN',
  ): Promise<string> {
    const bindRefId = randomUUID();
    await bindingService.bind({
      promoCodeConfigId,
      tenantId,
      bindLevel,
      bindRefId,
      boundBy: randomUUID(),
    });
    return bindRefId;
  }

  function generateInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      correlationId: randomUUID(),
      tenantId: randomUUID(),
      bindLevel: 'CAMPAIGN',
      bindRefId: randomUUID(),
      customerId: 'cust_8213',
      merchantId: null,
      transport: 'GRPC',
      activityContext: null,
      ...overrides,
    };
  }

  async function fetchPromoCodeRow(id: string): Promise<Record<string, unknown> | undefined> {
    const rows = await sequelize.query<Record<string, unknown>>(
      'SELECT * FROM promo_code.promo_code WHERE id = :id',
      { replacements: { id }, type: QueryTypes.SELECT },
    );
    return rows[0];
  }

  async function fetchOutboxRows(promoCodeId: string): Promise<Array<Record<string, unknown>>> {
    return sequelize.query<Record<string, unknown>>(
      'SELECT * FROM promo_code.promo_code_outbox WHERE promo_code_id = :promoCodeId',
      { replacements: { promoCodeId }, type: QueryTypes.SELECT },
    );
  }

  // TC-1
  it('TC-1: generates a code for a bindRefId with an active, resolvable binding', async () => {
    const tenantId = freshTenant();
    const configId = await seedActiveConfig(tenantId);
    const bindRefId = await bindConfig(tenantId, configId);

    const result = await service.generateCode(
      generateInput({ tenantId, bindRefId, correlationId: randomUUID() }),
    );

    expect(result.status).toBe('SUCCESS');
    const success = result as Extract<GenerationResult, { status: 'SUCCESS' }>;
    expect(success.code).toBeTruthy();
    const row = await fetchPromoCodeRow(success.promoCodeId);
    expect(row?.promo_code_config_id).toBe(configId);
    expect(row?.reward_value_type).toBe('FIXED_AMOUNT');
    expect(row?.reward_value).toBe('10.0000');
    expect(row?.reward_unit).toBe('USD');
  });

  // TC-2
  it('TC-2: generating for a bindRefId with no binding at all returns CONFIG_NOT_BOUND', async () => {
    const tenantId = freshTenant();

    const result = await service.generateCode(generateInput({ tenantId, bindRefId: randomUUID() }));

    expect(result.status).toBe('FAILED');
    expect(result.errorCode).toBe('CONFIG_NOT_BOUND');
  });

  // TC-3
  it('TC-3: generating for a bindRefId whose binding points to an ARCHIVED config returns CONFIG_INACTIVE', async () => {
    const tenantId = freshTenant();
    const configId = await seedActiveConfig(tenantId);
    const bindRefId = await bindConfig(tenantId, configId);
    await promoCodeConfigRepository.archive(tenantId, configId, randomUUID());

    const result = await service.generateCode(generateInput({ tenantId, bindRefId }));

    expect(result.status).toBe('FAILED');
    expect(result.errorCode).toBe('CONFIG_INACTIVE');
  });

  // TC-4
  it('TC-4: generating twice with the same correlationId returns the exact same promoCodeId/code, no second row', async () => {
    const tenantId = freshTenant();
    const configId = await seedActiveConfig(tenantId);
    const bindRefId = await bindConfig(tenantId, configId);
    const correlationId = randomUUID();

    const first = await service.generateCode(generateInput({ tenantId, bindRefId, correlationId }));
    const second = await service.generateCode(
      generateInput({ tenantId, bindRefId, correlationId }),
    );

    expect(first.status).toBe('SUCCESS');
    expect(second).toEqual(first);

    const rows = await sequelize.query(
      'SELECT id FROM promo_code.promo_code WHERE tenant_id = :tenantId AND correlation_id = :correlationId',
      { replacements: { tenantId, correlationId }, type: QueryTypes.SELECT },
    );
    expect(rows).toHaveLength(1);
  });

  // TC-7
  it('TC-7: generating with transport=KAFKA on success inserts a PENDING promo_code_outbox row in the same transaction', async () => {
    const tenantId = freshTenant();
    const configId = await seedActiveConfig(tenantId);
    const bindRefId = await bindConfig(tenantId, configId);

    const result = await service.generateCode(
      generateInput({ tenantId, bindRefId, transport: 'KAFKA', correlationId: randomUUID() }),
    );

    expect(result.status).toBe('SUCCESS');
    const success = result as Extract<GenerationResult, { status: 'SUCCESS' }>;
    const outboxRows = await fetchOutboxRows(success.promoCodeId);
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]?.status).toBe('PENDING');
    expect(outboxRows[0]?.topic).toBe('promo-code.generate.result.v1');
    expect((outboxRows[0]?.payload as { status: string }).status).toBe('SUCCESS');
  });

  // TC-8
  it('TC-8: generating with transport=GRPC on success inserts no promo_code_outbox row', async () => {
    const tenantId = freshTenant();
    const configId = await seedActiveConfig(tenantId);
    const bindRefId = await bindConfig(tenantId, configId);

    const result = await service.generateCode(
      generateInput({ tenantId, bindRefId, transport: 'GRPC', correlationId: randomUUID() }),
    );

    expect(result.status).toBe('SUCCESS');
    const success = result as Extract<GenerationResult, { status: 'SUCCESS' }>;
    const outboxRows = await fetchOutboxRows(success.promoCodeId);
    expect(outboxRows).toHaveLength(0);
  });

  // TC-9
  it('TC-9: an outbox insert failure after the promo_code insert succeeds rolls back the entire transaction', async () => {
    const tenantId = freshTenant();
    const configId = await seedActiveConfig(tenantId);
    const bindRefId = await bindConfig(tenantId, configId);
    const correlationId = randomUUID();

    const spy = jest
      .spyOn(promoCodeRepository, 'createOutboxRow')
      .mockRejectedValueOnce(new Error('simulated outbox insert failure'));

    await expect(
      service.generateCode(
        generateInput({ tenantId, bindRefId, transport: 'KAFKA', correlationId }),
      ),
    ).rejects.toThrow('simulated outbox insert failure');

    const rows = await sequelize.query(
      'SELECT id FROM promo_code.promo_code WHERE tenant_id = :tenantId AND correlation_id = :correlationId',
      { replacements: { tenantId, correlationId }, type: QueryTypes.SELECT },
    );
    expect(rows).toHaveLength(0);

    spy.mockRestore();
  });

  // TC-10
  it("TC-10: generating with bindLevel='INVALID' returns INVALID_REQUEST, never resolves a binding", async () => {
    const tenantId = freshTenant();
    const resolveSpy = jest.spyOn(bindingService, 'resolveActiveBinding');

    const result = await service.generateCode(generateInput({ tenantId, bindLevel: 'INVALID' }));

    expect(result.status).toBe('FAILED');
    expect(result.errorCode).toBe('INVALID_REQUEST');
    expect(resolveSpy).not.toHaveBeenCalled();
    resolveSpy.mockRestore();
  });

  // TC-11
  it('TC-11: generating with a missing customerId returns INVALID_REQUEST', async () => {
    const input = generateInput();
    delete (input as Record<string, unknown>).customerId;

    const result = await service.generateCode(input);

    expect(result.status).toBe('FAILED');
    expect(result.errorCode).toBe('INVALID_REQUEST');
  });

  // Adjacent to TC-10/TC-11: an invalid transport value is caught by the same defensive
  // validation, never a value the two real transports (KAFKA/GRPC) would ever construct.
  it("adjacent behaviour: generating with transport='SFTP' returns INVALID_REQUEST", async () => {
    const result = await service.generateCode(generateInput({ transport: 'SFTP' }));

    expect(result.status).toBe('FAILED');
    expect(result.errorCode).toBe('INVALID_REQUEST');
  });

  // T-PC-046 regression (TC-3): a customerId over the DB's `varchar(120)` bound
  // (`promo_code.promo_code.customer_id`) must be rejected by structural validation as a clean
  // INVALID_REQUEST, before any DB work — never reach the insert and surface as a raw, unmapped
  // pg driver error (22001, "value too long for type character varying(120)"), which is neither
  // `isCodeCollision()` nor `isCorrelationConflict()` and would otherwise rethrow uncaught out of
  // `generateWithRetry`/`generateCode` (a gRPC `UNKNOWN` instead of `INVALID_REQUEST` over gRPC;
  // three wasted retries then a DLQ landing over Kafka). Proven to fail on the unfixed schema:
  // reverting `generation-request.types.ts`'s `.max(120, ...)` on `customerId` makes this test
  // throw the raw pg 22001 error instead of returning `FAILED`/`INVALID_REQUEST`.
  it('T-PC-046: generating with a customerId over 120 characters returns INVALID_REQUEST, never reaches the DB', async () => {
    const tenantId = freshTenant();
    const configId = await seedActiveConfig(tenantId);
    const bindRefId = await bindConfig(tenantId, configId);
    const correlationId = randomUUID();

    const result = await service.generateCode(
      generateInput({ tenantId, bindRefId, correlationId, customerId: 'x'.repeat(500) }),
    );

    expect(result.status).toBe('FAILED');
    expect(result.errorCode).toBe('INVALID_REQUEST');

    const rows = await sequelize.query(
      'SELECT id FROM promo_code.promo_code WHERE tenant_id = :tenantId AND correlation_id = :correlationId',
      { replacements: { tenantId, correlationId }, type: QueryTypes.SELECT },
    );
    expect(rows).toHaveLength(0);
  });

  // Adjacent to T-PC-046: exactly 120 characters is the DB column's own bound, not one past it —
  // must still succeed, proving the fix didn't over-tighten past the actual column width.
  it('T-PC-046 adjacent: a customerId of exactly 120 characters (the DB column bound) still succeeds', async () => {
    const tenantId = freshTenant();
    const configId = await seedActiveConfig(tenantId);
    const bindRefId = await bindConfig(tenantId, configId);

    const result = await service.generateCode(
      generateInput({
        tenantId,
        bindRefId,
        correlationId: randomUUID(),
        customerId: 'x'.repeat(120),
      }),
    );

    expect(result.status).toBe('SUCCESS');
  });

  // TC-12
  it('TC-12: two concurrent generate calls with different correlationIds, same binding, both succeed with distinct codes', async () => {
    const tenantId = freshTenant();
    const configId = await seedActiveConfig(tenantId);
    const bindRefId = await bindConfig(tenantId, configId);

    const [first, second] = await Promise.all([
      service.generateCode(generateInput({ tenantId, bindRefId, correlationId: randomUUID() })),
      service.generateCode(generateInput({ tenantId, bindRefId, correlationId: randomUUID() })),
    ]);

    expect(first.status).toBe('SUCCESS');
    expect(second.status).toBe('SUCCESS');
    const firstSuccess = first as Extract<GenerationResult, { status: 'SUCCESS' }>;
    const secondSuccess = second as Extract<GenerationResult, { status: 'SUCCESS' }>;
    expect(firstSuccess.promoCodeId).not.toBe(secondSuccess.promoCodeId);
    expect(firstSuccess.code).not.toBe(secondSuccess.code);
  });

  // TC-13
  it('TC-13: two concurrent generate calls with the same correlationId commit exactly one row; the other observes it', async () => {
    const tenantId = freshTenant();
    const configId = await seedActiveConfig(tenantId);
    const bindRefId = await bindConfig(tenantId, configId);
    const correlationId = randomUUID();

    const [first, second] = await Promise.all([
      service.generateCode(generateInput({ tenantId, bindRefId, correlationId })),
      service.generateCode(generateInput({ tenantId, bindRefId, correlationId })),
    ]);

    expect(first.status).toBe('SUCCESS');
    expect(second.status).toBe('SUCCESS');
    const firstSuccess = first as Extract<GenerationResult, { status: 'SUCCESS' }>;
    const secondSuccess = second as Extract<GenerationResult, { status: 'SUCCESS' }>;
    expect(firstSuccess.promoCodeId).toBe(secondSuccess.promoCodeId);
    expect(firstSuccess.code).toBe(secondSuccess.code);

    const rows = await sequelize.query(
      'SELECT id FROM promo_code.promo_code WHERE tenant_id = :tenantId AND correlation_id = :correlationId',
      { replacements: { tenantId, correlationId }, type: QueryTypes.SELECT },
    );
    expect(rows).toHaveLength(1);
  });

  // TC-14
  it("TC-14: the issued row's reward_value is unaffected by a later config update (snapshot immutability)", async () => {
    const tenantId = freshTenant();
    const configId = await seedActiveConfig(tenantId, { rewardValue: 10 });
    const bindRefId = await bindConfig(tenantId, configId);

    const result = await service.generateCode(
      generateInput({ tenantId, bindRefId, correlationId: randomUUID() }),
    );
    expect(result.status).toBe('SUCCESS');
    const success = result as Extract<GenerationResult, { status: 'SUCCESS' }>;

    await promoCodeConfigService.update(tenantId, configId, { rewardValue: 99 }, randomUUID());

    const row = await fetchPromoCodeRow(success.promoCodeId);
    expect(row?.reward_value).toBe('10.0000');
  });

  // TC-16
  it('TC-16: expires_at is computed from promo_code_config.code_expiry_days when set', async () => {
    const tenantId = freshTenant();
    const configId = await seedActiveConfig(tenantId, { codeExpiryDays: 30 });
    const bindRefId = await bindConfig(tenantId, configId);

    const result = await service.generateCode(
      generateInput({ tenantId, bindRefId, correlationId: randomUUID() }),
    );
    expect(result.status).toBe('SUCCESS');
    const success = result as Extract<GenerationResult, { status: 'SUCCESS' }>;

    const row = await fetchPromoCodeRow(success.promoCodeId);
    const issuedAt = new Date(row?.issued_at as string).getTime();
    const expiresAt = new Date(row?.expires_at as string).getTime();
    expect(expiresAt - issuedAt).toBe(30 * 24 * 60 * 60 * 1000);
  });

  // TC-17
  it('TC-17: expires_at is null when code_expiry_days is NULL', async () => {
    const tenantId = freshTenant();
    const configId = await seedActiveConfig(tenantId, { codeExpiryDays: null });
    const bindRefId = await bindConfig(tenantId, configId);

    const result = await service.generateCode(
      generateInput({ tenantId, bindRefId, correlationId: randomUUID() }),
    );
    expect(result.status).toBe('SUCCESS');
    const success = result as Extract<GenerationResult, { status: 'SUCCESS' }>;

    expect(success.expiresAt).toBeNull();
    const row = await fetchPromoCodeRow(success.promoCodeId);
    expect(row?.expires_at).toBeNull();
  });
});
