/**
 * T-032 — `RewardsModule`'s wiring. Same shape `test/rules/rules.module.spec.ts` (T-031)
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
import { RewardConnectorConfigCrypto } from '@/modules/rewards/reward-connector-config.crypto';
import { RewardsController } from '@/modules/rewards/rewards.controller';
import { RewardsModule } from '@/modules/rewards/rewards.module';
import { RewardsService } from '@/modules/rewards/rewards.service';
import { fakeSecurityConfigService } from '../security/support/fake-config.module';

interface ProviderEntry {
  provide?: unknown;
}

function providersOf(module: unknown): ProviderEntry[] {
  return (Reflect.getMetadata('providers', module as object) ?? []) as ProviderEntry[];
}

describe('RewardsModule', () => {
  it('resolves the controller, the service and the connector-config crypto helper', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [RewardsModule] })
      .overrideProvider(ConfigService)
      .useValue(fakeSecurityConfigService())
      .compile();

    expect(moduleRef.get(RewardsController)).toBeInstanceOf(RewardsController);
    expect(moduleRef.get(RewardsService)).toBeInstanceOf(RewardsService);
    expect(moduleRef.get(RewardConnectorConfigCrypto)).toBeInstanceOf(RewardConnectorConfigCrypto);
    await moduleRef.close();
  });

  it('registers no global guard, interceptor or filter of its own', () => {
    const tokens = providersOf(RewardsModule).map((entry) => entry.provide);

    for (const global of [APP_GUARD, APP_INTERCEPTOR, APP_FILTER]) {
      expect(tokens).not.toContain(global);
    }
  });

  it('is imported by AppModule, after RbacModule/AuditModule/DatabaseModule/CryptoModule whose exports it consumes', () => {
    const imports = (Reflect.getMetadata('imports', AppModule) ?? []) as unknown[];
    const names = imports.map((entry) => (entry as { name?: string }).name);

    expect(names).toContain('RewardsModule');
    for (const dependency of ['RbacModule', 'AuditModule', 'DatabaseModule']) {
      expect(names.indexOf('RewardsModule')).toBeGreaterThan(names.indexOf(dependency));
    }
  });
});
