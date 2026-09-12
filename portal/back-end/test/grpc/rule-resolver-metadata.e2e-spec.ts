/**
 * T-175 — the four new `BoundRule` fields served out of the **real** database, through the real
 * `CampaignConfigService`, encoded with the real proto codec (verification step 2).
 *
 * ### Why this suite exists next to the unit one
 *
 * `rule-resolver-metadata.spec.ts` proves the assembly logic and the wire format in isolation, with
 * fixtures in memory. Neither of those can fail if the *query* is wrong — a model attribute whose
 * `field:` name does not match the column, a `reward_app` grant that was never issued, a scope
 * predicate that silently matches nothing. Those are claims about a running Postgres, so they are
 * asserted against one (AGENT-PROTOCOL §3). In particular, the model attribute → column mapping for
 * `tracker_component_rules.operator` and `rule_versions.resolver_id`/`resolver_config`/
 * `default_operators` is exercised **only** here: a wrong `field:` would leave every unit test
 * green and serve `''`/`0`/`''`/`[]` for every rule in production — indistinguishable, on the wire,
 * from "no resolver configured", which is precisely the reading T-RAP-064 must be able to trust.
 *
 * ### Why it assembles the service by hand rather than booting `AppModule`
 *
 * The same reasoning `reward-expiry-duration.e2e-spec.ts` (T-173) and
 * `activity-external-codes.e2e-spec.ts` (T-171) document: the six collaborators are directly
 * constructible, the mTLS socket and grant lookup are covered end to end by `grpc.e2e-spec.ts` and
 * are untouched by this task (no new RPC, no new section, no new grant shape), and booting
 * `AppModule` would require the suite-encryption-key fixture that has orphaned rows and broken
 * later suites twice in this project.
 *
 * ### Isolation
 *
 * Every fixture is prefixed `T175E2E` and removed in `afterAll`. Rule versions are left `draft` on
 * purpose — `trg_rule_versions_undeletable` (T005_007) refuses to delete a published one, and a
 * suite that needed a superuser connection to clean up after itself would be a worse trade than one
 * rule per scenario (`uq` one-draft-per-rule is per rule, so this is legal). Nothing the builder does
 * here depends on version status: a pin is read by id. The resolver row itself is the seeded
 * `SCHEDULE_CONTEXT` registry entry (T102_002) — looked up by code, never assumed to be id 5, so
 * the suite is honest on a database seeded in a different order from Render's.
 */
import 'reflect-metadata';
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { ScopedRepository } from '@/common/scope/scoped.repository';
import { ConfigSnapshotBuilder } from '@/grpc/config-snapshot.builder';
import { CampaignConfigService } from '@/grpc/campaign-config.service';
import { ServiceScopeGuard, type ResolvedServiceIdentity } from '@/grpc/service-scope.guard';
import { ChangeEventPublisher } from '@/grpc/change-event.publisher';
import { ServiceRateLimiter } from '@/grpc/rate-limit';
import { CONFIG_SECTION } from '@/grpc/grpc.constants';
import { decodeMessage, encodeMessage } from '@/grpc/wire/proto-codec';
import {
  CampaignConfigListMessage,
  CampaignConfigMessage,
} from '@/grpc/wire/campaign-config.messages';
import type { GrpcGrantsService } from '@/modules/access-control/grpc-grants.service';
import { buildAppSequelize } from '../database/build-app-sequelize';

const PREFIX = 'T175E2E';
const IDENTITY = `${PREFIX}-runtime.internal`;
const CAMPAIGN_CODE = `${PREFIX}_C1`;
/** Row set B of the T-RAP-063 diagnosis: pinned to a SCHEDULE_CONTEXT-wired version, operator set. */
const WIRED_RULE = `${PREFIX}_RULE_WINDOW`;
/** Row set A: no pinned version, no operator, config holding form defaults. */
const BARE_RULE = `${PREFIX}_RULE_VALUE`;
/** Pinned to a version that has NO resolver wired — the "configured but empty" boundary. */
const UNWIRED_RULE = `${PREFIX}_RULE_UNWIRED`;

const WINDOW_EXPRESSION = 'currentTime within the :windowType window';
const RESOLVER_CONFIG = { field: 'currentTime' };
const DEFAULT_OPERATORS = ['between', 'in', 'equals'];
const OPERATOR = 'between';

let db: Sequelize;
let service: CampaignConfigService;
let tenantId: number;
let campaignId: number;
let componentId: number;
let scheduleResolverId: number;
let wiredVersionId: number;

async function sql<T extends object>(
  text: string,
  replacements: Record<string, unknown> = {},
): Promise<T[]> {
  return db.query<T>(text, { type: QueryTypes.SELECT, replacements });
}

async function exec(text: string, replacements: Record<string, unknown> = {}): Promise<void> {
  await db.query(text, { type: QueryTypes.RAW, replacements });
}

/** An identity granted BASIC + RULES on the fixture tenant. Built in memory: `grantFor` resolves
 * against the identity handed to it, never the database. */
function caller(): ResolvedServiceIdentity {
  return {
    identity: IDENTITY,
    grants: [
      {
        id: 1,
        serviceIdentity: IDENTITY,
        tenantId,
        allowedSections: ['BASIC', 'RULES'],
        status: 'active',
        createdBy: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
  };
}

interface WireRule {
  readonly ruleCode: string;
  readonly ruleVersionId: number;
  readonly versionNo: number;
  readonly expression: string;
  readonly boundValuesJson: string;
  readonly operator: string;
  readonly resolverId: number;
  readonly resolverConfig: string;
  readonly defaultOperators: readonly string[];
}

/** The campaign as a **decoded proto message** — what RAP actually sees, after a real encode/decode
 * round trip, not the builder's internal payload. */
async function fetchOverTheWire(): Promise<{ rules: WireRule[]; configHash: string }> {
  const { config } = await service.getCampaignConfig(caller(), {
    tenantId,
    campaignCode: CAMPAIGN_CODE,
    etag: '',
    sections: [CONFIG_SECTION.BASIC, CONFIG_SECTION.RULES],
  });
  const decoded = decodeMessage(
    CampaignConfigMessage,
    encodeMessage(CampaignConfigMessage, config as unknown as Record<string, unknown>),
  ) as { rules: WireRule[]; configHash: string };

  return { rules: decoded.rules, configHash: decoded.configHash };
}

function ruleFor(rules: readonly WireRule[], ruleCode: string): WireRule {
  const found = rules.find((entry) => entry.ruleCode === ruleCode);
  if (found === undefined) throw new Error(`no BoundRule for ${ruleCode} in the response`);
  return found;
}

async function purge(): Promise<void> {
  const campaigns = `SELECT id FROM reward_config.tenant_campaigns WHERE campaign_code LIKE '${PREFIX}%'`;
  const components = `SELECT id FROM reward_config.tracker_components WHERE component_code LIKE '${PREFIX}%'`;
  const trackers = `SELECT id FROM reward_config.trackers WHERE tracker_code LIKE '${PREFIX}%'`;
  const rules = `SELECT id FROM reward_config.rule_master WHERE rule_code LIKE '${PREFIX}%'`;
  for (const statement of [
    `DELETE FROM reward_config.tenant_campaign_trackers WHERE campaign_id IN (${campaigns})`,
    `DELETE FROM reward_config.tenant_campaigns WHERE campaign_code LIKE '${PREFIX}%'`,
    `DELETE FROM reward_config.tracker_component_rules WHERE tracker_component_id IN (${components})`,
    `DELETE FROM reward_config.tracker_tracker_components WHERE tracker_id IN (${trackers})`,
    `DELETE FROM reward_config.tracker_components WHERE component_code LIKE '${PREFIX}%'`,
    `DELETE FROM reward_config.trackers WHERE tracker_code LIKE '${PREFIX}%'`,
    `DELETE FROM reward_config.activities WHERE activity_code LIKE '${PREFIX}%'`,
    `DELETE FROM reward_config.rule_versions WHERE rule_id IN (${rules})`,
    `DELETE FROM reward_config.rule_master WHERE rule_code LIKE '${PREFIX}%'`,
    `DELETE FROM reward_config.tenants WHERE code LIKE '${PREFIX}%'`,
  ]) {
    await exec(statement);
  }
}

/** One rule master (+ optionally one draft version) bound to the fixture component. Returns the
 * version id, or `null` when the binding is left unpinned. */
async function bindRule(options: {
  ruleCode: string;
  subCategoryId: number;
  version: {
    resolverId: number | null;
    resolverConfig: string | null;
    defaultOperators: string | null;
  } | null;
  operator: string | null;
  config: Record<string, unknown>;
}): Promise<number | null> {
  const [rule] = await sql<{ id: number }>(
    `INSERT INTO reward_config.rule_master
       (tenant_id, sub_category_id, rule_code, name, expression, parameters, status)
     VALUES (NULL, :subCategoryId, :code, :code, :expression, :parameters, 'active')
     RETURNING id`,
    {
      subCategoryId: options.subCategoryId,
      code: options.ruleCode,
      expression: WINDOW_EXPRESSION,
      parameters: JSON.stringify({ fields: [] }),
    },
  );

  let versionId: number | null = null;
  if (options.version !== null) {
    const [version] = await sql<{ id: number }>(
      `INSERT INTO reward_config.rule_versions
         (rule_id, version_no, expression, parameters, status, created_by,
          resolver_id, resolver_config, default_operators)
       VALUES (:ruleId, 1, :expression, :parameters, 'draft', 1,
               :resolverId, :resolverConfig, :defaultOperators)
       RETURNING id`,
      {
        ruleId: rule.id,
        expression: WINDOW_EXPRESSION,
        parameters: JSON.stringify({ fields: [] }),
        resolverId: options.version.resolverId,
        resolverConfig: options.version.resolverConfig,
        defaultOperators: options.version.defaultOperators,
      },
    );
    versionId = version.id;
  }

  await exec(
    `INSERT INTO reward_config.tracker_component_rules
       (tenant_id, tracker_component_id, rule_id, rule_version_id, operator, config, status)
     VALUES (:tenantId, :componentId, :ruleId, :versionId, :operator, :config, 'active')`,
    {
      tenantId,
      componentId,
      ruleId: rule.id,
      versionId,
      operator: options.operator,
      config: JSON.stringify(options.config),
    },
  );
  return versionId;
}

beforeAll(async () => {
  db = buildAppSequelize();
  await db.authenticate();

  const scoped = new ScopedRepository();
  service = new CampaignConfigService(
    db,
    scoped,
    new ConfigSnapshotBuilder(db, scoped),
    new ServiceScopeGuard({} as unknown as GrpcGrantsService),
    new ChangeEventPublisher(),
    new ServiceRateLimiter(),
  );

  await purge();

  const [country] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.countries ORDER BY id LIMIT 1',
  );
  if (country === undefined) throw new Error('no countries — run the seed migrations first');
  const [resolver] = await sql<{ id: number }>(
    `SELECT id FROM reward_config.rule_resolvers WHERE resolver_code = 'SCHEDULE_CONTEXT'`,
  );
  if (resolver === undefined) {
    throw new Error('rule_resolvers has no SCHEDULE_CONTEXT row — run T102_002 first');
  }
  scheduleResolverId = resolver.id;
  const [subCategory] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.rule_sub_categories ORDER BY id LIMIT 1',
  );
  if (subCategory === undefined) throw new Error('no rule sub-categories — run the seeds first');
  const [activityType] = await sql<{ id: number }>(
    'SELECT id FROM reward_config.activity_types ORDER BY id LIMIT 1',
  );
  if (activityType === undefined) throw new Error('no activity types — run the seeds first');

  const [tenant] = await sql<{ id: number }>(
    `INSERT INTO reward_config.tenants (code, name, country_id, status)
     VALUES (:code, :code, :countryId, 'active') RETURNING id`,
    { code: `${PREFIX}_TENANT`, countryId: country.id },
  );
  tenantId = tenant.id;

  const [campaign] = await sql<{ id: number }>(
    `INSERT INTO reward_config.tenant_campaigns
       (tenant_id, campaign_code, name, start_date, end_date, status, created_by)
     VALUES (:tenantId, :code, :code, '2026-01-01T00:00:00Z', '2026-12-31T00:00:00Z',
             'active', '1')
     RETURNING id`,
    { tenantId, code: CAMPAIGN_CODE },
  );
  campaignId = campaign.id;

  const [activity] = await sql<{ id: number }>(
    `INSERT INTO reward_config.activities (tenant_id, type_id, activity_code, name, status)
     VALUES (:tenantId, :typeId, :code, :code, 'active') RETURNING id`,
    { tenantId, typeId: activityType.id, code: `${PREFIX}_ACT` },
  );
  const [tracker] = await sql<{ id: number }>(
    `INSERT INTO reward_config.trackers
       (tenant_id, tracker_code, name, completion_logic, completion_threshold, status)
     VALUES (:tenantId, :code, :code, 'all', 1, 'active') RETURNING id`,
    { tenantId, code: `${PREFIX}_TRK` },
  );
  const [component] = await sql<{ id: number }>(
    `INSERT INTO reward_config.tracker_components
       (tenant_id, component_code, name, activity_id, status)
     VALUES (:tenantId, :code, :code, :activityId, 'active') RETURNING id`,
    { tenantId, code: `${PREFIX}_CMP`, activityId: activity.id },
  );
  componentId = component.id;
  await exec(
    `INSERT INTO reward_config.tracker_tracker_components
       (tracker_id, component_id, sequence_order, is_mandatory)
     VALUES (:trackerId, :componentId, 1, true)`,
    { trackerId: tracker.id, componentId },
  );
  await exec(
    `INSERT INTO reward_config.tenant_campaign_trackers (tenant_id, campaign_id, tracker_id, status)
     VALUES (:tenantId, :campaignId, :trackerId, 'active')`,
    { tenantId, campaignId, trackerId: tracker.id },
  );

  wiredVersionId =
    (await bindRule({
      ruleCode: WIRED_RULE,
      subCategoryId: subCategory.id,
      version: {
        resolverId: scheduleResolverId,
        resolverConfig: JSON.stringify(RESOLVER_CONFIG),
        defaultOperators: JSON.stringify(DEFAULT_OPERATORS),
      },
      operator: OPERATOR,
      config: { windowType: 'DAILY_HOURS', windowStart: '00:00', windowEnd: '23:59' },
    })) ?? 0;
  await bindRule({
    ruleCode: BARE_RULE,
    subCategoryId: subCategory.id,
    version: null,
    operator: null,
    config: { value: 0, currency: 'MYR' },
  });
  await bindRule({
    ruleCode: UNWIRED_RULE,
    subCategoryId: subCategory.id,
    version: { resolverId: null, resolverConfig: null, defaultOperators: null },
    operator: null,
    config: {},
  });
}, 60_000);

afterAll(async () => {
  if (db !== undefined) {
    await purge();
    await db.close();
  }
});

describe('T-175 — the new BoundRule fields over the real config service', () => {
  it('TC-1 — GetCampaignConfig serves the resolver wiring a pinned version actually carries', async () => {
    const { rules } = await fetchOverTheWire();
    const wired = ruleFor(rules, WIRED_RULE);

    expect(wired.ruleVersionId).toBe(wiredVersionId);
    expect(wired.resolverId).toBe(scheduleResolverId);
    expect(wired.resolverConfig).toBe('{"field":"currentTime"}');
    expect(JSON.parse(wired.resolverConfig)).toEqual(RESOLVER_CONFIG);
    expect(wired.defaultOperators).toEqual(DEFAULT_OPERATORS);
    // And what was already on the wire beside them is unchanged.
    expect(wired.expression).toBe(WINDOW_EXPRESSION);
    expect(JSON.parse(wired.boundValuesJson)).toEqual({
      windowType: 'DAILY_HOURS',
      windowStart: '00:00',
      windowEnd: '23:59',
    });
  });

  it('TC-1 — ListActiveCampaigns serves it too (the cache-warming path)', async () => {
    const { list } = await service.listActiveCampaigns(caller(), {
      tenantId,
      sections: [CONFIG_SECTION.BASIC, CONFIG_SECTION.RULES],
    });
    const decoded = decodeMessage(
      CampaignConfigListMessage,
      encodeMessage(CampaignConfigListMessage, list),
    ) as { campaigns: { campaignCode: string; rules: WireRule[] }[] };

    const listed = decoded.campaigns.find((entry) => entry.campaignCode === CAMPAIGN_CODE);
    expect(listed).toBeDefined();
    const wired = ruleFor(listed?.rules ?? [], WIRED_RULE);

    expect(wired.resolverId).toBe(scheduleResolverId);
    expect(wired.resolverConfig).toBe('{"field":"currentTime"}');
    expect(wired.defaultOperators).toEqual(DEFAULT_OPERATORS);
    expect(wired.operator).toBe(OPERATOR);
  });

  it('TC-2 — a binding with no pinned version serves the zero values — never fabricated', async () => {
    const { rules } = await fetchOverTheWire();
    const bare = ruleFor(rules, BARE_RULE);

    expect(bare.ruleVersionId).toBe(0);
    expect(bare.operator).toBe('');
    expect(bare.resolverId).toBe(0);
    expect(bare.resolverConfig).toBe('');
    expect(bare.defaultOperators).toEqual([]);
    // The values already on the wire for this row set are unaffected by the new reads.
    expect(JSON.parse(bare.boundValuesJson)).toEqual({ value: 0, currency: 'MYR' });
  });

  it('a pinned version with no resolver wired serves 0/""/[] beside a real rule_version_id', async () => {
    // The boundary T-RAP-064 must be able to see: "this binding HAS a version, and that version
    // has no resolver" is not the same message as "this binding has no version".
    const { rules } = await fetchOverTheWire();
    const unwired = ruleFor(rules, UNWIRED_RULE);

    expect(unwired.ruleVersionId).not.toBe(0);
    expect(unwired.resolverId).toBe(0);
    expect(unwired.resolverConfig).toBe('');
    expect(unwired.defaultOperators).toEqual([]);
  });

  it('TC-3 — operator comes off tracker_component_rules.operator and matches exactly', async () => {
    const { rules } = await fetchOverTheWire();

    expect(ruleFor(rules, WIRED_RULE).operator).toBe(OPERATOR);
    // It is its own column, not a key of `config`: the bound values carry no trace of it.
    expect(ruleFor(rules, WIRED_RULE).boundValuesJson).not.toContain(OPERATOR);
  });

  it('the operator is inside the hashed payload, so changing it invalidates a cached config', async () => {
    // If the fields were assembled after hashing (or dropped from the canonical payload), a runtime
    // holding an ETag would keep evaluating with the old operator forever — the cache-invalidation
    // property 09-INTEGRATION.md §11 depends on. `operator` is the one of the four a maker can
    // change without publishing a new version, so it is the one that matters here.
    const before = await fetchOverTheWire();
    await exec(
      `UPDATE reward_config.tracker_component_rules SET operator = 'in'
        WHERE tracker_component_id = :componentId AND rule_version_id = :versionId`,
      { componentId, versionId: wiredVersionId },
    );

    const after = await fetchOverTheWire();
    expect(after.configHash).not.toBe(before.configHash);
    expect(ruleFor(after.rules, WIRED_RULE).operator).toBe('in');

    await exec(
      `UPDATE reward_config.tracker_component_rules SET operator = :operator
        WHERE tracker_component_id = :componentId AND rule_version_id = :versionId`,
      { componentId, versionId: wiredVersionId, operator: OPERATOR },
    );
    expect((await fetchOverTheWire()).configHash).toBe(before.configHash);
  });

  it('serves a stable response across repeated calls (config_hash is deterministic)', async () => {
    const first = await fetchOverTheWire();
    const second = await fetchOverTheWire();

    expect(first.rules).toEqual(second.rules);
    expect(first.configHash).toBe(second.configHash);
  });

  it('BASIC alone still serves no rules at all — the section boundary is unchanged', async () => {
    // TC-4's half of the section-grant guarantee: an identity without RULES still cannot read a
    // resolver config any more than it could read an expression before this task.
    const { config } = await service.getCampaignConfig(caller(), {
      tenantId,
      campaignCode: CAMPAIGN_CODE,
      etag: '',
      sections: [CONFIG_SECTION.BASIC],
    });

    expect((config as { rules: unknown[] }).rules).toEqual([]);
  });
});
