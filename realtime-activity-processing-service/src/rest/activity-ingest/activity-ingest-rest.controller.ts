/**
 * T-INT-054. The REST transport adapter for `SubmitActivity` — a new option alongside the existing
 * mTLS gRPC endpoint (`src/grpc/activity-ingest.controller.ts`), built because provisioning a real
 * mTLS CA/certificate chain for `test-app/tracking-service`'s own Render deployment was the more
 * operationally costly of this task's two options (see this task's own file, "Recommendation").
 *
 * Per `AGENT-PROTOCOL.md` R5 ("no business logic in a transport adapter") this controller does
 * exactly three things: validate/parse the JSON body (`activity-ingest-request.dto.ts`), call
 * `ActivityIngestionService.ingest()` — the identical domain method the gRPC controller (and, once
 * T-RAP-023 lands, the Kafka consumer) also calls — and map the returned `IngestResult` onto this
 * endpoint's own response shape, byte-for-byte the same fields `SubmitActivityResponseProto` carries.
 *
 * Guarded by `ActivityIngestRestTokenGuard` at the class level — see that file's own header for why
 * it reads its shared secret lazily rather than eagerly at construction (unlike this exact same
 * pattern's precedent, RR's own `IngestTokenGuard`).
 */
import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ActivityIngestionService } from '@/modules/activity-mapping/activity-ingestion.service';
import { ActivityIngestRestTokenGuard } from './ingest-token.guard';
import { parseActivityIngestRequest, toInboundActivity } from './activity-ingest-request.dto';

export interface ActivityIngestRestResponseDto {
  correlationId: string;
  status: string;
  matchedTrackerComponents: string[];
}

@Controller('api/v1/activities')
@UseGuards(ActivityIngestRestTokenGuard)
export class ActivityIngestRestController {
  constructor(private readonly ingestionService: ActivityIngestionService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async submit(@Body() body: Record<string, unknown>): Promise<ActivityIngestRestResponseDto> {
    const dto = parseActivityIngestRequest(body);
    const activity = toInboundActivity(dto);
    const result = await this.ingestionService.ingest(activity);

    return {
      correlationId: result.correlationId,
      status: result.status,
      matchedTrackerComponents: result.matchedTrackerComponents,
    };
  }
}
