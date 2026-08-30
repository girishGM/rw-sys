/**
 * T-041 — the wire contract of `/rules/:id/versions`, `/rewards/:id/versions`, `/blasts` and
 * `/countries/:id/assigned-versions` (06-VERSIONING.md §4-§7), shared by the back end that
 * produces it and the SPA that consumes it (00-ARCHITECTURE.md §8).
 *
 * `.strict()` everywhere, same discipline `rule.schema.ts`/`reward.schema.ts` state in full —
 * no defaults the server never sent, no coercion, an unexpected key fails the contract test
 * rather than shipping silently.
 *
 * ### Why blast schemas live here too, not in a separate file
 *
 * This task's `Files owned` lists exactly one shared-schema file
 * (`packages/shared/src/version.schema.ts`) for both the versioning and the blast wire
 * contracts — `06-VERSIONING.md` treats "version" and "blast" as one feature (§6: "publish and
 * blast are two separate *acts*", not two separate *systems*), and `version_blasts` is
 * physically the table that turns a version into what a country holds. One file, one
 * `Files owned` entry.
 */
import { z } from 'zod';
// T-119 — the reward-version `rewardKind`/`valueConfig` pair is defined in `reward.schema.ts`
// (the file T-119 owns) and only *referenced* from this file's reward section; see the two
// `// T-119` markers below. One-way import: `reward.schema.ts` imports nothing from here.
import {
  checkRewardVersionValue,
  rewardVersionValueRequestFields,
  rewardVersionValueResponseFields,
} from './reward.schema';

// ─────────────────────────────── shared primitives ───────────────────────────────────────────

/** `rule_versions.status` / `reward_versions.status` — `ck_rv_status` (06-VERSIONING.md §4.3). */
export const VERSION_STATUSES = ['draft', 'published', 'deprecated', 'retired'] as const;
export const versionStatusSchema = z.enum(VERSION_STATUSES);
export type VersionStatus = z.infer<typeof versionStatusSchema>;

/** `rule_version_country_assignments.status` / the reward mirror — `ck_rvca_status`. */
export const VERSION_ASSIGNMENT_STATUSES = ['active', 'superseded', 'withdrawn'] as const;
export const versionAssignmentStatusSchema = z.enum(VERSION_ASSIGNMENT_STATUSES);
export type VersionAssignmentStatus = z.infer<typeof versionAssignmentStatusSchema>;

/** `version_blasts.entity_type` / `version_blast_targets` — polymorphic across rules/rewards. */
export const VERSION_ENTITY_TYPES = ['rule', 'reward'] as const;
export const versionEntityTypeSchema = z.enum(VERSION_ENTITY_TYPES);
export type VersionEntityType = z.infer<typeof versionEntityTypeSchema>;

export const BLAST_SCOPES = ['all_countries', 'selected'] as const;
export const blastScopeSchema = z.enum(BLAST_SCOPES);
export type BlastScope = z.infer<typeof blastScopeSchema>;

export const BLAST_TARGET_STATUSES = ['delivered', 'failed', 'skipped'] as const;
export const blastTargetStatusSchema = z.enum(BLAST_TARGET_STATUSES);
export type BlastTargetStatus = z.infer<typeof blastTargetStatusSchema>;

export const listMetaSchema = z
  .object({
    page: z.number().int(),
    pageSize: z.number().int(),
    total: z.number().int(),
  })
  .strict();

// ────────────────────────────────── rule versions ────────────────────────────────────────────

export const ruleVersionSchema = z
  .object({
    id: z.number().int(),
    ruleId: z.number().int(),
    versionNo: z.number().int(),
    expression: z.string().nullable(),
    parameters: z.record(z.string(), z.unknown()),
    changeSummary: z.string().nullable(),
    isBreaking: z.boolean(),
    status: versionStatusSchema,
    supersedesVersionId: z.number().int().nullable(),
    originRequestId: z.number().int().nullable(),
    createdBy: z.number().int().nullable(),
    createdAt: z.string(),
    publishedBy: z.number().int().nullable(),
    publishedAt: z.string().nullable(),
    deprecatedAt: z.string().nullable(),
    retiredAt: z.string().nullable(),
    updatedAt: z.string(),
    /** System-computed, not stored — §4.4: "defaulted by the system by comparing the parameter
     * schemas". Present on every read so the UI can flag an author's override (implementation
     * note 9). `null` when there is nothing to compare against (the very first version). */
    suggestedIsBreaking: z.boolean().nullable(),
    // T-109 — resolver wiring (T-102/T-103). `null` reads as "not yet wired to the
    // registry-driven rule engine"; frozen alongside the rest of the payload once published
    // (`T103_002`'s extended `fn_rule_version_immutable`). `.optional()` as well as
    // `.nullable()` — same reasoning `reward.schema.ts#rewardVersionValueResponseFields`
    // documents for its own pair: a `.strict()` client schema that *required* these four keys
    // would reject every fixture/mock built before this task, and every response from a server
    // one version behind during a rolling deploy.
    resolverId: z.number().int().nullable().optional(),
    resolverConfig: z.record(z.string(), z.unknown()).nullable().optional(),
    evaluationContext: z.string().nullable().optional(),
    defaultOperators: z.array(z.string()).nullable().optional(),
  })
  .strict();

export type RuleVersion = z.infer<typeof ruleVersionSchema>;

export const ruleVersionListEnvelopeSchema = z
  .object({ data: z.array(ruleVersionSchema) })
  .strict();
export const ruleVersionEnvelopeSchema = z.object({ data: ruleVersionSchema }).strict();

/** `POST /rules/:id/versions` — clones the latest published version; nothing else is caller
 * supplied (implementation note 2). */
export const createVersionRequestSchema = z
  .object({
    changeSummary: z.string().max(500).optional(),
    /** Links back to a T-042 `definition_requests` row this version fulfils. */
    originRequestId: z.number().int().optional(),
  })
  .strict();

export type CreateVersionRequest = z.infer<typeof createVersionRequestSchema>;

/** `PATCH /rules/:id/versions/:vid` — draft only. `confirmBreakingOverride` is required when
 * `isBreaking` is supplied and disagrees with the system's own suggestion (implementation
 * note 9). */
export const updateRuleVersionRequestSchema = z
  .object({
    expression: z.string().max(8000).nullable().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
    changeSummary: z.string().max(500).nullable().optional(),
    isBreaking: z.boolean().optional(),
    confirmBreakingOverride: z.boolean().optional(),
    // T-109 — all four optional *and* nullable: absent means "leave as is", `null` means
    // "clear the wiring back to inert" (implementation note 1). The server validates
    // `resolverId` against `rule_resolvers` and each `defaultOperators` entry against
    // `rule_operators`; `resolverConfig` is opaque JSON here, same as `parameters` above.
    resolverId: z.number().int().nullable().optional(),
    resolverConfig: z.record(z.string(), z.unknown()).nullable().optional(),
    evaluationContext: z.string().max(50).nullable().optional(),
    defaultOperators: z.array(z.string()).nullable().optional(),
  })
  .strict();

export type UpdateRuleVersionRequest = z.infer<typeof updateRuleVersionRequestSchema>;

// ───────────────────────────────── reward versions ───────────────────────────────────────────

export const rewardVersionSchema = z
  .object({
    id: z.number().int(),
    rewardId: z.number().int(),
    versionNo: z.number().int(),
    connectorConfig: z.record(z.string(), z.unknown()),
    deliveryMode: z.string().nullable(),
    retryConfig: z.record(z.string(), z.unknown()),
    policiesSnapshot: z.unknown().nullable(),
    unitType: z.string().nullable(),
    unitCode: z.string().nullable(),
    changeSummary: z.string().nullable(),
    isBreaking: z.boolean(),
    status: versionStatusSchema,
    supersedesVersionId: z.number().int().nullable(),
    originRequestId: z.number().int().nullable(),
    createdBy: z.number().int().nullable(),
    createdAt: z.string(),
    publishedBy: z.number().int().nullable(),
    publishedAt: z.string().nullable(),
    deprecatedAt: z.string().nullable(),
    retiredAt: z.string().nullable(),
    updatedAt: z.string(),
    suggestedIsBreaking: z.boolean().nullable(),
    // T-119 — `reward_versions.reward_kind`/`value_config` (13-REWARD-MASTER-VALUE-SOURCES.md §5).
    // Additive: this schema is `.strict()`, so the SPA would reject every reward-version response
    // the moment the server started sending these two keys if they were not declared here.
    ...rewardVersionValueResponseFields,
  })
  .strict();

export type RewardVersion = z.infer<typeof rewardVersionSchema>;

export const rewardVersionListEnvelopeSchema = z
  .object({ data: z.array(rewardVersionSchema) })
  .strict();
export const rewardVersionEnvelopeSchema = z.object({ data: rewardVersionSchema }).strict();

export const updateRewardVersionRequestSchema = z
  .object({
    connectorConfig: z.record(z.string(), z.unknown()).optional(),
    deliveryMode: z.string().max(20).nullable().optional(),
    retryConfig: z.record(z.string(), z.unknown()).optional(),
    policiesSnapshot: z.unknown().optional(),
    unitType: z.enum(['currency', 'points', 'voucher']).nullable().optional(),
    unitCode: z.string().max(10).nullable().optional(),
    changeSummary: z.string().max(500).nullable().optional(),
    isBreaking: z.boolean().optional(),
    confirmBreakingOverride: z.boolean().optional(),
    // T-119 — see `rewardVersionSchema` above. `superRefine` checks the pair when both halves are
    // in the same request; the server re-checks the *effective* pair after merging with the
    // stored draft, which is the only place that merge is knowable.
    ...rewardVersionValueRequestFields,
  })
  .strict()
  .superRefine(checkRewardVersionValue);

export type UpdateRewardVersionRequest = z.infer<typeof updateRewardVersionRequestSchema>;

// ─────────────────────────────────────── diff ────────────────────────────────────────────────

/** `GET .../versions/:vid/diff/:otherVid` (implementation notes 8/9). For rewards, the "parameter
 * schema" role `rule_versions.parameters` plays is filled by `connector_config`'s own top-level
 * keys — the design doc does not spell this out verbatim for the reward side ("Reward equivalents
 * mirror these exactly"), so this is this task's own, documented mapping. */
export const versionDiffSchema = z
  .object({
    versionId: z.number().int(),
    otherVersionId: z.number().int(),
    versionNo: z.number().int(),
    otherVersionNo: z.number().int(),
    expressionChanged: z.boolean(),
    parametersAdded: z.array(z.string()),
    parametersRemoved: z.array(z.string()),
    parametersTypeChanged: z.array(z.string()),
    suggestedIsBreaking: z.boolean(),
  })
  .strict();

export type VersionDiff = z.infer<typeof versionDiffSchema>;

export const versionDiffEnvelopeSchema = z.object({ data: versionDiffSchema }).strict();

// ─────────────────────────────── version → country assignment ────────────────────────────────

export const versionCountryAssignmentSchema = z
  .object({
    id: z.number().int(),
    versionId: z.number().int(),
    versionNo: z.number().int(),
    countryId: z.number().int(),
    countryCode: z.string(),
    countryName: z.string(),
    blastId: z.number().int().nullable(),
    status: versionAssignmentStatusSchema,
    effectiveFrom: z.string(),
    effectiveTo: z.string().nullable(),
    assignedBy: z.number().int().nullable(),
    assignedAt: z.string(),
  })
  .strict();

export type VersionCountryAssignment = z.infer<typeof versionCountryAssignmentSchema>;

export const versionCountryAssignmentListEnvelopeSchema = z
  .object({ data: z.array(versionCountryAssignmentSchema) })
  .strict();

/** `GET /countries/:id/assigned-versions` — both rules and rewards, one list (06-VERSIONING.md
 * §10, "Country → Assigned versions"). */
export const assignedVersionSchema = z
  .object({
    entityType: versionEntityTypeSchema,
    entityId: z.number().int(),
    entityCode: z.string(),
    entityName: z.string(),
    versionId: z.number().int(),
    versionNo: z.number().int(),
    status: versionAssignmentStatusSchema,
    effectiveFrom: z.string(),
    effectiveTo: z.string().nullable(),
  })
  .strict();

export type AssignedVersion = z.infer<typeof assignedVersionSchema>;

export const assignedVersionListEnvelopeSchema = z
  .object({ data: z.array(assignedVersionSchema) })
  .strict();

// ────────────────────────────────────── blasts ───────────────────────────────────────────────

const blastRequestBaseSchema = z.object({
  entityType: versionEntityTypeSchema,
  entityId: z.number().int(),
  versionId: z.number().int(),
  scope: blastScopeSchema,
  /** Required and non-empty when `scope: 'selected'`; ignored (must be absent) otherwise —
   * enforced by `.superRefine` below, not by the shape alone. */
  countryIds: z.array(z.number().int()).max(300).optional(),
});

function refineScopeCountryIds(
  value: z.infer<typeof blastRequestBaseSchema>,
  ctx: z.RefinementCtx,
): void {
  if (
    value.scope === 'selected' &&
    (value.countryIds === undefined || value.countryIds.length === 0)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'countryIds is required and non-empty when scope is "selected"',
      path: ['countryIds'],
    });
  }
  if (value.scope === 'all_countries' && value.countryIds !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'countryIds must be omitted when scope is "all_countries"',
      path: ['countryIds'],
    });
  }
}

/** `POST /blasts/preview` — no writes; same shape as the real blast minus the audit-only fields. */
export const previewBlastRequestSchema = blastRequestBaseSchema
  .strict()
  .superRefine(refineScopeCountryIds);

export type PreviewBlastRequest = z.infer<typeof previewBlastRequestSchema>;

export const blastPreviewCountryImpactSchema = z
  .object({
    countryId: z.number().int(),
    countryCode: z.string(),
    countryName: z.string(),
    currentVersionNo: z.number().int().nullable(),
    willReceiveVersionNo: z.number().int(),
    activeCampaignsOnCurrentVersion: z.number().int(),
    isBreaking: z.boolean(),
  })
  .strict();

export type BlastPreviewCountryImpact = z.infer<typeof blastPreviewCountryImpactSchema>;

export const blastPreviewResponseSchema = z
  .object({
    entityType: versionEntityTypeSchema,
    entityId: z.number().int(),
    versionId: z.number().int(),
    versionNo: z.number().int(),
    isBreaking: z.boolean(),
    countries: z.array(blastPreviewCountryImpactSchema),
  })
  .strict();

export type BlastPreviewResponse = z.infer<typeof blastPreviewResponseSchema>;

export const blastPreviewEnvelopeSchema = z.object({ data: blastPreviewResponseSchema }).strict();

/** `POST /blasts` — the real blast. `confirmBreaking` mirrors `confirmBreakingOverride` above:
 * required and `true` when the target version's `isBreaking` is `true` (implementation note 9 —
 * "overriding the suggestion requires a confirmation" applies just as much to *acting* on a
 * breaking version as to authoring one). */
export const createBlastRequestSchema = blastRequestBaseSchema
  .extend({
    note: z.string().max(500).optional(),
    originRequestId: z.number().int().optional(),
    confirmBreaking: z.boolean().optional(),
  })
  .strict()
  .superRefine(refineScopeCountryIds);

export type CreateBlastRequest = z.infer<typeof createBlastRequestSchema>;

export const blastTargetSchema = z
  .object({
    id: z.number().int(),
    countryId: z.number().int(),
    countryCode: z.string(),
    countryName: z.string(),
    status: blastTargetStatusSchema,
    failureReason: z.string().nullable(),
  })
  .strict();

export type BlastTarget = z.infer<typeof blastTargetSchema>;

export const blastSchema = z
  .object({
    id: z.number().int(),
    entityType: versionEntityTypeSchema,
    entityId: z.number().int(),
    versionId: z.number().int(),
    versionNo: z.number().int(),
    scope: blastScopeSchema,
    targetCount: z.number().int(),
    note: z.string().nullable(),
    originRequestId: z.number().int().nullable(),
    blastedBy: z.number().int().nullable(),
    blastedAt: z.string(),
    targets: z.array(blastTargetSchema),
  })
  .strict();

export type Blast = z.infer<typeof blastSchema>;

export const blastEnvelopeSchema = z.object({ data: blastSchema }).strict();
export const blastListEnvelopeSchema = z
  .object({ data: z.array(blastSchema), meta: listMetaSchema })
  .strict();
