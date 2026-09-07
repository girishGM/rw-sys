/**
 * T-INT-010 — query-string shapes for the REST mirror of `CampaignConfigService`.
 *
 * `sections`/`etag` are the REST-side equivalents of the gRPC request messages'
 * `sections`/`etag` fields (`grpc/wire/campaign-config.messages.ts`), just carried as query
 * params instead of protobuf fields — nothing about `CampaignConfigService`'s own resolution of
 * either is re-implemented here (T-INT-010's own scope note: reuse the service, never fork its
 * logic). `sections` is written as comma-separated **section names** (`RULES,REWARDS`), not the
 * wire enum numbers, because a REST caller reading `grpc.constants.ts#CONFIG_SECTION` by number
 * is exactly the kind of transport-specific parsing branch implementation note 4 says every
 * client of this task should not need.
 */
import { Transform } from 'class-transformer';
import { IsArray, IsIn, IsOptional, IsString } from 'class-validator';
import { ALL_SECTIONS, type ConfigSectionName } from '@/grpc/grpc.constants';

/** Splits `"RULES,REWARDS"` into `['RULES', 'REWARDS']`, trimming and dropping empties so a
 * trailing comma or repeated whitespace does not read as a phantom, unknown section. */
function splitSections(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return parts;
}

export class SectionsQueryDto {
  /** Omitted → every section the caller's grant covers (mirrors gRPC's empty-`sections` case,
   * `section-grant.guard.ts`'s "implicit ask" branch). Present but naming an ungranted section →
   * `403`, exactly as `resolveSections` throws for gRPC. */
  @IsOptional()
  @Transform(({ value }) => splitSections(value))
  @IsArray()
  @IsIn(ALL_SECTIONS, { each: true })
  sections?: ConfigSectionName[];
}

/** {@link SectionsQueryDto} plus the polling `etag` — `GetCampaignConfig`'s REST substitute for
 * `WatchCampaignConfig` (implementation note 3). Accepted as a query param; the controller also
 * accepts the same value via `If-None-Match`, per that note's "query param (or `If-None-Match`
 * header)" wording — see `campaign-config-api.controller.ts#resolveEtag`. */
export class CampaignConfigQueryDto extends SectionsQueryDto {
  @IsOptional()
  @IsString()
  etag?: string;
}
