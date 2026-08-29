/**
 * T-031 — DI wiring for `/rules`, `/rule-categories`, `/rule-sub-categories`.
 *
 * Follows `countries.module.ts`'s precedent (T-030) exactly: a module file is an addition to
 * this task's declared *Files owned* list, in the same shape T-010…T-015/T-017/T-030/T-040/
 * T-045 each set. `RbacModule` brings `ScopedRepository` and the already-global `RolesGuard`/
 * `PermissionsGuard`/`TenancyScopeInterceptor` — nothing here registers a guard or interceptor
 * of its own. `DatabaseModule` supplies `SEQUELIZE`, used for the assignment transaction and
 * the campaign-usage raw query (`campaign-usage.query.ts`).
 */
import { Module } from '@nestjs/common';
import { AuditModule } from '@/common/audit/audit.module';
import { RbacModule } from '@/common/rbac/rbac.module';
import { DatabaseModule } from '@/database/database.module';
import { RuleCategoriesController } from './rule-categories.controller';
import { RuleRegistriesController } from './rule-registries.controller';
import { RuleRegistriesService } from './rule-registries.service';
import { RulesController } from './rules.controller';
import { RulesService } from './rules.service';

@Module({
  imports: [RbacModule, AuditModule, DatabaseModule],
  controllers: [RulesController, RuleCategoriesController, RuleRegistriesController],
  providers: [RulesService, RuleRegistriesService],
  exports: [RulesService],
})
export class RulesModule {}
