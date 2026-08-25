import { Inject, Module, OnModuleDestroy } from '@nestjs/common';
import type { Sequelize } from 'sequelize-typescript';
import { ConfigModule } from '@/config/config.module';
import { sequelizeProvider, SEQUELIZE } from './sequelize.provider';

/**
 * T-003 — wires `sequelizeProvider` (T-002) into Nest's DI graph for the first time; no
 * module previously imported it. Every `reward_portal` model and the covered
 * `reward_config` models are registered on the one connection this provider builds
 * (`src/database/models/index.ts`, `src/database/portal-models/index.ts`) — see
 * `sequelize.provider.ts` for why they live there rather than being added here.
 *
 * Deliberately exports only the `SEQUELIZE` token, not individual model providers: every
 * model in this codebase is a `sequelize-typescript` class with its own static
 * `create`/`findAll`/... methods once `sequelize.addModels`/the `models:` array has run, so
 * there's nothing further to inject — callers `import { PortalUser } from
 * '@/database/portal-models'` directly. `ScopedRepository` (T-013) is the intended access
 * path for request-time code; direct model access outside it is a lint violation (R2).
 *
 * Implements `OnModuleDestroy` to close the pool on `app.close()` — a plain factory
 * provider has no lifecycle hook of its own, and leaving the pg pool open past shutdown is
 * exactly the "worker process failed to exit gracefully" leak Jest's `test:e2e` run
 * surfaced the first time this module existed to actually boot the app end to end.
 */
@Module({
  imports: [ConfigModule],
  providers: [sequelizeProvider],
  exports: [SEQUELIZE],
})
export class DatabaseModule implements OnModuleDestroy {
  constructor(@Inject(SEQUELIZE) private readonly sequelize: Sequelize) {}

  async onModuleDestroy(): Promise<void> {
    await this.sequelize.close();
  }
}
