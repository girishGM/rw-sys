/**
 * T-030 — `CountriesModule`'s wiring.
 *
 * Same shape `test/me/me.module.spec.ts` (T-015) establishes: the graph **resolves** without a
 * live database or environment (a missing import here is a boot-time failure of the whole
 * application, since `AppModule` imports this module unconditionally), and the module registers
 * **no global guard, interceptor or filter of its own** — 00-ARCHITECTURE.md §6 fixes that chain,
 * and a feature module that quietly added one would insert itself into that order by its position
 * in `AppModule`'s import array, which is exactly the kind of change that produces no other test
 * failure.
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
import { CountriesController } from '@/modules/countries/countries.controller';
import { CountriesModule } from '@/modules/countries/countries.module';
import { CountriesService } from '@/modules/countries/countries.service';
import { fakeSecurityConfigService } from '../security/support/fake-config.module';

interface ProviderEntry {
  provide?: unknown;
}

function providersOf(module: unknown): ProviderEntry[] {
  return (Reflect.getMetadata('providers', module as object) ?? []) as ProviderEntry[];
}

describe('CountriesModule', () => {
  it('resolves the controller and the service', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [CountriesModule] })
      .overrideProvider(ConfigService)
      .useValue(fakeSecurityConfigService())
      .compile();

    expect(moduleRef.get(CountriesController)).toBeInstanceOf(CountriesController);
    expect(moduleRef.get(CountriesService)).toBeInstanceOf(CountriesService);
    await moduleRef.close();
  });

  it('registers no global guard, interceptor or filter of its own', () => {
    const tokens = providersOf(CountriesModule).map((entry) => entry.provide);

    for (const global of [APP_GUARD, APP_INTERCEPTOR, APP_FILTER]) {
      expect(tokens).not.toContain(global);
    }
  });

  it('is imported by AppModule, after RbacModule/AuthModule/AuditModule/DatabaseModule whose exports it consumes', () => {
    const imports = (Reflect.getMetadata('imports', AppModule) ?? []) as unknown[];
    const names = imports.map((entry) => (entry as { name?: string }).name);

    expect(names).toContain('CountriesModule');
    for (const dependency of ['RbacModule', 'AuthModule', 'AuditModule', 'DatabaseModule']) {
      expect(names.indexOf('CountriesModule')).toBeGreaterThan(names.indexOf(dependency));
    }
  });
});
