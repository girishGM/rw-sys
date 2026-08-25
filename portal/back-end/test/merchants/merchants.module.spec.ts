/**
 * T-036 — `MerchantsModule`'s wiring. Same shape `tenants.module.spec.ts` (T-034) establishes.
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
import { MerchantsController } from '@/modules/merchants/merchants.controller';
import { MerchantsModule } from '@/modules/merchants/merchants.module';
import { MerchantsService } from '@/modules/merchants/merchants.service';
import { fakeSecurityConfigService } from '../security/support/fake-config.module';

interface ProviderEntry {
  provide?: unknown;
}

function providersOf(module: unknown): ProviderEntry[] {
  return (Reflect.getMetadata('providers', module as object) ?? []) as ProviderEntry[];
}

describe('MerchantsModule', () => {
  it('resolves the controller and the service', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [MerchantsModule] })
      .overrideProvider(ConfigService)
      .useValue(fakeSecurityConfigService())
      .compile();

    expect(moduleRef.get(MerchantsController)).toBeInstanceOf(MerchantsController);
    expect(moduleRef.get(MerchantsService)).toBeInstanceOf(MerchantsService);
    await moduleRef.close();
  });

  it('registers no global guard, interceptor or filter of its own', () => {
    const tokens = providersOf(MerchantsModule).map((entry) => entry.provide);

    for (const global of [APP_GUARD, APP_INTERCEPTOR, APP_FILTER]) {
      expect(tokens).not.toContain(global);
    }
  });

  it('is imported by AppModule, after RbacModule/AuthModule/AuditModule/DatabaseModule/UsersModule whose exports it consumes or whose dependency order it follows', () => {
    const imports = (Reflect.getMetadata('imports', AppModule) ?? []) as unknown[];
    const names = imports.map((entry) => (entry as { name?: string }).name);

    expect(names).toContain('MerchantsModule');
    for (const dependency of [
      'RbacModule',
      'AuthModule',
      'AuditModule',
      'DatabaseModule',
      'UsersModule',
    ]) {
      expect(names.indexOf('MerchantsModule')).toBeGreaterThan(names.indexOf(dependency));
    }
  });
});
