/**
 * T-045 — DI wiring for `GET /audit/trace/:correlationId`.
 *
 * A module file is an addition to this task's declared *Files owned* list, following the
 * precedent T-010…T-015/T-017 each set with their own module files (`scope.module.ts`'s header
 * lists the chain); recorded as a deviation in the completion report.
 *
 * `TRACE_LOG_STORE`/`TRACE_LOG_*` are read here, not baked into `env.schema.ts` as a *required*
 * key, for the same reason T-012's block in that file gives: none is a secret, and the safe
 * default when unset — no log-store adapter, `sources.logStore: 'not_configured'` — is exactly
 * implementation note 3's graceful degradation, not a broken deployment. See `env.schema.ts`'s
 * own T-045 section, appended there under the same append-only convention its header states.
 */
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditModule } from '@/common/audit/audit.module';
import { RbacModule } from '@/common/rbac/rbac.module';
import type { Env } from '@/config/env.schema';
import { CONFIG_FETCH_ADAPTER, NullConfigFetchAdapter } from './adapters/config-fetch.adapter';
import {
  FileLogStoreAdapter,
  HttpLogStoreAdapter,
  LOG_STORE_ADAPTER,
  NullLogStoreAdapter,
  type LogStoreAdapter,
} from './adapters/log-store.adapter';
import { TRACE_SOURCE_CONFIG, type TraceSourceConfig } from './trace-source-config';
import { TraceController } from './trace.controller';
import { TraceService } from './trace.service';

@Module({
  imports: [RbacModule, AuditModule],
  controllers: [TraceController],
  providers: [
    TraceService,
    {
      provide: LOG_STORE_ADAPTER,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env>): LogStoreAdapter => {
        const kind = config.get('TRACE_LOG_STORE', { infer: true });

        if (kind === 'file') {
          const path = config.get('TRACE_LOG_FILE_PATH', { infer: true });
          if (path === undefined || path.length === 0) {
            throw new Error('TRACE_LOG_STORE=file requires TRACE_LOG_FILE_PATH to be set.');
          }
          return new FileLogStoreAdapter(path);
        }

        if (kind === 'http') {
          const url = config.get('TRACE_LOG_HTTP_URL', { infer: true });
          if (url === undefined || url.length === 0) {
            throw new Error('TRACE_LOG_STORE=http requires TRACE_LOG_HTTP_URL to be set.');
          }
          const token = config.get('TRACE_LOG_HTTP_TOKEN', { infer: true }) ?? null;
          const timeoutMs = config.get('TRACE_LOG_HTTP_TIMEOUT_MS', { infer: true });
          return new HttpLogStoreAdapter(url, token, timeoutMs);
        }

        return new NullLogStoreAdapter();
      },
    },
    // T-047's seam (adapters/config-fetch.adapter.ts). No environment switch yet — there is
    // nothing to switch to until that task's access-log table exists.
    { provide: CONFIG_FETCH_ADAPTER, useClass: NullConfigFetchAdapter },
    {
      provide: TRACE_SOURCE_CONFIG,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env>): TraceSourceConfig => ({
        logStoreConfigured: config.get('TRACE_LOG_STORE', { infer: true }) !== 'none',
        configFetchConfigured: false,
      }),
    },
  ],
  exports: [TraceService],
})
export class TraceModule {}
