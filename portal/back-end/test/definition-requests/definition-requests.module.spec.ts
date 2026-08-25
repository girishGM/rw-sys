/**
 * T-042 — `DefinitionRequestsModule`'s wiring. Same shape `test/blasts/blasts.module.spec.ts`
 * (T-041) establishes: the graph resolves without a live database or environment, and the
 * module registers no global guard, interceptor or filter of its own.
 */
jest.mock('@/database/database.module', () =>
  jest.requireActual('../auth/support/fake-database.module'),
);
jest.mock('@/config/config.module', () =>
  jest.requireActual('../security/support/fake-config.module'),
);

import 'reflect-metadata';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AppModule } from '@/app.module';
import { DefinitionRequestsController } from '@/modules/definition-requests/definition-requests.controller';
import { DefinitionRequestsModule } from '@/modules/definition-requests/definition-requests.module';
import { DefinitionRequestsService } from '@/modules/definition-requests/definition-requests.service';
import { fakeSecurityConfigService } from '../security/support/fake-config.module';

interface ProviderEntry {
  provide?: unknown;
}

function providersOf(module: unknown): ProviderEntry[] {
  return (Reflect.getMetadata('providers', module as object) ?? []) as ProviderEntry[];
}

describe('DefinitionRequestsModule', () => {
  it('resolves the controller and the service', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [DefinitionRequestsModule] })
      .overrideProvider(ConfigService)
      .useValue(fakeSecurityConfigService())
      .compile();

    expect(moduleRef.get(DefinitionRequestsController)).toBeInstanceOf(
      DefinitionRequestsController,
    );
    expect(moduleRef.get(DefinitionRequestsService)).toBeInstanceOf(DefinitionRequestsService);
    await moduleRef.close();
  });

  it('registers no global guard, interceptor or filter of its own', () => {
    const tokens = providersOf(DefinitionRequestsModule).map((entry) => entry.provide);
    for (const global of [APP_GUARD, APP_INTERCEPTOR, APP_FILTER]) {
      expect(tokens).not.toContain(global);
    }
  });

  it('is imported by AppModule, after RbacModule/AuditModule/NotificationsModule/VersionsModule/BlastsModule', () => {
    const imports = (Reflect.getMetadata('imports', AppModule) ?? []) as unknown[];
    const names = imports.map((entry) => (entry as { name?: string }).name);

    expect(names).toContain('DefinitionRequestsModule');
    const dependencies = [
      'RbacModule',
      'AuditModule',
      'NotificationsModule',
      'VersionsModule',
      'BlastsModule',
    ];
    for (const dependency of dependencies) {
      expect(names.indexOf('DefinitionRequestsModule')).toBeGreaterThan(names.indexOf(dependency));
    }
  });
});
