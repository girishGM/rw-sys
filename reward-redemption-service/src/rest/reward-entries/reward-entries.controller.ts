/**
 * T-RR-013. The REST transport adapter for `POST /api/v1/reward-entries` (`04-REST-CONTRACT.md`
 * §1) — the third of the three ingestion channels `ARCHITECTURE.md` §6 establishes, alongside the
 * gRPC server (T-RR-011) and the Kafka consumer (T-RR-012). Per R10 ("no business logic in a
 * transport adapter") this controller does exactly three things: validate/parse the JSON body into
 * a `RewardEntryIngestDto` (`reward-entry-request.dto.ts`), call
 * `RewardIngestionService.ingest()` (T-RR-010) — the identical domain method the other two channels
 * also call — and map the returned `IngestResult` onto this endpoint's own response shape. No
 * mapping/idempotency/persistence logic of its own lives here; that is entirely T-RR-010's.
 *
 * Guarded by `IngestTokenGuard` at the class level — every request requires
 * `Authorization: Bearer <REWARD_ENTRY_INGEST_TOKEN>`, checked before the body is ever parsed for
 * business validation (implementation note 3).
 *
 * **A duplicate `id` is never an HTTP error — always `200`, reporting whatever status `ingest()`
 * returns for the existing row** (`04-REST-CONTRACT.md` §1's own explicit rule, R6, implementation
 * note 2). The HTTP "Conflict" status must never appear anywhere in this controller's response
 * paths — this task's own Definition of Done requires a `grep` of this exact file for that status
 * code's three digits to return zero matches, enforced as a real regression test in
 * `reward-entries.controller.spec.ts`'s own "R10/R6 code-inspection guard" describe block (which
 * necessarily can't spell the digits out here either, or it would fail its own check), not just
 * asserted once at review time.
 *
 * **`400` is reserved for a genuinely malformed body**, thrown by `parseRewardEntryRequest` before
 * `ingest()` is ever called (implementation note 3) — mirroring the gRPC server's
 * `INVALID_ARGUMENT` and the Kafka consumer's DLQ-eligible schema-validation failure.
 */
import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { RewardIngestionService } from '@/modules/reward-ingestion/reward-ingestion.service';
import { IngestTokenGuard } from './ingest-token.guard';
import { parseRewardEntryRequest, toRewardEntryIngestDto } from './reward-entry-request.dto';

/** Exactly the two fields `04-REST-CONTRACT.md` §1's two JSON examples show — no additional
 * fields, and no difference in shape between the fresh and duplicate cases (implementation note
 * 5); only `status`'s value differs. */
export interface RewardEntryIngestResponseDto {
  rewardEntryId: string;
  status: string;
}

@Controller('api/v1/reward-entries')
@UseGuards(IngestTokenGuard)
export class RewardEntriesController {
  constructor(private readonly ingestionService: RewardIngestionService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async submit(@Body() body: Record<string, unknown>): Promise<RewardEntryIngestResponseDto> {
    const parsed = parseRewardEntryRequest(body);
    const dto = toRewardEntryIngestDto(parsed);
    const result = await this.ingestionService.ingest(dto);

    return { rewardEntryId: result.rewardEntryId, status: result.status };
  }
}
