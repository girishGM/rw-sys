/**
 * T-INT-054. Wires the REST transport adapter's own controller/guard, reusing
 * `ActivityMappingModule` (T-RAP-021, exported `ActivityIngestionService`) rather than duplicating
 * it — the same "no second copy of the domain service" convention `grpc.module.ts`'s own header
 * already documents (`AGENT-PROTOCOL.md` R5).
 *
 * **Registered in `AppModule`** (`app.module.ts`), unlike every other transport-adapter module in
 * this service (`GrpcModule`, the Kafka ingest consumer, `ProgressApiModule`), which are each only
 * ever constructed as a SEPARATE `NestApplication`/`NestMicroservice` inside one of `src/main.ts`'s
 * own opt-in hybrid-bootstrap branches. This module could not use that same pattern: Render's
 * free-tier web service exposes exactly one HTTP port externally
 * (`realtime-activity-processing-service/CLAUDE.md`'s own Render deployment section — `PORT`/3020,
 * the same port `/health` already answers on), so a second `NestApplication` on its own port (the
 * way `progress-api-server.main.ts` does it) would never be reachable from outside the container on
 * Render — defeating this task's entire purpose (a REST option `test-app`'s own live Render
 * deployment can actually call). Being part of `AppModule`'s own module graph is the only way this
 * new route shares the one externally-reachable port — but `app.module.ts`'s own membership is
 * still conditional (`ACTIVITY_INGEST_REST_ENABLED`, default off), not automatic; see that file's
 * own header for why unconditional inclusion was tried first and reverted after it broke a real,
 * pre-existing test.
 *
 * **The real consequence once `ACTIVITY_INGEST_REST_ENABLED=true`, disclosed prominently here and
 * in this task's own completion report**: importing `ActivityMappingModule` pulls in
 * `EncryptionModule` (T-RAP-012) and `CampaignConfigCacheModule` (T-RAP-010) — both throw/refuse to
 * start under real, plausible misconfiguration (`EncryptionModule`'s own `EncryptionService` factory
 * throws if `FIELD_ENCRYPTION_AES_KEY`/`FIELD_ENCRYPTION_HMAC_KEY` are unset;
 * `CampaignConfigCacheService.bootstrap()` refuses to start if no local `campaign_config_snapshot`
 * row exists for a configured tenant AND the portal is unreachable). Turning this flag on therefore
 * requires the SAME prerequisites `GRPC_SERVER_ENABLED=true`/`ACTIVITY_INGEST_CONSUMER_ENABLED=true`
 * already require today (`FIELD_ENCRYPTION_*` set, a real portal connection or an already-seeded
 * snapshot) — this is not a new category of requirement, just this leg's own admission ticket into
 * the same club. `ACTIVITY_INGEST_REST_TOKEN` (`ingest-token.guard.ts`) is the one thing that still
 * fails closed per-request rather than at boot, deliberately, for the reason that file's own header
 * gives.
 */
import { Module } from '@nestjs/common';
import { ActivityMappingModule } from '@/modules/activity-mapping/activity-mapping.module';
import { ActivityIngestRestController } from './activity-ingest-rest.controller';
import { ActivityIngestRestTokenGuard } from './ingest-token.guard';

@Module({
  imports: [ActivityMappingModule],
  controllers: [ActivityIngestRestController],
  providers: [ActivityIngestRestTokenGuard],
})
export class ActivityIngestRestModule {}
