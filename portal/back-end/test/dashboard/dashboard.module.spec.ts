/**
 * T-092 — `DashboardModule`'s wiring. Same shape `test/countries/countries.module.spec.ts`
 * (T-030) establishes: the graph **resolves** without a live database or environment, and the
 * module registers **no global guard, interceptor or filter of its own** —
 * 00-ARCHITECTURE.md §6 fixes that chain, and a feature module that quietly added one would
 * insert itself into that order by its position in `AppModule`'s import array.
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
import { DashboardController } from '@/modules/dashboard/dashboard.controller';
import { DashboardModule } from '@/modules/dashboard/dashboard.module';
import { DashboardService } from '@/modules/dashboard/dashboard.service';
import { fakeSecurityConfigService } from '../security/support/fake-config.module';

interface ProviderEntry {
  provide?: unknown;
}

function providersOf(module: unknown): ProviderEntry[] {
  return (Reflect.getMetadata('providers', module as object) ?? []) as ProviderEntry[];
}

describe('DashboardModule', () => {
  it('resolves the controller and the service', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [DashboardModule] })
      .overrideProvider(ConfigService)
      .useValue(fakeSecurityConfigService())
      .compile();

    expect(moduleRef.get(DashboardController)).toBeInstanceOf(DashboardController);
    expect(moduleRef.get(DashboardService)).toBeInstanceOf(DashboardService);
    await moduleRef.close();
  });

  it('registers no global guard, interceptor or filter of its own', () => {
    const tokens = providersOf(DashboardModule).map((entry) => entry.provide);

    for (const global of [APP_GUARD, APP_INTERCEPTOR, APP_FILTER]) {
      expect(tokens).not.toContain(global);
    }
  });

  it('is imported by AppModule, after TenantsModule/MerchantPortalModule whose exports it consumes', () => {
    const imports = (Reflect.getMetadata('imports', AppModule) ?? []) as unknown[];
    const names = imports.map((entry) => (entry as { name?: string }).name);

    expect(names).toContain('DashboardModule');
    for (const dependency of ['TenantsModule', 'MerchantPortalModule', 'RbacModule']) {
      expect(names.indexOf('DashboardModule')).toBeGreaterThan(names.indexOf(dependency));
    }
  });
});
