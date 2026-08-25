/**
 * T-042 — DI wiring for `/definition-requests`. `NotificationsModule` is imported for
 * `NotificationsService` (implementation note 6's "notify on submit/review/fulfil" steps) — the
 * same `imports: [NotificationsModule]` shape `blasts.module.ts` (T-041) already establishes for
 * exactly this situation.
 */
import { Module } from '@nestjs/common';
import { AuditModule } from '@/common/audit/audit.module';
import { RbacModule } from '@/common/rbac/rbac.module';
import { NotificationsModule } from '@/modules/notifications/notifications.module';
import { DefinitionRequestsController } from './definition-requests.controller';
import { DefinitionRequestsService } from './definition-requests.service';

@Module({
  imports: [RbacModule, AuditModule, NotificationsModule],
  controllers: [DefinitionRequestsController],
  providers: [DefinitionRequestsService],
  exports: [DefinitionRequestsService],
})
export class DefinitionRequestsModule {}
