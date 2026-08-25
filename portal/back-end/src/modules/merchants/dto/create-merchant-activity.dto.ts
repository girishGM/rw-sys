/**
 * T-036 — `POST /merchants/:id/activities` (TC-14/TC-15/TC-16/TC-17/TC-18/TC-19).
 *
 * No `tenantId`/`merchantId` here, the same shape `create-merchant-store.dto.ts` documents.
 * `storeId` omitted means "tenant-wide" (`store_id IS NULL`, implementation note 4) — never
 * `null` on the wire; `undefined` (the key absent) is the only spelling this DTO accepts for
 * that, so `forbidNonWhitelisted`/`class-validator` reject a literal JSON `null` as a type error
 * rather than silently treating it the same as "omitted".
 */
import { IsInt, IsOptional, Min } from 'class-validator';
import { IsCommissionRate } from './merchant-validators.decorators';

export class CreateMerchantActivityDto {
  @IsInt()
  @Min(1)
  activityId!: number;

  /** Omit entirely for a tenant-wide link (TC-14); supply to scope the link to one store
   * (TC-16). Re-verified server-side against a scoped lookup, and against the merchant named in
   * the URL, before it is trusted. */
  @IsOptional()
  @IsInt()
  @Min(1)
  storeId?: number;

  /** `decimal(5,2)`, `0`–`100`, at most 2 decimals (TC-17/TC-18/TC-19). */
  @IsOptional()
  @IsCommissionRate()
  commissionRate?: number;
}
