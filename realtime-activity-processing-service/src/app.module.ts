import { Module } from '@nestjs/common';
import { ConfigModule } from '@/config/config.module';
import { HealthModule } from '@/health/health.module';
import { ActivityIngestRestModule } from '@/rest/activity-ingest/activity-ingest-rest.module';

/**
 * Append-only registration point, same convention as portal/back-end's own `app.module.ts` and
 * promo-code-service's own `app.module.ts`: each task adds its own module import line here and
 * touches nothing else in this file, so two agents working in parallel (Wave 1 onward) never
 * collide on this file's content.
 *
 * T-INT-054 (`reward-service-integration-plan`, R3 disclosure: this file is normally
 * `agent-rap-foundation`'s own scope) adds `ActivityIngestRestModule` here, **conditionally**,
 * gated by `ACTIVITY_INGEST_REST_ENABLED` (default off, read directly — this project's own
 * `src/config/config.schema.ts` is a different task's file scope, same precedent every other
 * hybrid-gate env var already follows). Two things this task tried first, and rejected, with real
 * evidence from this exact codebase — recorded here so a future edit doesn't re-attempt either:
 *
 * 1. **Unconditional inclusion.** `ActivityIngestRestModule` -> `ActivityMappingModule` ->
 *    `CampaignConfigCacheModule`, whose own `onModuleInit` cold-start check
 *    (`campaign-config-cache.service.ts`) throws — crashing the ENTIRE `AppModule`, including
 *    `/health` — whenever no local `campaign_config_snapshot` row exists for a configured
 *    `PORTAL_CONFIG_TENANT_IDS` tenant AND the portal is unreachable. Proven a real regression, not
 *    a hypothetical one: `test/main/hybrid-bootstrap.e2e-spec.ts`'s own TC-1 ("with all three gates
 *    unset, only the primary HTTP listener opens") deliberately uses a fresh, never-seeded tenant id
 *    with the portal unreachable, and failed outright the moment this module was wired in
 *    unconditionally.
 * 2. **A separate `NestApplication` on its own port** (the way `progress-api-server.main.ts` does
 *    it), gated inside `src/main.ts`'s hybrid bootstrap exactly like every other transport. Rejected
 *    because Render's free-tier web service exposes exactly one HTTP port externally
 *    (`realtime-activity-processing-service/CLAUDE.md`'s own Render deployment section) — a second
 *    port would never be reachable from `test-app`'s own live Render deployment, defeating this
 *    task's entire purpose.
 *
 * So: conditional membership in `AppModule`'s own module graph, evaluated fresh each time this
 * file is first imported (safe for both Render — real env vars are already in `process.env` before
 * Node even starts the process — and this project's own Jest suite — `test/database/env.setup.ts`'s
 * `dotenv.config()` runs, and fully populates `process.env`, before any test file's own static
 * imports are evaluated; see that file's own header). Unset/false (this repo's own default,
 * `.env.development`/`.env.example`) reproduces this service's exact pre-T-INT-054 `AppModule`
 * graph, byte for byte — every existing test and Render's own current deployment are provably
 * unaffected. `activity-ingest-rest.module.ts`'s own header covers the remaining, still-real
 * consequence once this flag IS turned on: `FIELD_ENCRYPTION_AES_KEY`/`FIELD_ENCRYPTION_HMAC_KEY`
 * become required at that point too.
 */
const activityIngestRestEnabled = process.env.ACTIVITY_INGEST_REST_ENABLED === 'true';

@Module({
  imports: [
    ConfigModule,
    HealthModule,
    ...(activityIngestRestEnabled ? [ActivityIngestRestModule] : []),
  ],
})
export class AppModule {}
