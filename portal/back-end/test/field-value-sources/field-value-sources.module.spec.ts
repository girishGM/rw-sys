/**
 * T-121 — `FieldValueSourcesModule`'s wiring. Same shape `test/rules/rules.module.spec.ts` (T-031)
 * establishes: the graph resolves without a live database or environment, and the module registers
 * no global guard, interceptor or filter of its own.
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
import { FieldValueSourceRegistriesController } from '@/modules/field-value-sources/field-value-source-registries.controller';
import { FieldValueSourceRegistriesService } from '@/modules/field-value-sources/field-value-source-registries.service';
import { FieldApiLookupConfigCrypto } from '@/modules/field-value-sources/field-api-lookup-config.crypto';
import { FieldValueSourcesModule } from '@/modules/field-value-sources/field-value-sources.module';
import { fakeSecurityConfigService } from '../security/support/fake-config.module';

interface ProviderEntry {
  provide?: unknown;
}

function providersOf(module: unknown): ProviderEntry[] {
  return (Reflect.getMetadata('providers', module as object) ?? []) as ProviderEntry[];
}

describe('FieldValueSourcesModule', () => {
  it('resolves the controller, the service and the crypto helper', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [FieldValueSourcesModule] })
      .overrideProvider(ConfigService)
      .useValue(fakeSecurityConfigService())
      .compile();

    expect(moduleRef.get(FieldValueSourceRegistriesController)).toBeInstanceOf(
      FieldValueSourceRegistriesController,
    );
    expect(moduleRef.get(FieldValueSourceRegistriesService)).toBeInstanceOf(
      FieldValueSourceRegistriesService,
    );
    // If CryptoModule were missing from `imports`, FieldCryptoService would not resolve and this
    // would throw — which is the wiring mistake that would silently disable encryption.
    expect(moduleRef.get(FieldApiLookupConfigCrypto)).toBeInstanceOf(FieldApiLookupConfigCrypto);

    await moduleRef.close();
  });

  it('registers no global guard, interceptor or filter of its own', () => {
    const tokens = providersOf(FieldValueSourcesModule).map((entry) => entry.provide);

    for (const global of [APP_GUARD, APP_INTERCEPTOR, APP_FILTER]) {
      expect(tokens).not.toContain(global);
    }
  });

  it('exports the service so T-122/T-123 can consume it', () => {
    const exports = (Reflect.getMetadata('exports', FieldValueSourcesModule) ?? []) as unknown[];
    expect(exports).toContain(FieldValueSourceRegistriesService);
  });

  it('is imported by AppModule, after the modules whose exports it consumes', () => {
    const imports = (Reflect.getMetadata('imports', AppModule) ?? []) as unknown[];
    const names = imports.map((entry) => (entry as { name?: string }).name);

    expect(names).toContain('FieldValueSourcesModule');
    for (const dependency of ['RbacModule', 'AuditModule', 'DatabaseModule']) {
      expect(names.indexOf('FieldValueSourcesModule')).toBeGreaterThan(names.indexOf(dependency));
    }
  });
});
