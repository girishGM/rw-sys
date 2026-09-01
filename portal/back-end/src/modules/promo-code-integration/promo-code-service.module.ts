/**
 * T-166 — DI wiring for the one outbound call to promo-code-service.
 *
 * A one-provider module, in the shape `change-events.module.ts` (T-047) established for the same
 * situation: `CampaignsModule` needs *a place to register a binding*, not a dependency on an
 * integration subsystem. Keeping it separate means the promo-code integration can be removed by
 * deleting this directory and one import line — which is exactly this task's stated rollback.
 *
 * It imports nothing: `ConfigModule` is `@Global` (see `config.module.ts`), so
 * `PromoCodeServiceClient` gets its `ConfigService` without this module asking. It registers no
 * guard, interceptor or filter.
 *
 * Deliberately **not** registered in `app.module.ts`. Nothing here is a listener, a controller or
 * a scheduled job — the only consumer is `CampaignsModule`, which imports it directly. A module
 * in `app.module.ts` that no root-level surface uses reads as "this runs on boot", and it does not.
 */
import { Module } from '@nestjs/common';
import { PromoCodeServiceClient } from './promo-code-service.client';

@Module({
  providers: [PromoCodeServiceClient],
  exports: [PromoCodeServiceClient],
})
export class PromoCodeServiceModule {}
