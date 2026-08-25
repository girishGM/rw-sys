/**
 * T-041 — the response bodies `/blasts` and `/blasts/preview` return. Built by hand from the
 * model instances `BlastsService` loads, never by spreading a Sequelize row. Mirrored
 * field-for-field by `packages/shared/src/version.schema.ts`.
 */
import type { Country } from '@/database/models/country.model';
import type { VersionBlast } from '@/database/models/version-blast.model';
import type { VersionBlastTarget } from '@/database/models/version-blast-target.model';

/** 03-API-CONTRACT.md §1 — `{ "data": … }`. */
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

export interface BlastTargetDto {
  readonly id: number;
  readonly countryId: number;
  readonly countryCode: string;
  readonly countryName: string;
  readonly status: string;
  readonly failureReason: string | null;
}

export function toBlastTargetDto(
  target: VersionBlastTarget & { country: Country },
): BlastTargetDto {
  return {
    id: target.id,
    countryId: target.countryId,
    countryCode: target.country.code,
    countryName: target.country.name,
    status: target.status,
    failureReason: target.failureReason,
  };
}

export interface BlastDto {
  readonly id: number;
  readonly entityType: string;
  readonly entityId: number;
  readonly versionId: number;
  readonly versionNo: number;
  readonly scope: string;
  readonly targetCount: number;
  readonly note: string | null;
  readonly originRequestId: number | null;
  readonly blastedBy: number | null;
  readonly blastedAt: string;
  readonly targets: readonly BlastTargetDto[];
}

export function toBlastDto(
  blast: VersionBlast,
  targets: readonly (VersionBlastTarget & { country: Country })[],
): BlastDto {
  return {
    id: blast.id,
    entityType: blast.entityType,
    entityId: blast.entityId,
    versionId: blast.versionId,
    versionNo: blast.versionNo,
    scope: blast.scope,
    targetCount: blast.targetCount,
    note: blast.note,
    originRequestId: blast.originRequestId,
    blastedBy: blast.blastedBy,
    blastedAt: blast.blastedAt.toISOString(),
    targets: targets.map(toBlastTargetDto),
  };
}

export interface BlastPreviewCountryImpactDto {
  readonly countryId: number;
  readonly countryCode: string;
  readonly countryName: string;
  readonly currentVersionNo: number | null;
  readonly willReceiveVersionNo: number;
  readonly activeCampaignsOnCurrentVersion: number;
  readonly isBreaking: boolean;
}

export interface BlastPreviewDto {
  readonly entityType: string;
  readonly entityId: number;
  readonly versionId: number;
  readonly versionNo: number;
  readonly isBreaking: boolean;
  readonly countries: readonly BlastPreviewCountryImpactDto[];
}
