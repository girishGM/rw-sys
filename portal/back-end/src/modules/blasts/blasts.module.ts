/**
 * T-041 — DI wiring for `/blasts`. `NotificationsModule` is imported for `NotificationsService`
 * (implementation note 4's "notify each country admin" step) — the same
 * `imports: [NotificationsModule]` shape that module's own header anticipates for exactly this
 * situation (*"a future producer module ... can `imports: [NotificationsModule]` and inject it
 * to call `notify()`"*).
 */
import { Module } from '@nestjs/common';
import { AuditModule } from '@/common/audit/audit.module';
import { RbacModule } from '@/common/rbac/rbac.module';
import { DatabaseModule } from '@/database/database.module';
import { NotificationsModule } from '@/modules/notifications/notifications.module';
import { BlastsController } from './blasts.controller';
import { BlastsService } from './blasts.service';

@Module({
  imports: [RbacModule, AuditModule, DatabaseModule, NotificationsModule],
  controllers: [BlastsController],
  providers: [BlastsService],
  exports: [BlastsService],
})
export class BlastsModule {}
