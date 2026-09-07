/**
 * T-PC-058. `PromoCodeConfigVersionRepository` — scoped-query, lifecycle-transition, and
 * typed-conflict-error behaviour, run against the real Postgres 16 server (root `CLAUDE.md`),
 * connected as the real `promo_code_app` role, same real-DB convention every other spec in this
 * module already established. Also covers `PromoCodeConfigRepository.listSummaries`'s own
 * "excludes a config with no published version" behaviour — the query that joins the two tables
 * together for `04-API-CONTRACT.md` §1.
 *
 * Service/controller-level version-lifecycle coverage (create-opens-draft, PATCH-needs-open-draft,
 * publish demotes the prior published version, `DraftAlreadyExistsError`/`VersionNotFoundError`/
 * `VersionNotDraftError`) lives in `promo-code-config.service.spec.ts`/`promo-code-config.
 * controller.spec.ts` instead — this file is the one level down, proving the repository's own SQL
 * does what the service assumes it does.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { Sequelize } from 'sequelize-typescript';
import { createAppTestConnection } from './support/app-connection';
import { PromoCodeConfigRepository } from '@/modules/promo-code-config/promo-code-config.repository';
import {
  PromoCodeConfigVersionRepository,
  type CreatePromoCodeConfigVersionData,
} from '@/modules/promo-code-config/promo-code-config-version.repository';
import { DraftAlreadyExistsError } from '@/modules/promo-code-config/promo-code-config.errors';

const ACTOR_ID = randomUUID();

function baseVersionData(
  overrides: Partial<CreatePromoCodeConfigVersionData> = {},
): CreatePromoCodeConfigVersionData {
  return {
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
    createdBy: ACTOR_ID,
    ...overrides,
  };
}

describe('T-PC-058 — PromoCodeConfigVersionRepository', () => {
  let sequelize: Sequelize;
  let configRepository: PromoCodeConfigRepository;
  let versionRepository: PromoCodeConfigVersionRepository;
  const tenantIds: string[] = [];

  beforeAll(async () => {
    sequelize = createAppTestConnection();
    await sequelize.authenticate();
    configRepository = new PromoCodeConfigRepository(sequelize);
    versionRepository = new PromoCodeConfigVersionRepository(sequelize);
  });

  afterAll(async () => {
    // Never deletes `promo_code_config_version` rows directly — every `published`/`deprecated`
    // row this file creates is rejected by `trg_promo_code_config_version_undeletable` (migration
    // `T-PC-058_002`) by design; only the still-`draft` rows a given `it` never published could be
    // deleted, and even those cascade-clean via the parent `promo_code_config` delete below being
    // unnecessary — `promo_code_config` itself is left in place (still referenced by its own
    // version rows), same precedent `test/modules/generation/promo-code-generation-version.spec.ts`
    // (T-PC-060) already established for this exact FK/immutability shape.
    for (const tenantId of tenantIds) {
      await sequelize.query(
        `DELETE FROM promo_code.promo_code_config_audit
           WHERE promo_code_config_id IN (
             SELECT id FROM promo_code.promo_code_config WHERE tenant_id = :tenantId
           )`,
        { replacements: { tenantId } },
      );
      // Childless-only: a config this file created but never gave a version (e.g. the
      // wrong-tenant `createDraft` case) has nothing blocking its own deletion — cleaned up here
      // so it doesn't linger as a permanent false positive for `test/database/promo-code-config-
      // version.migration.spec.ts`'s own "every config has at least one version" regression guard
      // (T-PC-059). A config that *does* have a version child is left in place either way (the FK/
      // trigger above already prevent that).
      await sequelize.query(
        `DELETE FROM promo_code.promo_code_config c
           WHERE c.tenant_id = :tenantId
             AND NOT EXISTS (
               SELECT 1 FROM promo_code.promo_code_config_version v
                WHERE v.promo_code_config_id = c.id
             )`,
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

  async function freshConfigId(tenantId: string): Promise<string> {
    const config = await configRepository.create(tenantId, {
      merchantId: null,
      name: `t-pc-058 version ${randomUUID()}`,
      createdBy: ACTOR_ID,
    });
    return config.id;
  }

  it('createDraft opens version_no=1 with status draft and no supersedes_version_id when nothing is published yet', async () => {
    const tenantId = freshTenant();
    const configId = await freshConfigId(tenantId);

    const draft = await versionRepository.createDraft(tenantId, configId, baseVersionData());

    expect(draft?.versionNo).toBe(1);
    expect(draft?.status).toBe('draft');
    expect(draft?.supersedesVersionId).toBeNull();
  });

  it('createDraft scoped to a tenant that does not own the config returns null, never inserts', async () => {
    const ownerTenant = freshTenant();
    const otherTenant = freshTenant();
    const configId = await freshConfigId(ownerTenant);

    const result = await versionRepository.createDraft(otherTenant, configId, baseVersionData());
    expect(result).toBeNull();
  });

  it('createDraft while one is already open rejects with DraftAlreadyExistsError, not a raw driver error', async () => {
    const tenantId = freshTenant();
    const configId = await freshConfigId(tenantId);
    await versionRepository.createDraft(tenantId, configId, baseVersionData());

    let caught: unknown;
    try {
      await versionRepository.createDraft(tenantId, configId, baseVersionData());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DraftAlreadyExistsError);
  });

  it('updateDraft edits the open draft; a no-op call (empty data) returns it unchanged', async () => {
    const tenantId = freshTenant();
    const configId = await freshConfigId(tenantId);
    await versionRepository.createDraft(tenantId, configId, baseVersionData({ rewardValue: 10 }));

    const updated = await versionRepository.updateDraft(tenantId, configId, { rewardValue: 55 });
    expect(Number(updated?.rewardValue)).toBe(55);

    const passthrough = await versionRepository.updateDraft(tenantId, configId, {});
    expect(Number(passthrough?.rewardValue)).toBe(55);
  });

  it('findDraftForConfig/findPublishedForConfig each return null when no such version exists', async () => {
    const tenantId = freshTenant();
    const configId = await freshConfigId(tenantId);

    await expect(versionRepository.findDraftForConfig(tenantId, configId)).resolves.toBeNull();
    await expect(versionRepository.findPublishedForConfig(tenantId, configId)).resolves.toBeNull();
  });

  it('findById scoped to a tenant that does not own the version returns null', async () => {
    const ownerTenant = freshTenant();
    const otherTenant = freshTenant();
    const configId = await freshConfigId(ownerTenant);
    const draft = await versionRepository.createDraft(ownerTenant, configId, baseVersionData());

    await expect(versionRepository.findById(otherTenant, draft!.id)).resolves.toBeNull();
    await expect(versionRepository.findById(ownerTenant, draft!.id)).resolves.toMatchObject({
      id: draft!.id,
    });
  });

  it('publish transitions draft -> published; a second draft, once published, demotes the first to deprecated', async () => {
    const tenantId = freshTenant();
    const configId = await freshConfigId(tenantId);
    const v1 = await versionRepository.createDraft(tenantId, configId, baseVersionData());

    const firstPublish = await versionRepository.publish(tenantId, configId, v1!.id, ACTOR_ID);
    expect(firstPublish.outcome).toBe('PUBLISHED');
    if (firstPublish.outcome !== 'PUBLISHED') throw new Error('expected PUBLISHED');
    expect(firstPublish.version.status).toBe('published');
    expect(firstPublish.version.publishedBy).toBe(ACTOR_ID);

    const v2 = await versionRepository.createDraft(
      tenantId,
      configId,
      baseVersionData({ rewardValue: 20 }),
    );
    expect(v2?.supersedesVersionId).toBe(v1!.id);

    const secondPublish = await versionRepository.publish(tenantId, configId, v2!.id, ACTOR_ID);
    expect(secondPublish.outcome).toBe('PUBLISHED');
    if (secondPublish.outcome !== 'PUBLISHED') throw new Error('expected PUBLISHED');
    expect(secondPublish.version.versionNo).toBe(2);

    const v1AfterDemotion = await versionRepository.findById(tenantId, v1!.id);
    expect(v1AfterDemotion?.status).toBe('deprecated');
    expect(v1AfterDemotion?.deprecatedAt).not.toBeNull();

    const currentlyPublished = await versionRepository.findPublishedForConfig(tenantId, configId);
    expect(currentlyPublished?.id).toBe(v2!.id);
  });

  it('publish with a versionId that does not exist for this (tenant, config) returns NOT_FOUND', async () => {
    const tenantId = freshTenant();
    const configId = await freshConfigId(tenantId);

    const result = await versionRepository.publish(tenantId, configId, randomUUID(), ACTOR_ID);
    expect(result.outcome).toBe('NOT_FOUND');
  });

  it('publish with a versionId belonging to a different config returns NOT_FOUND, never cross-config', async () => {
    const tenantId = freshTenant();
    const configA = await freshConfigId(tenantId);
    const configB = await freshConfigId(tenantId);
    const draftB = await versionRepository.createDraft(tenantId, configB, baseVersionData());

    const result = await versionRepository.publish(tenantId, configA, draftB!.id, ACTOR_ID);
    expect(result.outcome).toBe('NOT_FOUND');
  });

  it('publish on an already-published version returns NOT_DRAFT', async () => {
    const tenantId = freshTenant();
    const configId = await freshConfigId(tenantId);
    const v1 = await versionRepository.createDraft(tenantId, configId, baseVersionData());
    await versionRepository.publish(tenantId, configId, v1!.id, ACTOR_ID);

    const result = await versionRepository.publish(tenantId, configId, v1!.id, ACTOR_ID);
    expect(result.outcome).toBe('NOT_DRAFT');
  });

  // TC-5 (repository-level corroboration; the DB-trigger-level proof lives in
  // `test/database/promo-code-config-version.migration.spec.ts`, T-PC-059's own scope): once
  // published, a direct `updateDraft`-shaped write can never touch it — `updateDraft`'s own SQL
  // is scoped to `status = 'draft'`, so it silently matches zero rows instead of ever reaching the
  // DB trigger for the ordinary (non-`psql`) call path.
  it("updateDraft never touches a published version — it only ever matches status = 'draft'", async () => {
    const tenantId = freshTenant();
    const configId = await freshConfigId(tenantId);
    const v1 = await versionRepository.createDraft(
      tenantId,
      configId,
      baseVersionData({ rewardValue: 10 }),
    );
    await versionRepository.publish(tenantId, configId, v1!.id, ACTOR_ID);

    const result = await versionRepository.updateDraft(tenantId, configId, { rewardValue: 999 });
    expect(result).toBeNull();

    const stillOriginal = await versionRepository.findById(tenantId, v1!.id);
    expect(Number(stillOriginal?.rewardValue)).toBe(10);
  });

  // `04-API-CONTRACT.md` §1 — `listSummaries` excludes a config with no published version, and
  // includes one with a published version using that version's own payout fields.
  describe('PromoCodeConfigRepository.listSummaries', () => {
    it('excludes a config with only an open draft (no published version yet)', async () => {
      const tenantId = freshTenant();
      const configId = await freshConfigId(tenantId);
      await versionRepository.createDraft(tenantId, configId, baseVersionData());

      const results = await configRepository.listSummaries(tenantId);
      expect(results.map((r) => r.id)).not.toContain(configId);
    });

    it('includes a config with a published version, using that version’s own payout fields', async () => {
      const tenantId = freshTenant();
      const configId = await freshConfigId(tenantId);
      const draft = await versionRepository.createDraft(
        tenantId,
        configId,
        baseVersionData({ rewardValueType: 'PERCENTAGE', rewardValue: 15, rewardUnit: '%' }),
      );
      await versionRepository.publish(tenantId, configId, draft!.id, ACTOR_ID);

      const results = await configRepository.listSummaries(tenantId);
      const item = results.find((r) => r.id === configId);
      expect(item).toMatchObject({ rewardValueType: 'PERCENTAGE', rewardUnit: '%' });
      expect(Number(item?.rewardValue)).toBe(15);
    });

    it('reflects the currently published version, not a since-deprecated prior one', async () => {
      const tenantId = freshTenant();
      const configId = await freshConfigId(tenantId);
      const v1 = await versionRepository.createDraft(
        tenantId,
        configId,
        baseVersionData({ rewardValue: 10 }),
      );
      await versionRepository.publish(tenantId, configId, v1!.id, ACTOR_ID);
      const v2 = await versionRepository.createDraft(
        tenantId,
        configId,
        baseVersionData({ rewardValue: 25 }),
      );
      await versionRepository.publish(tenantId, configId, v2!.id, ACTOR_ID);

      const results = await configRepository.listSummaries(tenantId);
      const item = results.find((r) => r.id === configId);
      expect(Number(item?.rewardValue)).toBe(25);
    });
  });
});
