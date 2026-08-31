/**
 * T-041 — the response bodies `/rules/:id/versions`, `/rewards/:id/versions`,
 * `.../diff/:otherVid` and `/countries/:id/assigned-versions` return. Built by hand from the
 * model instances the services load, never by spreading a Sequelize row — the same
 * construction rule `rule-response.dto.ts` records. Mirrored field-for-field by
 * `packages/shared/src/version.schema.ts`.
 *
 * T-109 — `resolverId`/`resolverConfig`/`evaluationContext`/`defaultOperators` (T-103) are now
 * included on `RuleVersionDto`, closing the gap T-105's own architect review found ("resolver
 * fields silently dropped"). `resolverConfig`/`defaultOperators` are `text` columns holding
 * JSON, read verbatim by the model (`rule-version.model.ts`'s own doc comment) — this file
 * parses them the same tolerant way `parameters` is parsed at the model layer, via the shared
 * `parseJsonColumn` helper, falling back to `null` (not `{}`/`[]`) so an absent/malformed value
 * reads as "not wired" rather than "wired to an empty config".
 */
import { parseJsonColumn } from '@/database/util/json-text.util';
import type { RuleVersion } from '@/database/models/rule-version.model';
import type { RewardVersion } from '@/database/models/reward-version.model';
import type { RuleVersionCountryAssignment } from '@/database/models/rule-version-country-assignment.model';
import type { RewardVersionCountryAssignment } from '@/database/models/reward-version-country-assignment.model';
import type { Country } from '@/database/models/country.model';
import type { FieldDiff } from '../version-diff.util';

/** 03-API-CONTRACT.md §1 — `{ "data": … }`. Declared locally per the precedent `rule-response.dto.ts`
 * documents: this envelope is an API-wide convention no task owns a shared home for. */
export interface DataEnvelope<T> {
  readonly data: T;
}

export function envelope<T>(data: T): DataEnvelope<T> {
  return { data };
}

export interface ListMeta {
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

export interface DataListEnvelope<T> {
  readonly data: readonly T[];
  readonly meta: ListMeta;
}

export interface RuleVersionDto {
  readonly id: number;
  readonly ruleId: number;
  readonly versionNo: number;
  readonly expression: string | null;
  readonly parameters: Record<string, unknown>;
  readonly changeSummary: string | null;
  readonly isBreaking: boolean;
  readonly status: string;
  readonly supersedesVersionId: number | null;
  readonly originRequestId: number | null;
  readonly createdBy: number | null;
  readonly createdAt: string;
  readonly publishedBy: number | null;
  readonly publishedAt: string | null;
  readonly deprecatedAt: string | null;
  readonly retiredAt: string | null;
  readonly updatedAt: string;
  readonly suggestedIsBreaking: boolean | null;
  /** T-109/T-103 — `null` reads as "not yet wired to the registry-driven rule engine". */
  readonly resolverId: number | null;
  readonly resolverConfig: Record<string, unknown> | null;
  readonly evaluationContext: string | null;
  readonly defaultOperators: readonly string[] | null;
}

export function toRuleVersionDto(
  version: RuleVersion,
  suggestedIsBreaking: boolean | null,
): RuleVersionDto {
  return {
    id: version.id,
    ruleId: version.ruleId,
    versionNo: version.versionNo,
    expression: version.expression,
    parameters: version.parameters,
    changeSummary: version.changeSummary,
    isBreaking: version.isBreaking,
    status: version.status,
    supersedesVersionId: version.supersedesVersionId,
    originRequestId: version.originRequestId,
    createdBy: version.createdBy,
    createdAt: version.createdAt.toISOString(),
    publishedBy: version.publishedBy,
    publishedAt: version.publishedAt?.toISOString() ?? null,
    deprecatedAt: version.deprecatedAt?.toISOString() ?? null,
    retiredAt: version.retiredAt?.toISOString() ?? null,
    updatedAt: version.updatedAt.toISOString(),
    suggestedIsBreaking,
    resolverId: version.resolverId,
    resolverConfig: parseJsonColumn<Record<string, unknown> | null>(version.resolverConfig, null),
    evaluationContext: version.evaluationContext,
    defaultOperators: parseJsonColumn<readonly string[] | null>(version.defaultOperators, null),
  };
}

export interface RewardVersionDto {
  readonly id: number;
  readonly rewardId: number;
  readonly versionNo: number;
  readonly connectorConfig: Record<string, unknown>;
  readonly deliveryMode: string | null;
  readonly retryConfig: Record<string, unknown>;
  readonly policiesSnapshot: unknown;
  readonly unitType: string | null;
  readonly unitCode: string | null;
  readonly changeSummary: string | null;
  readonly isBreaking: boolean;
  readonly status: string;
  readonly supersedesVersionId: number | null;
  readonly originRequestId: number | null;
  readonly createdBy: number | null;
  readonly createdAt: string;
  readonly publishedBy: number | null;
  readonly publishedAt: string | null;
  readonly deprecatedAt: string | null;
  readonly retiredAt: string | null;
  readonly updatedAt: string;
  readonly suggestedIsBreaking: boolean | null;
}

export function toRewardVersionDto(
  version: RewardVersion,
  suggestedIsBreaking: boolean | null,
): RewardVersionDto {
  return {
    id: version.id,
    rewardId: version.rewardId,
    versionNo: version.versionNo,
    connectorConfig: version.connectorConfig,
    deliveryMode: version.deliveryMode,
    retryConfig: version.retryConfig,
    policiesSnapshot: version.policiesSnapshot,
    unitType: version.unitType,
    unitCode: version.unitCode,
    changeSummary: version.changeSummary,
    isBreaking: version.isBreaking,
    status: version.status,
    supersedesVersionId: version.supersedesVersionId,
    originRequestId: version.originRequestId,
    createdBy: version.createdBy,
    createdAt: version.createdAt.toISOString(),
    publishedBy: version.publishedBy,
    publishedAt: version.publishedAt?.toISOString() ?? null,
    deprecatedAt: version.deprecatedAt?.toISOString() ?? null,
    retiredAt: version.retiredAt?.toISOString() ?? null,
    updatedAt: version.updatedAt.toISOString(),
    suggestedIsBreaking,
  };
}

export interface VersionDiffDto {
  readonly versionId: number;
  readonly otherVersionId: number;
  readonly versionNo: number;
  readonly otherVersionNo: number;
  readonly expressionChanged: boolean;
  readonly parametersAdded: readonly string[];
  readonly parametersRemoved: readonly string[];
  readonly parametersTypeChanged: readonly string[];
  readonly suggestedIsBreaking: boolean;
}

export function toVersionDiffDto(input: {
  readonly versionId: number;
  readonly otherVersionId: number;
  readonly versionNo: number;
  readonly otherVersionNo: number;
  readonly expressionChanged: boolean;
  readonly diff: FieldDiff;
  readonly suggestedIsBreaking: boolean;
}): VersionDiffDto {
  return {
    versionId: input.versionId,
    otherVersionId: input.otherVersionId,
    versionNo: input.versionNo,
    otherVersionNo: input.otherVersionNo,
    expressionChanged: input.expressionChanged,
    parametersAdded: input.diff.added,
    parametersRemoved: input.diff.removed,
    parametersTypeChanged: input.diff.typeChanged,
    suggestedIsBreaking: input.suggestedIsBreaking,
  };
}

export interface VersionCountryAssignmentDto {
  readonly id: number;
  readonly versionId: number;
  readonly versionNo: number;
  readonly countryId: number;
  readonly countryCode: string;
  readonly countryName: string;
  readonly blastId: number | null;
  readonly status: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly assignedBy: number | null;
  readonly assignedAt: string;
}

export function toRuleVersionCountryAssignmentDto(
  assignment: RuleVersionCountryAssignment & { country: Country; ruleVersion: RuleVersion },
): VersionCountryAssignmentDto {
  return {
    id: assignment.id,
    versionId: assignment.ruleVersionId,
    versionNo: assignment.ruleVersion.versionNo,
    countryId: assignment.countryId,
    countryCode: assignment.country.code,
    countryName: assignment.country.name,
    blastId: assignment.blastId,
    status: assignment.status,
    effectiveFrom: assignment.effectiveFrom.toISOString(),
    effectiveTo: assignment.effectiveTo?.toISOString() ?? null,
    assignedBy: assignment.assignedBy,
    assignedAt: assignment.assignedAt.toISOString(),
  };
}

export function toRewardVersionCountryAssignmentDto(
  assignment: RewardVersionCountryAssignment & { country: Country; rewardVersion: RewardVersion },
): VersionCountryAssignmentDto {
  return {
    id: assignment.id,
    versionId: assignment.rewardVersionId,
    versionNo: assignment.rewardVersion.versionNo,
    countryId: assignment.countryId,
    countryCode: assignment.country.code,
    countryName: assignment.country.name,
    blastId: assignment.blastId,
    status: assignment.status,
    effectiveFrom: assignment.effectiveFrom.toISOString(),
    effectiveTo: assignment.effectiveTo?.toISOString() ?? null,
    assignedBy: assignment.assignedBy,
    assignedAt: assignment.assignedAt.toISOString(),
  };
}

export interface AssignedVersionDto {
  readonly entityType: 'rule' | 'reward';
  readonly entityId: number;
  readonly entityCode: string;
  readonly entityName: string;
  readonly versionId: number;
  readonly versionNo: number;
  readonly status: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
}
