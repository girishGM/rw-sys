/**
 * T-040 — DI wiring for `/notifications`.
 *
 * A module file is an addition to this task's declared *Files owned* list, following the
 * precedent `trace.module.ts`'s own header cites (T-010…T-015/T-017/T-045 each added one).
 *
 * `NotificationsService` is exported — not just the controller — so a future producer module
 * (T-034/T-035/T-037/T-038) can `imports: [NotificationsModule]` and inject it to call `notify()`,
 * the same shape `AuditModule` exports `AuditService` for its own Wave 3 consumers.
 */
import { Module } from '@nestjs/common';
import { DatabaseModule } from '@/database/database.module';
import { RbacModule } from '@/common/rbac/rbac.module';
import { NotificationsController } from './notifications.controller';
import { NOTIFICATION_STORE, NotificationsRepository } from './notifications.repository';
import { NotificationsService } from './notifications.service';

@Module({
  // `DatabaseModule` for `SEQUELIZE` (`NotificationsRepository`'s raw-SQL insert — see that
  // file's header for why it cannot go through `ScopedRepository`); `RbacModule` for
  // `ScopedRepository` (`NotificationsService`'s read/update paths) and the
  // `Roles`/`RequirePermission` decorators this module's controller declares. Mirrors
  // `AuditModule`'s own `imports: [DatabaseModule]` for the identical reason its
  // `AuditRepository` needs `SEQUELIZE` directly.
  imports: [DatabaseModule, RbacModule],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    { provide: NOTIFICATION_STORE, useClass: NotificationsRepository },
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
