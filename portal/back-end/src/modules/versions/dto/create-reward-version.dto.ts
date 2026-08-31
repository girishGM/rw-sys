/**
 * T-119 — the body `POST /rewards/:rewardId/versions` accepts.
 *
 * `CreateVersionDto` is shared verbatim by the rule and reward create endpoints (T-041) and is
 * owned by that task; the Kind/value pair is reward-only, so this subclass adds it here rather
 * than widening the shared class with two fields `POST /rules/:id/versions` would silently accept
 * and ignore (R9, and the same "additive, never a rewrite" discipline
 * 13-REWARD-MASTER-VALUE-SOURCES.md §1 sets for this whole wave).
 *
 * Everything else about a new draft's payload is still cloned server-side from the latest
 * published version — see `CreateVersionDto`'s own header. The Kind is the one part a caller may
 * choose at creation time, because the Reward Master screen (T-120) authors a draft and its Kind
 * in a single step.
 */
import { IsIn, IsObject, IsOptional } from 'class-validator';
import { REWARD_KINDS } from '@reward-portal/shared';
import { CreateVersionDto } from './create-version.dto';

export class CreateRewardVersionDto extends CreateVersionDto {
  /** See `UpdateRewardVersionDto.rewardKind` — same field, same cross-field note: the pair is
   * validated by `RewardVersionsService`, not by `class-validator`. */
  @IsOptional()
  @IsIn(REWARD_KINDS)
  rewardKind?: (typeof REWARD_KINDS)[number] | null;

  /** See `UpdateRewardVersionDto.valueConfig`. */
  @IsOptional()
  @IsObject()
  valueConfig?: Record<string, unknown> | null;
}
