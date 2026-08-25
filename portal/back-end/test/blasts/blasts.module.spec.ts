/**
 * T-041 — `BlastsModule`'s wiring. Same shape `test/versions/versions.module.spec.ts` and
 * `test/rules/rules.module.spec.ts` establish.
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
import { BlastsController } from '@/modules/blasts/blasts.controller';
import { BlastsModule } from '@/modules/blasts/blasts.module';
import { BlastsService } from '@/modules/blasts/blasts.service';
import { fakeSecurityConfigService } from '../security/support/fake-config.module';

interface ProviderEntry {
  provide?: unknown;
}

function providersOf(module: unknown): ProviderEntry[] {
  return (Reflect.getMetadata('providers', module as object) ?? []) as ProviderEntry[];
}

describe('BlastsModule', () => {
  it('resolves the controller and the service', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [BlastsModule] })
      .overrideProvider(ConfigService)
      .useValue(fakeSecurityConfigService())
      .compile();

    expect(moduleRef.get(BlastsController)).toBeInstanceOf(BlastsController);
    expect(moduleRef.get(BlastsService)).toBeInstanceOf(BlastsService);
    await moduleRef.close();
  });

  it('registers no global guard, interceptor or filter of its own', () => {
    const tokens = providersOf(BlastsModule).map((entry) => entry.provide);
    for (const global of [APP_GUARD, APP_INTERCEPTOR, APP_FILTER]) {
      expect(tokens).not.toContain(global);
    }
  });

  it('is imported by AppModule, after RbacModule/AuditModule/DatabaseModule/NotificationsModule', () => {
    const imports = (Reflect.getMetadata('imports', AppModule) ?? []) as unknown[];
    const names = imports.map((entry) => (entry as { name?: string }).name);

    expect(names).toContain('BlastsModule');
    const dependencies = ['RbacModule', 'AuditModule', 'DatabaseModule', 'NotificationsModule'];
    for (const dependency of dependencies) {
      expect(names.indexOf('BlastsModule')).toBeGreaterThan(names.indexOf(dependency));
    }
  });
});
