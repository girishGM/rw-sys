/**
 * T-016 — `CryptoModule`'s DI wiring.
 *
 * A module file looks too trivial to test right up until the graph it describes stops
 * resolving. Everything this spec asserts is something that fails *at boot in production* and
 * nowhere else: a provider missing from `providers`, a service missing from `exports` (so
 * T-010/T-017/T-018 cannot inject it), or the `KEY_MATERIAL_RESOLVERS` factory not being
 * wired, which would leave the registry unable to turn any `key_ref` into bytes.
 *
 * ### Why `DatabaseModule` is mocked out
 *
 * `CryptoModule` imports `DatabaseModule` → `ConfigModule` → `NestConfigModule.forRoot({
 * validate })`, and `forRoot` runs `validateEnv` **synchronously, at import time**, calling
 * `process.exit(1)` on an incomplete environment. A unit spec that can kill the Jest worker
 * depending on which `.env` files happen to exist on the machine is not a unit spec. The mock
 * below supplies the one thing `CryptoModule` actually needs from it — the `SEQUELIZE` token —
 * backed by `FakeDb`. `crypto.e2e-spec.ts` boots the real module against the real database,
 * which is where "does this wire up against the genuine article" is answered.
 */
import { Test } from '@nestjs/testing';

/**
 * Jest hoists this above every `import` below, so the replacement has to be reached through
 * `jest.requireActual` rather than a top-level import that has not run yet.
 */
jest.mock('@/database/database.module', () => jest.requireActual('./support/fake-database.module'));

import {
  BlindIndexService,
  EnvKeyMaterialResolver,
  FieldCryptoService,
  KEY_MATERIAL_RESOLVERS,
  KeyRegistryService,
  RotateKeysCommand,
  UnconfiguredKmsResolver,
  type KeyMaterialResolver,
} from '@/common/crypto';
import { CryptoModule, keyMaterialResolversProvider } from '@/common/crypto/crypto.module';
import { BLIND_ENV, FIELD_ENV, FIELD_ENV_V2, testEnv } from './support/keys';

/**
 * The module's own resolver factory reads the real `process.env` (that is the point of it), so
 * the test keys have to be there before Nest resolves the graph. Restored afterwards — a spec
 * that leaks key-shaped environment variables into the rest of the run is a spec that makes
 * some *other* test pass for the wrong reason.
 */
const ENV_KEYS = [FIELD_ENV, FIELD_ENV_V2, BLIND_ENV];
const savedEnv = new Map<string, string | undefined>();

beforeAll(() => {
  const values = testEnv();
  for (const name of ENV_KEYS) {
    savedEnv.set(name, process.env[name]);
    process.env[name] = values[name];
  }
});

afterAll(() => {
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('CryptoModule', () => {
  describe('keyMaterialResolversProvider', () => {
    it('registers exactly the env and kms schemes, in that order', () => {
      const resolvers = keyMaterialResolversProvider.useFactory() as readonly KeyMaterialResolver[];

      expect(resolvers.map((r) => r.scheme)).toEqual(['env', 'kms']);
      expect(resolvers[0]).toBeInstanceOf(EnvKeyMaterialResolver);
      // Registered on purpose rather than omitted: a `kms:` key_ref with no resolver must
      // fail loudly at boot, never fall back to an environment variable the deployment
      // deliberately chose not to use.
      expect(resolvers[1]).toBeInstanceOf(UnconfiguredKmsResolver);
    });

    it('is bound to the KEY_MATERIAL_RESOLVERS token the registry injects', () => {
      expect(keyMaterialResolversProvider.provide).toBe(KEY_MATERIAL_RESOLVERS);
    });
  });

  describe('the resolved graph', () => {
    it('boots, loads the registry, and hands out working crypto services', async () => {
      const moduleRef = await Test.createTestingModule({ imports: [CryptoModule] }).compile();
      // `compile()` builds the graph; `init()` is what runs onModuleInit, i.e. the key load.
      await moduleRef.init();

      try {
        const registry = moduleRef.get(KeyRegistryService);
        expect(registry.isLoaded()).toBe(true);
        expect(registry.describe().map((k) => `${k.kid}/${k.purpose}/${k.status}`)).toEqual([
          'fld_2026_01/field/active',
          'bidx_2026_01/blind_index/active',
        ]);

        // Every service T-010/T-017/T-018 will inject must be reachable from outside the
        // module, not merely constructed inside it.
        const fieldCrypto = moduleRef.get(FieldCryptoService);
        const blindIndex = moduleRef.get(BlindIndexService);
        expect(moduleRef.get(RotateKeysCommand)).toBeInstanceOf(RotateKeysCommand);

        // Not just "is defined" — the wired-up services share the one registry and actually
        // work end to end.
        const aad = FieldCryptoService.aadFor('reward_portal.portal_users', 1);
        const ciphertext = fieldCrypto.encrypt('someone@example.com', { aad });
        expect(fieldCrypto.decrypt(ciphertext, { aad })).toBe('someone@example.com');
        expect(blindIndex.compute('Someone@Example.com', 'email')).toBe(
          blindIndex.compute('someone@example.com', 'email'),
        );
      } finally {
        await moduleRef.close();
      }
    });

    it('wipes resolved key material on shutdown', async () => {
      const moduleRef = await Test.createTestingModule({ imports: [CryptoModule] }).compile();
      await moduleRef.init();
      const registry = moduleRef.get(KeyRegistryService);
      expect(registry.isLoaded()).toBe(true);

      await moduleRef.close();

      // onModuleDestroy zero-fills the buffers and drops the maps, so a heap dump taken after
      // shutdown holds no live key.
      expect(registry.isLoaded()).toBe(false);
      expect(registry.describe()).toEqual([]);
    });
  });
});
