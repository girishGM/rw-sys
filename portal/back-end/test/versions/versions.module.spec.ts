/**
 * T-041 — `VersionsModule`'s wiring. Same shape `test/rules/rules.module.spec.ts` (T-031)
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
import { AssignedVersionsController } from '@/modules/versions/assigned-versions.controller';
import { AssignedVersionsService } from '@/modules/versions/assigned-versions.service';
import { RewardVersionsController } from '@/modules/versions/reward-versions.controller';
import { RewardVersionsService } from '@/modules/versions/reward-versions.service';
import { RuleVersionsController } from '@/modules/versions/rule-versions.controller';
import { RuleVersionsService } from '@/modules/versions/rule-versions.service';
import { VersionsModule } from '@/modules/versions/versions.module';
import { fakeSecurityConfigService } from '../security/support/fake-config.module';

interface ProviderEntry {
  provide?: unknown;
}

function providersOf(module: unknown): ProviderEntry[] {
  return (Reflect.getMetadata('providers', module as object) ?? []) as ProviderEntry[];
}

describe('VersionsModule', () => {
  it('resolves every controller and service', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [VersionsModule] })
      .overrideProvider(ConfigService)
      .useValue(fakeSecurityConfigService())
      .compile();

    expect(moduleRef.get(RuleVersionsController)).toBeInstanceOf(RuleVersionsController);
    expect(moduleRef.get(RuleVersionsService)).toBeInstanceOf(RuleVersionsService);
    expect(moduleRef.get(RewardVersionsController)).toBeInstanceOf(RewardVersionsController);
    expect(moduleRef.get(RewardVersionsService)).toBeInstanceOf(RewardVersionsService);
    expect(moduleRef.get(AssignedVersionsController)).toBeInstanceOf(AssignedVersionsController);
    expect(moduleRef.get(AssignedVersionsService)).toBeInstanceOf(AssignedVersionsService);
    await moduleRef.close();
  });

  it('registers no global guard, interceptor or filter of its own', () => {
    const tokens = providersOf(VersionsModule).map((entry) => entry.provide);
    for (const global of [APP_GUARD, APP_INTERCEPTOR, APP_FILTER]) {
      expect(tokens).not.toContain(global);
    }
  });

  it('is imported by AppModule, after RulesModule/RewardsModule/RbacModule/AuditModule/DatabaseModule', () => {
    const imports = (Reflect.getMetadata('imports', AppModule) ?? []) as unknown[];
    const names = imports.map((entry) => (entry as { name?: string }).name);

    expect(names).toContain('VersionsModule');
    for (const dependency of ['RbacModule', 'AuditModule', 'DatabaseModule']) {
      expect(names.indexOf('VersionsModule')).toBeGreaterThan(names.indexOf(dependency));
    }
  });
});
