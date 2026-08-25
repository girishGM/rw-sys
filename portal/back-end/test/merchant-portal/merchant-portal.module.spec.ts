/**
 * T-039 — `MerchantPortalModule`'s wiring. Same shape `merchants.module.spec.ts` (T-036)
 * establishes — including the `AppModule` import-array assertion, which is exactly the check
 * that would have caught this task's own earlier mistake of importing `MerchantPortalModule` at
 * the top of `app.module.ts` without ever adding it to the `imports:` array.
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
import { MerchantPortalController } from '@/modules/merchant-portal/merchant-portal.controller';
import { MerchantPortalModule } from '@/modules/merchant-portal/merchant-portal.module';
import { MerchantPortalService } from '@/modules/merchant-portal/merchant-portal.service';
import { fakeSecurityConfigService } from '../security/support/fake-config.module';

interface ProviderEntry {
  provide?: unknown;
}

function providersOf(module: unknown): ProviderEntry[] {
  return (Reflect.getMetadata('providers', module as object) ?? []) as ProviderEntry[];
}

describe('MerchantPortalModule', () => {
  it('resolves the controller and the service', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [MerchantPortalModule] })
      .overrideProvider(ConfigService)
      .useValue(fakeSecurityConfigService())
      .compile();

    expect(moduleRef.get(MerchantPortalController)).toBeInstanceOf(MerchantPortalController);
    expect(moduleRef.get(MerchantPortalService)).toBeInstanceOf(MerchantPortalService);
    await moduleRef.close();
  });

  it('registers no global guard, interceptor or filter of its own', () => {
    const tokens = providersOf(MerchantPortalModule).map((entry) => entry.provide);

    for (const global of [APP_GUARD, APP_INTERCEPTOR, APP_FILTER]) {
      expect(tokens).not.toContain(global);
    }
  });

  it('is imported by AppModule, after RbacModule whose ScopedRepository export it consumes', () => {
    const imports = (Reflect.getMetadata('imports', AppModule) ?? []) as unknown[];
    const names = imports.map((entry) => (entry as { name?: string }).name);

    expect(names).toContain('MerchantPortalModule');
    expect(names.indexOf('MerchantPortalModule')).toBeGreaterThan(names.indexOf('RbacModule'));
  });
});
