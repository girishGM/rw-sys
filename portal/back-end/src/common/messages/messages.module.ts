/**
 * T-014 — `MessageService` and its store, exported for the two consumers that need them:
 * `ErrorNormalizationFilter` (every error response) and `GET /me/bootstrap` (T-015, which ships
 * the whole catalogue to the SPA).
 *
 * `DatabaseModule` is imported for the `SEQUELIZE` provider the repository injects. A module
 * addition to T-014's declared *Files owned* list, following the precedent T-011/T-012/T-013 set
 * (`auth.module.ts`, `security.module.ts`, `rbac.module.ts`); recorded in the completion report.
 */
import { Module } from '@nestjs/common';
import { DatabaseModule } from '@/database/database.module';
import { MESSAGE_STORE, SystemMessageRepository } from './message.repository';
import { MessageService } from './message.service';

@Module({
  imports: [DatabaseModule],
  providers: [{ provide: MESSAGE_STORE, useClass: SystemMessageRepository }, MessageService],
  exports: [MessageService],
})
export class MessagesModule {}
