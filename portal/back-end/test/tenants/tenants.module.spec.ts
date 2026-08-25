/**
 * T-034 — `TenantsModule`'s wiring. Same shape `countries.module.spec.ts` (T-030) establishes.
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
import { TenantsController } from '@/modules/tenants/tenants.controller';
import { TenantsModule } from '@/modules/tenants/tenants.module';
import { TenantsService } from '@/modules/tenants/tenants.service';
import { fakeSecurityConfigService } from '../security/support/fake-config.module';

interface ProviderEntry {
  provide?: unknown;
}

function providersOf(module: unknown): ProviderEntry[] {
  return (Reflect.getMetadata('providers', module as object) ?? []) as ProviderEntry[];
}

describe('TenantsModule', () => {
  it('resolves the controller and the service', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [TenantsModule] })
      .overrideProvider(ConfigService)
      .useValue(fakeSecurityConfigService())
      .compile();

    expect(moduleRef.get(TenantsController)).toBeInstanceOf(TenantsController);
    expect(moduleRef.get(TenantsService)).toBeInstanceOf(TenantsService);
    await moduleRef.close();
  });

  it('registers no global guard, interceptor or filter of its own', () => {
    const tokens = providersOf(TenantsModule).map((entry) => entry.provide);

    for (const global of [APP_GUARD, APP_INTERCEPTOR, APP_FILTER]) {
      expect(tokens).not.toContain(global);
    }
  });

  it('is imported by AppModule, after RbacModule/AuthModule/AuditModule/DatabaseModule whose exports it consumes', () => {
    const imports = (Reflect.getMetadata('imports', AppModule) ?? []) as unknown[];
    const names = imports.map((entry) => (entry as { name?: string }).name);

    expect(names).toContain('TenantsModule');
    for (const dependency of ['RbacModule', 'AuthModule', 'AuditModule', 'DatabaseModule']) {
      expect(names.indexOf('TenantsModule')).toBeGreaterThan(names.indexOf(dependency));
    }
  });
});
