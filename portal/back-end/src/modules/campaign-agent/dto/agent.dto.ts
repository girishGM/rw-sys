/**
 * T-048 — the request bodies of `/campaign-agent`.
 *
 * Two layers, exactly as `modules/campaigns/dto/*` establishes: per-field `class-validator`
 * decorators for precise `details` entries, plus one `@MatchesSharedContract(...)` against the Zod
 * schema the SPA validates with, so every cross-field rule has one definition.
 *
 * ### What is not here
 *
 * **No `tenantId`, no `userId`, no `role`, no `campaignId`, no `createdVia`.** R3, and the same
 * sentence `campaign.dto.ts` records: *"those come from the verified JWT only, and if a DTO
 * contains one of these, that is a bug"*. In this module it matters twice over, because a
 * `createdVia` a client could set would make the AI-provenance marker (§7) a claim rather than a
 * fact — see `CampaignsService.create`'s `provenance` parameter for where it really comes from.
 *
 * **No `plan`.** `POST /confirm` carries a *hash*, never a plan: a submitted plan would be a plan
 * the client chose, and the whole point of §3.2 is that the executed plan is the one the server
 * rebuilt from the maker's own answers.
 */
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';
import {
  confirmAgentPlanRequestSchema,
  sendAgentMessageRequestSchema,
} from '@reward-portal/shared';
import { MatchesSharedContract } from '@/modules/campaigns/dto/shared-contract.decorator';
import { MAX_MESSAGE_LENGTH } from '../agent.constants';

/** `POST /campaign-agent/sessions/:id/messages` — one turn of the maker's own words. */
export class SendAgentMessageDto {
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_MESSAGE_LENGTH)
  @MatchesSharedContract(sendAgentMessageRequestSchema)
  message!: string;
}

/**
 * `POST /campaign-agent/sessions/:id/confirm` — the click that creates the campaign (§3.2).
 *
 * The pattern is `^[0-9a-f]{64}$` in both layers. It is not a security control on its own — the
 * hash is compared against a recomputed one either way — but it turns a malformed hash into a 400
 * naming the field rather than a 409 saying "the plan changed", which is a materially more useful
 * thing for a maker to read.
 */
export class ConfirmAgentPlanDto {
  @IsString()
  @Matches(/^[0-9a-f]{64}$/, { message: 'planHash must be a 64-character lower-case sha256 hex' })
  @MatchesSharedContract(confirmAgentPlanRequestSchema)
  planHash!: string;
}
