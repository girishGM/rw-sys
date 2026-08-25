/**
 * T-014 — registers `ErrorNormalizationFilter` as the global exception filter: position 12, the
 * last link of the 00-ARCHITECTURE.md §6 chain.
 *
 * ### Why a global `APP_FILTER` rather than `app.useGlobalFilters` in `main.ts`
 *
 * The filter needs `MessageService` and `AuditService` injected. A filter registered with
 * `useGlobalFilters` is instantiated outside the DI container and would have to be constructed
 * by hand with its dependencies resolved manually — which works until one of them gains a
 * dependency of its own. `APP_FILTER` is the sanctioned way to have both, and it is the same
 * mechanism T-012 and T-013 used for their global guards.
 *
 * ### It must be able to render an error for *any* module
 *
 * A global filter is applied to every route regardless of which module imported it, so importing
 * this module once in `AppModule` covers the application. `MessagesModule` is re-exported
 * because T-015's `/me/bootstrap` ships the catalogue to the SPA and would otherwise import it
 * twice over.
 *
 * A module addition to T-014's declared *Files owned* list; recorded in the completion report.
 */
import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AuditModule } from '@/common/audit/audit.module';
import { MessagesModule } from '@/common/messages/messages.module';
import { ErrorNormalizationFilter } from './error-normalization.filter';

@Module({
  imports: [MessagesModule, AuditModule],
  providers: [{ provide: APP_FILTER, useClass: ErrorNormalizationFilter }],
  exports: [MessagesModule],
})
export class ErrorsModule {}
