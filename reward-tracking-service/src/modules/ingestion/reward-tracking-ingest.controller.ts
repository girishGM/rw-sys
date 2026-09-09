/**
 * T-RTS-013. The REST transport adapter for `POST /internal/reward-tracking-events` — the third of
 * the three ingestion channels this wave builds, alongside the gRPC server (T-RTS-011) and the
 * Kafka consumer (T-RTS-012). Per `AGENT-PROTOCOL.md` R8 ("no business logic in a transport
 * adapter") this controller does exactly three things: validate/parse the JSON body into an
 * `ApplyRewardTrackingEventInput` (`reward-tracking-ingest.dto.ts`), call
 * `RewardTrackingIngestionService.applyRewardTrackingEvent()` (T-RTS-010) — the identical domain
 * method the gRPC controller and the Kafka consumer also call — and map the returned result onto
 * this endpoint's own `{status: 'applied' | 'duplicate'}` response. No mapping/idempotency/
 * persistence logic of its own lives here; that is entirely T-RTS-010's.
 *
 * On Render today this is the practical primary channel — no managed Kafka/gRPC-mTLS there yet
 * (this task's own "Risk" note, mirroring `reward-redemption-service-plan/ARCHITECTURE.md` §9's
 * identical reasoning for its own outbound leg) — so it gets the same care as the other two despite
 * being structurally the simplest of the three.
 *
 * **`RewardTrackingIngestTokenGuard` lives in this file, not a dedicated file of its own** — this
 * task's own "Files owned" list names exactly three files (this controller, the DTO, and this
 * controller's own spec), no fourth `*.guard.ts` file, so the guard is defined here rather than
 * introducing a file outside this task's declared scope. Reads `REWARD_TRACKING_INGEST_TOKEN`
 * directly from `process.env` (never through `ConfigService`/`config.schema.ts`, which is
 * `agent-rts-foundation`'s exclusive file scope, R10) — the same "bearer tokens are not part of the
 * bootstrap config schema" convention `reward-redemption-service`'s own `IngestTokenGuard`
 * (`src/rest/reward-entries/ingest-token.guard.ts`, confirmed by direct read) already established,
 * and the same constant-time (`timingSafeEqual`) comparison that guard uses, so a naive `===` never
 * leaks, via response-time variance, how many leading characters of a guessed token are correct.
 *
 * **A dedicated secret, never shared with any other trust domain** (this task's own implementation
 * note 1) — `REWARD_TRACKING_INGEST_TOKEN` is distinct from whatever bearer secret Wave 3's
 * customer-facing/portal-admin read APIs eventually use (`src/modules/auth/**`, `agent-rts-api`'s
 * own file scope): a lower-trust caller (a customer-facing token) must never be handed a
 * higher-trust capability (writing a `reward_fact` row).
 *
 * **Not registered in `AppModule`'s own imports by this task** — `app.module.ts` is exclusively
 * `agent-rts-foundation`'s file scope, same gap `T-RTS-011`'s own `grpc.module.ts` and `T-RTS-012`'s
 * own `kafka.module.ts` already flagged for their own transports. This controller is fully
 * self-contained and independently testable via `Test.createTestingModule({ controllers: [...] })`
 * instead (this task's own spec file); wiring it into the real HTTP app's `AppModule` is a follow-up
 * for `agent-rts-foundation`, flagged in this task's own completion report.
 */
import {
  BadRequestException,
  Body,
  type CanActivate,
  Controller,
  type ExecutionContext,
  HttpCode,
  HttpStatus,
  Injectable,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { MetricsService } from '@/observability/metrics.service';
import { StructuredLoggerFactory, type StructuredLogger } from '@/observability/logging.module';
import { RewardTrackingIngestionService } from './reward-tracking-ingestion.service';
import { parseRewardTrackingIngestRequest } from './reward-tracking-ingest.dto';

const BEARER_PREFIX = 'Bearer ';

export class MissingRewardTrackingIngestTokenError extends Error {
  constructor() {
    super(
      'Missing required environment variable REWARD_TRACKING_INGEST_TOKEN — set it in ' +
        '.env.development (see .env.example) before RewardTrackingIngestController can construct ' +
        'its auth guard.',
    );
    this.name = 'MissingRewardTrackingIngestTokenError';
  }
}

/** Constant-time comparison — both inputs are length-checked first since `timingSafeEqual` itself
 * throws on mismatched buffer lengths rather than returning `false`. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/** T-RTS-049 item 4 — best-effort `correlationId` extraction for the error-path log below: a
 * request whose body isn't an object at all, or whose `correlationId` field is itself the missing/
 * invalid field, has nothing real to report — `'unknown'` keeps `StructuredLogger` (which requires
 * a non-blank `correlationId`) from throwing a second, masking error on top of the one already
 * being reported. Never contains `customerId` (TC-4-equivalent for this channel) since it reads
 * only the one named field. */
function correlationIdOrUnknown(body: unknown): string {
  if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
    const value = (body as Record<string, unknown>).correlationId;
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return 'unknown';
}

@Injectable()
export class RewardTrackingIngestTokenGuard implements CanActivate {
  private readonly token: string;

  constructor() {
    const token = process.env.REWARD_TRACKING_INGEST_TOKEN;
    if (!token || token.trim().length === 0) {
      throw new MissingRewardTrackingIngestTokenError();
    }
    this.token = token;
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers.authorization;

    if (!header || !header.startsWith(BEARER_PREFIX)) {
      throw new UnauthorizedException('Missing or malformed Authorization header');
    }

    const presented = header.slice(BEARER_PREFIX.length).trim();
    // TC-3: presenting e.g. a Wave-3 customer/portal-admin token here fails this same branch —
    // `token` is always read from `REWARD_TRACKING_INGEST_TOKEN` above, a distinct env var/secret,
    // so the two are never interchangeable by construction, not by an extra check.
    if (presented.length === 0 || !safeEqual(presented, this.token)) {
      throw new UnauthorizedException('Invalid reward tracking ingest token');
    }

    return true;
  }
}

/** Identical outcome enum the gRPC/Kafka channels' own domain call already produces
 * (implementation note 2) — no other field, so a caller can assert on outcome without caring which
 * of the three channels was used. */
export interface RewardTrackingIngestResponseDto {
  status: 'applied' | 'duplicate';
}

@Controller('internal/reward-tracking-events')
@UseGuards(RewardTrackingIngestTokenGuard)
export class RewardTrackingIngestController {
  /** T-RTS-049 item 4. */
  private readonly structuredLogger: StructuredLogger;

  constructor(
    private readonly ingestionService: RewardTrackingIngestionService,
    private readonly metrics: MetricsService,
    loggers: StructuredLoggerFactory,
  ) {
    this.structuredLogger = loggers.forContext(RewardTrackingIngestController.name);
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  async submit(@Body() body: unknown): Promise<RewardTrackingIngestResponseDto> {
    try {
      if (body === undefined) {
        // An empty/no body never reaches `parseRewardTrackingIngestRequest`'s own object-shape
        // check with a useful `unknown` value to report on — fail the same way, explicitly, rather
        // than let `typeof undefined !== 'object'` produce a slightly different message.
        throw new BadRequestException('request body must be a JSON object');
      }
      const input = parseRewardTrackingIngestRequest(body);
      const result = await this.ingestionService.applyRewardTrackingEvent(input);
      return { status: result.status };
    } catch (error) {
      // T-RTS-049 item 4 — this REST channel's own error path that never reaches
      // `applyRewardTrackingEvent()` (a body-validation failure, thrown before the call) never gets
      // that shared method's own success-path increment/log; this covers it. A genuine failure
      // thrown BY `applyRewardTrackingEvent()` itself (e.g. a DB outage) also lands here — it never
      // reached that method's own increment either (thrown before `return`), so metering it here is
      // the correct complement, not a duplicate, mirroring the gRPC channel's identical "both
      // branches count as failed" precedent (this task's own evidence, item 2).
      this.metrics.incrementEventsIngested('REST', 'failed');
      this.structuredLogger.error('failed to ingest reward tracking event over REST', {
        correlationId: correlationIdOrUnknown(body),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}
