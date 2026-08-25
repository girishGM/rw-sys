/**
 * T-042 — the response bodies `/definition-requests` returns, and the only shapes it may return.
 *
 * Built by hand from the `DefinitionRequest` model instance the service loads, never by
 * spreading a Sequelize row — the same construction rule `rule-response.dto.ts` records, for the
 * same reason. Mirrored field-for-field by `packages/shared/src/definition-request.schema.ts`.
 */
import type { DefinitionRequest } from '@/database/models/definition-request.model';
import type {
  DefinitionRequestPriorityValue,
  DefinitionRequestStatusValue,
  DefinitionRequestTypeValue,
} from '../definition-requests.constants';

/** 03-API-CONTRACT.md §1 — `{ "data": … }`. Declared locally per the precedent
 * `rule-response.dto.ts`'s own copy documents: this envelope is an API-wide convention no task
 * owns a shared home for. */
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

export interface DefinitionRequestDto {
  readonly id: number;
  readonly requestType: DefinitionRequestTypeValue;
  readonly entityId: number | null;
  readonly requestedBy: number;
  readonly requestingCountryId: number | null;
  readonly requestingTenantId: number | null;
  readonly title: string;
  readonly description: string;
  readonly businessJustification: string | null;
  readonly desiredBy: string | null;
  readonly priority: DefinitionRequestPriorityValue;
  readonly status: DefinitionRequestStatusValue;
  readonly reviewedBy: number | null;
  readonly reviewedAt: string | null;
  readonly reviewComment: string | null;
  readonly fulfilledVersionId: number | null;
  readonly fulfilledAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toDefinitionRequestDto(row: DefinitionRequest): DefinitionRequestDto {
  return {
    id: row.id,
    requestType: row.requestType as DefinitionRequestTypeValue,
    entityId: row.entityId,
    requestedBy: row.requestedBy,
    requestingCountryId: row.requestingCountryId,
    requestingTenantId: row.requestingTenantId,
    title: row.title,
    description: row.description,
    businessJustification: row.businessJustification,
    desiredBy: row.desiredBy,
    priority: row.priority as DefinitionRequestPriorityValue,
    status: row.status as DefinitionRequestStatusValue,
    reviewedBy: row.reviewedBy,
    reviewedAt: row.reviewedAt === null ? null : row.reviewedAt.toISOString(),
    reviewComment: row.reviewComment,
    fulfilledVersionId: row.fulfilledVersionId,
    fulfilledAt: row.fulfilledAt === null ? null : row.fulfilledAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
