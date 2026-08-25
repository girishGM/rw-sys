/**
 * T-031 — `RulesModule`'s wiring. Same shape `test/countries/countries.module.spec.ts` (T-030)
 * establishes: the graph resolves without a live database or environment, and the module
 * registers no global guard, interceptor or filter of its own.
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
import { RuleCategoriesController } from '@/modules/rules/rule-categories.controller';
import { RulesController } from '@/modules/rules/rules.controller';
import { RulesModule } from '@/modules/rules/rules.module';
import { RulesService } from '@/modules/rules/rules.service';
import { fakeSecurityConfigService } from '../security/support/fake-config.module';

interface ProviderEntry {
  provide?: unknown;
}

function providersOf(module: unknown): ProviderEntry[] {
  return (Reflect.getMetadata('providers', module as object) ?? []) as ProviderEntry[];
}

describe('RulesModule', () => {
  it('resolves both controllers and the service', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [RulesModule] })
      .overrideProvider(ConfigService)
      .useValue(fakeSecurityConfigService())
      .compile();

    expect(moduleRef.get(RulesController)).toBeInstanceOf(RulesController);
    expect(moduleRef.get(RuleCategoriesController)).toBeInstanceOf(RuleCategoriesController);
    expect(moduleRef.get(RulesService)).toBeInstanceOf(RulesService);
    await moduleRef.close();
  });

  it('registers no global guard, interceptor or filter of its own', () => {
    const tokens = providersOf(RulesModule).map((entry) => entry.provide);

    for (const global of [APP_GUARD, APP_INTERCEPTOR, APP_FILTER]) {
      expect(tokens).not.toContain(global);
    }
  });

  it('is imported by AppModule, after RbacModule/AuditModule/DatabaseModule whose exports it consumes', () => {
    const imports = (Reflect.getMetadata('imports', AppModule) ?? []) as unknown[];
    const names = imports.map((entry) => (entry as { name?: string }).name);

    expect(names).toContain('RulesModule');
    for (const dependency of ['RbacModule', 'AuditModule', 'DatabaseModule']) {
      expect(names.indexOf('RulesModule')).toBeGreaterThan(names.indexOf(dependency));
    }
  });
});
