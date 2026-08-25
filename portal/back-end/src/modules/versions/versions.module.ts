/**
 * T-041 — DI wiring for `/rules/:id/versions`, `/rewards/:id/versions` and
 * `/countries/:id/assigned-versions`. Follows `rules.module.ts`/`rewards.module.ts`'s
 * precedent exactly: a module file is an addition to this task's declared `Files owned` list.
 * `RbacModule` brings `ScopedRepository` and the already-global guard chain; `DatabaseModule`
 * supplies `SEQUELIZE` for the campaign-usage raw queries (`version-campaign-usage.query.ts`).
 */
import { Module } from '@nestjs/common';
import { AuditModule } from '@/common/audit/audit.module';
import { RbacModule } from '@/common/rbac/rbac.module';
import { DatabaseModule } from '@/database/database.module';
import { AssignedVersionsController } from './assigned-versions.controller';
import { AssignedVersionsService } from './assigned-versions.service';
import { RewardVersionsController } from './reward-versions.controller';
import { RewardVersionsService } from './reward-versions.service';
import { RuleVersionsController } from './rule-versions.controller';
import { RuleVersionsService } from './rule-versions.service';

@Module({
  imports: [RbacModule, AuditModule, DatabaseModule],
  controllers: [RuleVersionsController, RewardVersionsController, AssignedVersionsController],
  providers: [RuleVersionsService, RewardVersionsService, AssignedVersionsService],
  exports: [RuleVersionsService, RewardVersionsService, AssignedVersionsService],
})
export class VersionsModule {}
