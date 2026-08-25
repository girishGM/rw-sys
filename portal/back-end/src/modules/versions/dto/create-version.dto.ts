/**
 * T-041 — `POST /rules/:id/versions` / `POST /rewards/:id/versions`. `super_admin` only.
 * Clones the latest published version's payload into a new draft (implementation note 2) —
 * nothing about the payload itself is caller-supplied here, only the bookkeeping.
 */
import { IsInt, IsOptional, IsString, MaxLength } from 'class-validator';
import { CHANGE_SUMMARY_MAX_LENGTH } from '../versions.constants';

export class CreateVersionDto {
  @IsOptional()
  @IsString()
  @MaxLength(CHANGE_SUMMARY_MAX_LENGTH)
  changeSummary?: string;

  /** Links back to a T-042 `definition_requests` row this version fulfils. */
  @IsOptional()
  @IsInt()
  originRequestId?: number;
}
