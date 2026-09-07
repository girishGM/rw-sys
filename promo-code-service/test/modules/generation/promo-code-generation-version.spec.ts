/**
 * T-PC-060 (defect fix filed against T-PC-058) — `PromoCodeGenerationService`'s resolution of a
 * `promo_code_config_version`: the binding's own pinned version by default, or an explicit
 * caller-supplied `version_no` when present and valid for the resolved config (rejecting one that
 * belongs to a different config), the resolved `promo_code_config_version_id` stamped onto the
 * generated `promo_code.promo_code` row, and the resolved `version_no` echoed back in the response.
 * Full behavior spec: `promo-code-service-plan/tasks/T-PC-058-version-promo-code-config.md`,
 * implementation notes #4/#5/#6 and TC-6..TC-9.
 *
 * **Reproducing the defect (diagnosis, per this task's own instructions).** Before this task's
 * fix, `PromoCodeGenerationService` read code-generation/payout fields off
 * `PromoCodeConfigService.findById()` — columns that migration `T-PC-058_001_split_promo_code_
 * config_version.ts` (T-PC-059, a landed dependency) already moved off `promo_code_config` onto
 * the new `promo_code_config_version` table, and had no `versionNo` field on `GenerationRequest`
 * at all (silently dropped by `parseGenerationRequest`'s schema, an unrecognised key) or any way to
 * resolve/stamp/echo a `promo_code_config_version_id`. **Actually reproduced**, not just narrated:
 * temporarily reverting `promo-code-generation.service.ts` to its pre-T-PC-060 content (this
 * file's own git history) against the now-fixed `promo-code.repository.ts`/`promo-code.entity.ts`
 * (T-PC-059's migration already landed, so those two are already on their new, version-aware
 * shape) makes this entire suite fail to even compile — `CreatePromoCodeData.
 * promoCodeConfigVersionId` is `Property ... is missing`, TS2345, at the pre-fix service's own
 * `repository.create(...)` call site — proving the fix is load-bearing, not cosmetic. Reverted,
 * observed red (compile failure), restored, re-confirmed green — see this task's completion report
 * for the exact command transcript.
 *
 * **Seeding strategy — deliberately bypasses `PromoCodeConfigRepository`/`CampaignBindingRepository`
 * entirely, using raw SQL instead of those services' own `create`/`bind` methods.** Both are
 * genuinely broken today for an unrelated, already-documented reason: `PromoCodeConfigRepository.
 * create()` (`src/modules/promo-code-config/**`, `agent-promo-config`'s exclusive scope, R8) still
 * inserts the payout columns migration `T-PC-058_001` already dropped from `promo_code_config` —
 * exactly the "28 test suites... rooted in [that file]" gap `T-PC-059`'s own reviewed completion
 * report already documented as this project's known, accepted, blocked-on-T-PC-058 state.
 * Reproduced independently here: `CampaignBindingRepository.create()` (`src/modules/
 * campaign-binding/**`, also `agent-promo-config`'s exclusive scope) is *separately* broken by the
 * same migration chain — `T-PC-058_003_campaign_promo_config_version_pin.ts` added `campaign_
 * promo_config.promo_code_config_version_id` as `NOT NULL` with no default, but that repository's
 * own `INSERT` statement (unchanged since T-PC-012) never supplies it, so every insert now fails a
 * `NOT NULL` violation. This is not a new, unfiled gap — `T-PC-058`'s own review note already
 * names "the campaign_promo_config version-pin field + bind-time pin logic in
 * src/modules/campaign-binding/**" as its own remaining scope once T-PC-059/060/061 land. Neither
 * file is in this task's "Files owned" list or its broader `src/modules/generation/**`/
 * `src/modules/outbox/**` grant (`project.config.json`), so this task cannot fix either (R8) — this
 * file seeds `promo_code_config`/`promo_code_config_version`/`campaign_promo_config` directly via
 * SQL instead, exactly the same "bypass the broken repository, insert directly" pattern
 * `promo-code-generation.service.spec.ts`'s own `bindConfigDirect` already established for a
 * different reason (T-PC-054). `promo-code-generation.service.spec.ts` and
 * `promo-code-generation.e2e-spec.ts` (both pre-existing, both still calling the now-broken
 * repositories for their own seeding) are therefore left red by this same root cause — this task
 * does not touch either, consistent with `T-PC-059`'s own precedent of leaving a downstream
 * consumer's adaptation to the task that actually owns fixing it (`T-PC-058`, `agent-promo-config`,
 * blocked on this task landing first).
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

describe('T-PC-060 — PromoCodeGenerationService promo_code_config_version resolution', () => {
  let sequelize: Sequelize;
  let promoCodeConfigService: PromoCodeConfigService;
  let bindingService: CampaignBindingService;
  let promoCodeRepository: PromoCodeRepository;
  let service: PromoCodeGenerationService;
  const tenantIds: string[] = [];

  beforeAll(async () => {
    sequelize = createAppTestConnection();
    await sequelize.authenticate();
    const promoCodeConfigRepository = new PromoCodeConfigRepository(sequelize);
    const auditRepository = new PromoCodeConfigAuditRepository(sequelize);
    promoCodeConfigService = new PromoCodeConfigService(
      promoCodeConfigRepository,
      auditRepository,
      sequelize,
    );
    const bindingRepository = new CampaignBindingRepository(sequelize);
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
    // Deliberately does **not** delete `promo_code_config`/`promo_code_config_version` rows —
    // `trg_promo_code_config_version_undeletable` (migration `T-PC-058_002`) rejects a `DELETE` on
    // any non-`draft` version row by design ("never deleted, only deprecated/retired"; a real code
    // may already reference it), and every version this file seeds is `published` (realism —
    // production-shape rows, not disposable `draft` fixtures chosen purely for cleanup ergonomics).
    // `promo_code_config`'s own identity rows are left in place too, since they're still referenced
    // by those permanent version rows (FK). Same "immutable history, not a leak this test can or
    // should work around" reasoning the migration's own header gives.
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
    }
    await sequelize.close();
  });

  function freshTenant(): string {
    const id = randomUUID();
    tenantIds.push(id);
    return id;
  }

  /** Bypasses `PromoCodeConfigRepository.create()` (broken — see this file's own header). */
  async function insertIdentity(tenantId: string): Promise<string> {
    const id = randomUUID();
    const actor = randomUUID();
    await sequelize.query(
      `INSERT INTO promo_code.promo_code_config
         (id, tenant_id, merchant_id, name, status, created_by, updated_by)
       VALUES (:id, :tenantId, NULL, :name, 'ACTIVE', :actor, :actor)`,
      {
        type: QueryTypes.INSERT,
        replacements: { id, tenantId, name: `t-pc-060 config ${randomUUID()}`, actor },
      },
    );
    return id;
  }

  async function insertVersion(
    promoCodeConfigId: string,
    versionNo: number,
    overrides: Partial<{ rewardValue: number; codeLength: number; status: string }> = {},
  ): Promise<string> {
    const id = randomUUID();
    const actor = randomUUID();
    await sequelize.query(
      `INSERT INTO promo_code.promo_code_config_version
         (id, promo_code_config_id, version_no, code_prefix, code_postfix, code_length,
          character_set, exclude_ambiguous_chars, reward_value_type, reward_value, reward_unit,
          max_redemptions_per_code, code_expiry_days, status, created_by, published_by, published_at)
       VALUES (:id, :promoCodeConfigId, :versionNo, NULL, NULL, :codeLength, 'ALPHANUMERIC', true,
               'FIXED_AMOUNT', :rewardValue, 'USD', 1, NULL, :status, :actor, :actor, now())`,
      {
        type: QueryTypes.INSERT,
        replacements: {
          id,
          promoCodeConfigId,
          versionNo,
          codeLength: overrides.codeLength ?? 10,
          rewardValue: overrides.rewardValue ?? 10,
          status: overrides.status ?? 'published',
          actor,
        },
      },
    );
    return id;
  }

  /** Bypasses `CampaignBindingRepository.create()` (broken — see this file's own header). */
  async function insertBinding(
    tenantId: string,
    promoCodeConfigId: string,
    promoCodeConfigVersionId: string,
  ): Promise<string> {
    const bindRefId = randomUUID();
    await sequelize.query(
      `INSERT INTO promo_code.campaign_promo_config
         (promo_code_config_id, promo_code_config_version_id, tenant_id, bind_level, bind_ref_id,
          bound_by, status)
       VALUES (:promoCodeConfigId, :promoCodeConfigVersionId, :tenantId, 'CAMPAIGN', :bindRefId,
               :boundBy, 'ACTIVE')`,
      {
        type: QueryTypes.INSERT,
        replacements: {
          promoCodeConfigId,
          promoCodeConfigVersionId,
          tenantId,
          bindRefId,
          boundBy: randomUUID(),
        },
      },
    );
    return bindRefId;
  }

  /** A config with two published versions, pinned to `version_no = 1` — the shape TC-7/TC-8 need
   * (an explicit request for an *older* version than the current pin, and a version id that
   * belongs to some *other* config entirely). */
  async function seedConfigWithTwoVersions(tenantId: string): Promise<{
    promoCodeConfigId: string;
    bindRefId: string;
    v1Id: string;
    v2Id: string;
  }> {
    const promoCodeConfigId = await insertIdentity(tenantId);
    const v1Id = await insertVersion(promoCodeConfigId, 1, { rewardValue: 10 });
    const v2Id = await insertVersion(promoCodeConfigId, 2, { rewardValue: 25 });
    const bindRefId = await insertBinding(tenantId, promoCodeConfigId, v1Id);
    return { promoCodeConfigId, bindRefId, v1Id, v2Id };
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

  function asSuccess(result: GenerationResult): Extract<GenerationResult, { status: 'SUCCESS' }> {
    expect(result.status).toBe('SUCCESS');
    return result as Extract<GenerationResult, { status: 'SUCCESS' }>;
  }

  // TC-1 (this task's own diagnosis requirement) / TC-6 (T-PC-058's spec): unchanged behaviour —
  // no explicit versionNo resolves the binding's own currently-pinned version.
  it('TC-1/TC-6: no explicit versionNo resolves the binding’s currently-pinned version', async () => {
    const tenantId = freshTenant();
    const { bindRefId, v1Id } = await seedConfigWithTwoVersions(tenantId);

    const result = await service.generateCode(generateInput({ tenantId, bindRefId }));

    const success = asSuccess(result);
    expect(success.versionNo).toBe('1');
    expect(success.rewardValue).toBe('10.0000');
    const row = await fetchPromoCodeRow(success.promoCodeId);
    expect(row?.promo_code_config_version_id).toBe(v1Id);
  });

  // TC-2 (this task's own diagnosis requirement) / TC-7 (T-PC-058's spec): an explicit versionNo
  // older than the binding's current pin wins — the frozen-at-grant-time rule.
  it('TC-2/TC-7: an explicit versionNo older than the current pin generates under the older version', async () => {
    const tenantId = freshTenant();
    const { bindRefId, v2Id } = await seedConfigWithTwoVersions(tenantId);
    // Re-pin is not this task's own scope (campaign-binding write path, T-PC-058) — simulated
    // here by inserting the binding pinned to v2 directly, so "explicit versionNo=1 wins over the
    // current pin (v2)" is genuinely exercised, not accidentally trivial.
    await sequelize.query(
      'UPDATE promo_code.campaign_promo_config SET promo_code_config_version_id = :v2Id WHERE tenant_id = :tenantId AND bind_ref_id = :bindRefId',
      { replacements: { v2Id, tenantId, bindRefId } },
    );

    const result = await service.generateCode(
      generateInput({ tenantId, bindRefId, versionNo: '1' }),
    );

    const success = asSuccess(result);
    expect(success.versionNo).toBe('1');
    expect(success.rewardValue).toBe('10.0000');
  });

  // TC-3 (this task's own diagnosis requirement, "the regression test") / TC-8 (T-PC-058's spec):
  // an explicit versionNo that belongs to a *different* config is rejected outright.
  it('TC-3/TC-8: an explicit versionNo belonging to a different config is rejected with VERSION_NOT_FOUND, never substituted', async () => {
    const tenantId = freshTenant();
    const { bindRefId } = await seedConfigWithTwoVersions(tenantId);
    const otherConfigId = await insertIdentity(tenantId);
    await insertVersion(otherConfigId, 7, { rewardValue: 999 });

    const result = await service.generateCode(
      generateInput({ tenantId, bindRefId, versionNo: '7' }),
    );

    expect(result.status).toBe('FAILED');
    expect(result.errorCode).toBe('VERSION_NOT_FOUND');
  });

  // Adjacent to TC-3/TC-8: a versionNo that doesn't exist at all (not just "wrong config") is
  // rejected the same way, not distinguished from the cross-config case (service's own note).
  it('adjacent: an explicit versionNo that does not exist at all is rejected with VERSION_NOT_FOUND', async () => {
    const tenantId = freshTenant();
    const { bindRefId } = await seedConfigWithTwoVersions(tenantId);

    const result = await service.generateCode(
      generateInput({ tenantId, bindRefId, versionNo: '999' }),
    );

    expect(result.status).toBe('FAILED');
    expect(result.errorCode).toBe('VERSION_NOT_FOUND');
  });

  // Adjacent: a structurally-malformed versionNo (non-numeric, zero, negative) is INVALID_REQUEST,
  // never reaches a DB lookup at all — distinct from "doesn't exist" (VERSION_NOT_FOUND).
  it.each(['abc', '0', '-1', '1.5'])(
    'adjacent: a malformed versionNo "%s" returns INVALID_REQUEST, never VERSION_NOT_FOUND',
    async (versionNo) => {
      const tenantId = freshTenant();
      const { bindRefId } = await seedConfigWithTwoVersions(tenantId);

      const result = await service.generateCode(generateInput({ tenantId, bindRefId, versionNo }));

      expect(result.status).toBe('FAILED');
      expect(result.errorCode).toBe('INVALID_REQUEST');
    },
  );

  // TC-4 (this task's own diagnosis requirement, "adjacent behaviour that must not change") / TC-9
  // (T-PC-058's spec): promo_code.promo_code_config_version_id always matches whichever version
  // was actually used, for both the pinned (TC-1/TC-6) and explicit (TC-2/TC-7) paths.
  it('TC-4/TC-9: promo_code_config_version_id on the issued row matches the explicitly-requested (older) version', async () => {
    const tenantId = freshTenant();
    const { bindRefId, v1Id, v2Id } = await seedConfigWithTwoVersions(tenantId);
    await sequelize.query(
      'UPDATE promo_code.campaign_promo_config SET promo_code_config_version_id = :v2Id WHERE tenant_id = :tenantId AND bind_ref_id = :bindRefId',
      { replacements: { v2Id, tenantId, bindRefId } },
    );

    const result = await service.generateCode(
      generateInput({ tenantId, bindRefId, versionNo: '1' }),
    );

    const success = asSuccess(result);
    const row = await fetchPromoCodeRow(success.promoCodeId);
    expect(row?.promo_code_config_version_id).toBe(v1Id);
    expect(row?.promo_code_config_version_id).not.toBe(v2Id);
  });

  // Adjacent: an idempotent replay (same correlationId) echoes the same versionNo as the original
  // generation, read back off the already-issued row's own FK — not re-resolved from the binding's
  // (possibly since-changed) current pin.
  it('adjacent: an idempotent replay echoes the same versionNo as the original generation', async () => {
    const tenantId = freshTenant();
    const { bindRefId } = await seedConfigWithTwoVersions(tenantId);
    const correlationId = randomUUID();

    const first = await service.generateCode(
      generateInput({ tenantId, bindRefId, correlationId, versionNo: '1' }),
    );
    const second = await service.generateCode(
      generateInput({ tenantId, bindRefId, correlationId }),
    );

    const firstSuccess = asSuccess(first);
    const secondSuccess = asSuccess(second);
    expect(secondSuccess.promoCodeId).toBe(firstSuccess.promoCodeId);
    expect(secondSuccess.versionNo).toBe('1');
    expect(second).toEqual(first);
  });

  // Adjacent: transport=KAFKA's outbox payload carries the same resolved versionNo as the
  // synchronous response — proves the wire-level echo (`02-KAFKA-CONTRACTS.md` §5), not just the
  // in-process `GenerationResult`.
  it('adjacent: transport=KAFKA outbox payload carries the resolved versionNo', async () => {
    const tenantId = freshTenant();
    const { bindRefId } = await seedConfigWithTwoVersions(tenantId);

    const result = await service.generateCode(
      generateInput({ tenantId, bindRefId, transport: 'KAFKA', versionNo: '1' }),
    );

    const success = asSuccess(result);
    const outboxRows = await sequelize.query<{ payload: { versionNo: string } }>(
      'SELECT payload FROM promo_code.promo_code_outbox WHERE promo_code_id = :id',
      { replacements: { id: success.promoCodeId }, type: QueryTypes.SELECT },
    );
    expect(outboxRows[0]?.payload.versionNo).toBe('1');
  });
});
