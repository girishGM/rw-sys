import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { HealthModule } from './health/health.module';
import { EncryptionModule } from './modules/encryption/encryption.module';
import { CacheInvalidationModule } from './modules/cache-invalidation/cache-invalidation.module';
import { TenantSchemaCacheModule } from './modules/tenant-schema-cache/tenant-schema-cache.module';
import { RewardEntriesModule } from './rest/reward-entries/reward-entries.module';

/**
 * Append-only registration point, same convention as the portal's, promo-code-service's and
 * RAP's own `app.module.ts`: each task adds its own module import line here and touches nothing
 * else in this file, so two agents working in parallel (Wave 1 onward) never collide on this
 * file's content.
 *
 * T-RR-004 replaces T-RR-001's bare `AppController` registration with the real `ConfigModule`
 * (env-driven bootstrap config, fails fast on boot) and `HealthModule` (the real, config-driven
 * `GET /health`) — `AppController`'s trivial placeholder is deleted, not left as a dead duplicate
 * registration alongside `HealthController`.
 *
 * T-RR-005 adds `EncryptionModule` — its own factory provider throws synchronously at
 * module-construction time if `FIELD_ENCRYPTION_AES_KEY`/`FIELD_ENCRYPTION_HMAC_KEY` are
 * missing/malformed (`encryption.module.ts`'s own header), so registering it here (rather than
 * deferring it, the way `ClaimWorkerModule` currently is not yet registered) is what makes this
 * task's own Verification step 3 true against the real app, not just against a standalone test
 * module.
 *
 * T-RR-007 adds `TenantSchemaCacheModule` (the four local config caches + reconciliation poller)
 * and `CacheInvalidationModule` (`POST /api/v1/cache/invalidate`) — registered eagerly for the
 * same reason `EncryptionModule` is: this task's own verification steps 2/3 curl a real running
 * dev instance and check a real `cache_invalidation_audit` row, which requires the real app, not
 * just a standalone test module, to already have this wiring.
 *
 * T-RR-013 adds `RewardEntriesModule` (`POST /api/v1/reward-entries`, `agent-rr-ingestion`'s own
 * file scope) — registered here, unlike that same agent's `GrpcModule` (T-RR-011)/
 * `KafkaConsumerRootModule` (T-RR-012), because REST has no separate transport/port of its own to
 * run a standalone process on: `04-REST-CONTRACT.md`'s "Port allocation" section and
 * `ARCHITECTURE.md` §6's transport table both place this endpoint on this service's one real HTTP
 * process (port `3030`) alongside `/health`/`POST /api/v1/cache/invalidate` above. This one-line
 * append is `RewardEntriesModule`'s own task's file-scope exception, recorded in its completion
 * report — nothing else in this file was touched to make room for it.
 */
@Module({
  imports: [
    ConfigModule,
    HealthModule,
    EncryptionModule,
    TenantSchemaCacheModule,
    CacheInvalidationModule,
    RewardEntriesModule,
  ],
})
export class AppModule {}
