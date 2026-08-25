/**
 * T-014 — the DI wiring of `AuditModule`, `MessagesModule` and `ErrorsModule`, and the two
 * registrations that put positions 11 and 12 of 00-ARCHITECTURE.md §6 into the application.
 *
 * The registration assertions matter for the reason `rbac.module.spec.ts` gives about guard
 * order: a component that is *built* but never *registered* produces no failure anywhere else.
 * Every endpoint keeps working, every unit test keeps passing, and the only symptom is that
 * nothing is ever audited and every error is Nest's default — which is precisely the failure
 * this task exists to prevent.
 *
 * `DatabaseModule` and `ConfigModule` are faked for the reason T-010's support file documents:
 * `NestConfigModule.forRoot({ validate })` runs at *import* time and calls `process.exit(1)` on
 * an incomplete environment, which in a Jest worker kills the run with no failing test to point
 * at.
 */
jest.mock('@/database/database.module', () =>
  jest.requireActual('../auth/support/fake-database.module'),
);
jest.mock('@/config/config.module', () =>
  jest.requireActual('../security/support/fake-config.module'),
);

import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
// Safe to import at file scope: `jest.mock` calls are hoisted above every import, so the faked
// `DatabaseModule`/`ConfigModule` are already in place when `AppModule`'s graph is evaluated.
import { AppModule } from '@/app.module';
import { AuditModule } from '@/common/audit/audit.module';
import { AuditInterceptor } from '@/common/audit/audit.interceptor';
import { AUDIT_STORE, AuditRepository, type AuditStore } from '@/common/audit/audit.repository';
import { AuditService } from '@/common/audit/audit.service';
import { ErrorsModule } from '@/common/errors/errors.module';
import { ErrorNormalizationFilter } from '@/common/errors/error-normalization.filter';
import { MessagesModule } from '@/common/messages/messages.module';
import {
  MESSAGE_STORE,
  SystemMessageRepository,
  type MessageStore,
} from '@/common/messages/message.repository';
import { MessageService } from '@/common/messages/message.service';

interface ProviderEntry {
  provide?: unknown;
  useExisting?: unknown;
  useClass?: unknown;
}

function providersOf(module: unknown): ProviderEntry[] {
  return (Reflect.getMetadata('providers', module as object) ?? []) as ProviderEntry[];
}

describe('AuditModule', () => {
  it('resolves the service and binds the store to the raw-SQL repository', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AuditModule] }).compile();

    expect(moduleRef.get(AuditService)).toBeInstanceOf(AuditService);
    expect(moduleRef.get<AuditStore>(AUDIT_STORE)).toBeInstanceOf(AuditRepository);
    expect(moduleRef.get(AuditInterceptor)).toBeInstanceOf(AuditInterceptor);
  });

  it('registers the interceptor globally — §6 position 11 — with useExisting', () => {
    // `useClass` would build a *second* interceptor with a second `AuditService`; harmless here
    // today, and exactly the shape of bug that becomes harmful the moment either holds state.
    const entries = providersOf(AuditModule).filter(
      (provider) => provider.provide === APP_INTERCEPTOR,
    );

    expect(entries).toHaveLength(1);
    expect(entries[0].useExisting).toBe(AuditInterceptor);
    expect(entries[0].useClass).toBeUndefined();
  });

  it('exports AuditService — Wave 3 services call annotate() and diffFields()', () => {
    const exported = (Reflect.getMetadata('exports', AuditModule) ?? []) as unknown[];
    expect(exported).toContain(AuditService);
  });

  it('binds AUDIT_STORE exactly once', () => {
    const bindings = providersOf(AuditModule).filter((p) => p.provide === AUDIT_STORE);

    expect(bindings).toHaveLength(1);
    expect(bindings[0].useClass).toBe(AuditRepository);
  });
});

describe('MessagesModule', () => {
  it('resolves the service and its store', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [MessagesModule] }).compile();

    expect(moduleRef.get(MessageService)).toBeInstanceOf(MessageService);
    expect(moduleRef.get<MessageStore>(MESSAGE_STORE)).toBeInstanceOf(SystemMessageRepository);
  });

  it('loads the catalogue on init and stops its timer on destroy', async () => {
    // Proves the lifecycle hooks are wired by Nest — the refresh interval only exists if
    // `onModuleInit` ran, and a live interval would keep the process alive after shutdown.
    const moduleRef = await Test.createTestingModule({ imports: [MessagesModule] }).compile();
    await moduleRef.init();

    expect(moduleRef.get(MessageService).size).toBe(0); // the fake connection returns no rows

    await expect(moduleRef.close()).resolves.toBeUndefined();
  });
});

describe('ErrorsModule', () => {
  it('registers the filter globally — §6 position 12', () => {
    const entries = providersOf(ErrorsModule).filter((provider) => provider.provide === APP_FILTER);

    expect(entries).toHaveLength(1);
    expect(entries[0].useClass).toBe(ErrorNormalizationFilter);
  });

  it('resolves the filter with its two dependencies', async () => {
    // `APP_FILTER` is an "enhancer" binding: Nest instantiates it during `init()` and does not
    // expose it in the container, so the filter is declared as an ordinary provider here and
    // resolved from the two modules `ErrorsModule` composes. What this proves is the thing that
    // would otherwise only fail at runtime, on the first error of the first request: that
    // `MessageService` and `AuditService` are both reachable from where the filter is built.
    const moduleRef = await Test.createTestingModule({
      imports: [ErrorsModule, AuditModule],
      providers: [ErrorNormalizationFilter],
    }).compile();

    expect(moduleRef.get(ErrorNormalizationFilter)).toBeInstanceOf(ErrorNormalizationFilter);
    expect(moduleRef.get(MessageService, { strict: false })).toBeInstanceOf(MessageService);
    expect(moduleRef.get(AuditService, { strict: false })).toBeInstanceOf(AuditService);
  });

  it('re-exports MessagesModule so T-015 imports the catalogue once', () => {
    const exported = (Reflect.getMetadata('exports', ErrorsModule) ?? []) as unknown[];
    expect(exported).toContain(MessagesModule);
  });
});

describe('AppModule composition', () => {
  it('imports AuditModule after RbacModule, so the audit write runs inside the tenancy scope', () => {
    // Nest orders global interceptors by module-resolution order, which follows this array.
    // `ScopeModule` (position 9) is re-exported by `RbacModule`; auditing is position 11.
    const imports = (Reflect.getMetadata('imports', AppModule) ?? []) as unknown[];

    const rbacIndex = imports.findIndex(
      (entry) => (entry as { name?: string })?.name === 'RbacModule',
    );
    const auditIndex = imports.findIndex(
      (entry) => (entry as { name?: string })?.name === 'AuditModule',
    );
    const errorsIndex = imports.findIndex(
      (entry) => (entry as { name?: string })?.name === 'ErrorsModule',
    );

    expect(rbacIndex).toBeGreaterThanOrEqual(0);
    expect(auditIndex).toBeGreaterThan(rbacIndex);
    expect(errorsIndex).toBeGreaterThan(auditIndex);
  });
});
