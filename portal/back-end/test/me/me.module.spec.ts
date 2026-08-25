/**
 * T-015 — `MeModule`'s wiring.
 *
 * Two properties, both cheap to assert and both expensive to discover at runtime:
 *
 *  1. the graph **resolves** — a missing import here is a boot-time failure of the whole
 *     application, since `AppModule` imports this module unconditionally;
 *  2. the module registers **no global guard or interceptor**. 00-ARCHITECTURE.md §6 fixes the
 *     order of that chain and says agents must not reorder it; a feature module that quietly added
 *     an `APP_GUARD` would insert itself into that order by position in `AppModule`'s import array,
 *     which is exactly the kind of change that produces no other test failure.
 */
jest.mock('@/database/database.module', () =>
  jest.requireActual('../auth/support/fake-database.module'),
);
jest.mock('@/config/config.module', () =>
  jest.requireActual('../security/support/fake-config.module'),
);

import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AppModule } from '@/app.module';
import { BootstrapService } from '@/modules/me/bootstrap.service';
import { MeController } from '@/modules/me/me.controller';
import { MeModule } from '@/modules/me/me.module';
import { MeService } from '@/modules/me/me.service';
import { fakeSecurityConfigService } from '../security/support/fake-config.module';

interface ProviderEntry {
  provide?: unknown;
}

function providersOf(module: unknown): ProviderEntry[] {
  return (Reflect.getMetadata('providers', module as object) ?? []) as ProviderEntry[];
}

describe('MeModule', () => {
  it('resolves the controller and both services', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [MeModule] })
      .overrideProvider(ConfigService)
      .useValue(fakeSecurityConfigService())
      .compile();

    expect(moduleRef.get(MeController)).toBeInstanceOf(MeController);
    expect(moduleRef.get(MeService)).toBeInstanceOf(MeService);
    expect(moduleRef.get(BootstrapService)).toBeInstanceOf(BootstrapService);
  });

  it('registers no global guard, interceptor or filter of its own', () => {
    const tokens = providersOf(MeModule).map((entry) => entry.provide);

    for (const global of [APP_GUARD, APP_INTERCEPTOR, APP_FILTER]) {
      expect(tokens).not.toContain(global);
    }
  });

  it('is imported by AppModule, after RbacModule whose exports it consumes', () => {
    const imports = (Reflect.getMetadata('imports', AppModule) ?? []) as unknown[];
    const names = imports.map((entry) => (entry as { name?: string }).name);

    expect(names).toContain('MeModule');
    expect(names.indexOf('MeModule')).toBeGreaterThan(names.indexOf('RbacModule'));
  });
});
