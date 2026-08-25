/**
 * T-016 — the key registry's boot-time validation.
 *
 * Every test here asserts that something *fails*. That is the point: the registry has no
 * degraded mode, and each of these checks is a way the portal could otherwise start up
 * looking healthy while being unable to read its own data (or, worse, able to read it with
 * the wrong key). TC-11, TC-12, TC-15 and TC-20 all live here.
 */
import {
  DecryptionError,
  KeyRegistryError,
  KeyRegistryService,
  KEY_ALGORITHMS,
  KEY_PURPOSES,
  KEY_STATUSES,
} from '@/common/crypto';
import { FakeDb } from './support/fake-db';
import {
  BLIND_ENV,
  BLIND_KID,
  blindKeyRow,
  buildDefaultRegistry,
  buildRegistry,
  FIELD_ENV,
  FIELD_ENV_V2,
  FIELD_KID,
  FIELD_KID_V2,
  fieldKeyRow,
  keyMaterial,
  resolvers,
  testEnv,
} from './support/keys';

describe('KeyRegistryService', () => {
  describe('loading', () => {
    it('loads the happy path and exposes only metadata', async () => {
      const registry = await buildDefaultRegistry();
      expect(registry.isLoaded()).toBe(true);
      expect(registry.describe()).toEqual([
        { kid: FIELD_KID, purpose: 'field', algorithm: 'AES-256-GCM', status: 'active' },
        { kid: BLIND_KID, purpose: 'blind_index', algorithm: 'HMAC-SHA256', status: 'active' },
      ]);
      // describe() is the safe view — asserted literally, because it is what an ops endpoint
      // or a log line would print.
      expect(JSON.stringify(registry.describe())).not.toContain(keyMaterial(0x11));
    });

    it('accepts an empty registry but then refuses every operation', async () => {
      const registry = await buildRegistry([]);
      expect(registry.describe()).toEqual([]);
      expect(() => registry.getActiveKey('field')).toThrow(/No active key for purpose 'field'/);
    });

    it('exposes the enumerations it validates against', () => {
      expect(KEY_PURPOSES).toEqual(['field', 'blind_index', 'transport', 'token']);
      expect(KEY_STATUSES).toEqual(['active', 'rotating', 'retired']);
      expect(KEY_ALGORITHMS).toEqual(['AES-256-GCM', 'HMAC-SHA256', 'RSA-OAEP-256']);
    });

    it('propagates a database failure rather than starting with no keys', async () => {
      const db = new FakeDb();
      db.failKeyQueryWith = new Error('connection refused');
      const registry = new KeyRegistryService(db.asSequelize(), resolvers(testEnv()));
      await expect(registry.load()).rejects.toThrow('connection refused');
      expect(registry.isLoaded()).toBe(false);
    });
  });

  describe('TC-11 — a key_ref pointing at a missing environment variable stops the boot', () => {
    it('fails with a message naming the variable and the kid', async () => {
      await expect(buildRegistry([fieldKeyRow({ key_ref: 'env:MISSING' })])).rejects.toThrow(
        /Environment variable 'MISSING'.*kid=fld_2026_01.*is not set/s,
      );
    });

    it('fails through onModuleInit, i.e. during app.init()', async () => {
      const db = new FakeDb();
      db.keyRows = [fieldKeyRow({ key_ref: 'env:MISSING' })];
      const registry = new KeyRegistryService(db.asSequelize(), resolvers(testEnv()));
      await expect(registry.onModuleInit()).rejects.toThrow(KeyRegistryError);
    });
  });

  /**
   * T-067 — ten orphaned rows used to take ten boot-fix-reboot cycles to enumerate, because
   * `load()` died on the first one. It still refuses to boot on exactly the same conditions;
   * it just says everything it knows the first time.
   */
  describe('T-067 — every broken row is reported, not just the first', () => {
    it('names all three unresolvable variables in one failure', async () => {
      const rows = [
        fieldKeyRow({ kid: 'orphan_a', key_ref: 'env:GONE_A', status: 'rotating' }),
        fieldKeyRow({ kid: 'orphan_b', key_ref: 'env:GONE_B', status: 'rotating' }),
        blindKeyRow({ kid: 'orphan_c', key_ref: 'env:GONE_C', status: 'rotating' }),
      ];

      const error = await buildRegistry(rows).catch((err: Error) => err);

      expect(error).toBeInstanceOf(KeyRegistryError);
      const { message } = error as Error;
      expect(message).toContain('GONE_A');
      expect(message).toContain('GONE_B');
      expect(message).toContain('GONE_C');
      expect(message).toContain('3 encryption_keys rows could not be loaded');
    });

    it('still fails when only some rows are broken, and the good ones are not adopted', async () => {
      const registry = buildRegistry([
        fieldKeyRow(),
        blindKeyRow({ kid: 'orphan', key_ref: 'env:GONE', status: 'rotating' }),
      ]);
      await expect(registry).rejects.toThrow(/GONE/);
    });

    it('reports a lone failure verbatim, with no summary wrapper', async () => {
      const error = (await buildRegistry([fieldKeyRow({ key_ref: 'env:MISSING' })]).catch(
        (err: Error) => err,
      )) as Error;

      expect(error.message).toMatch(/^Environment variable 'MISSING'/);
      expect(error.message).not.toContain('rows could not be loaded');
    });

    it('mixes different kinds of row failure into the same report', async () => {
      const error = (await buildRegistry([
        fieldKeyRow({ kid: 'orphan', key_ref: 'env:GONE' }),
        blindKeyRow({ algorithm: 'AES-256-GCM' }),
      ]).catch((err: Error) => err)) as Error;

      expect(error.message).toContain('GONE');
      expect(error.message).toContain(`pairs purpose 'blind_index'`);
    });

    it('leaves a previously loaded key set untouched when a reload fails', async () => {
      const db = new FakeDb();
      const registry = await buildDefaultRegistry(db);
      expect(registry.isLoaded()).toBe(true);

      db.keyRows = [fieldKeyRow({ key_ref: 'env:GONE_ON_RELOAD' })];
      await expect(registry.load()).rejects.toThrow(/GONE_ON_RELOAD/);

      // The working set survives: a failed hot reload must not disarm a running process.
      expect(registry.isLoaded()).toBe(true);
      expect(registry.getActiveKey('field').kid).toBe(FIELD_KID);
    });

    /**
     * A resolver fault (a KMS timeout, a driver bug) is not a verdict about the operator's
     * configuration and must not be folded into the "your rows are wrong" report — it
     * propagates unchanged, keeping its own type and message.
     */
    it('propagates a non-KeyRegistryError from a resolver unchanged', async () => {
      class ExplodingResolver {
        readonly scheme = 'env' as const;
        async resolve(): Promise<Buffer> {
          throw new TypeError('kms client exploded');
        }
      }
      const db = new FakeDb();
      db.keyRows = [fieldKeyRow(), blindKeyRow()];
      const registry = new KeyRegistryService(db.asSequelize(), [new ExplodingResolver()]);

      await expect(registry.load()).rejects.toThrow(TypeError);
      await expect(registry.load()).rejects.toThrow('kms client exploded');
      expect(registry.isLoaded()).toBe(false);
    });
  });

  describe('TC-12 — a key_ref that is key material stops the boot', () => {
    it('refuses a base64 blob in key_ref', async () => {
      await expect(buildRegistry([fieldKeyRow({ key_ref: keyMaterial(0x44) })])).rejects.toThrow(
        /looks like key material/,
      );
    });

    it('refuses a base64 blob hidden behind the env: scheme', async () => {
      await expect(
        buildRegistry([fieldKeyRow({ key_ref: `env:${keyMaterial(0x44)}` })]),
      ).rejects.toThrow(/looks like key material/);
    });
  });

  describe('row validation', () => {
    it.each([
      ['an unusable kid', fieldKeyRow({ kid: 'has space' }), /not a valid key id/],
      ['an unknown purpose', fieldKeyRow({ purpose: 'feild' }), /purpose 'feild'/],
      ['an unknown status', fieldKeyRow({ status: 'paused' }), /status 'paused'/],
      ['an unknown algorithm', fieldKeyRow({ algorithm: 'DES' }), /algorithm 'DES'/],
      [
        'a field key declared as HMAC',
        fieldKeyRow({ algorithm: 'HMAC-SHA256' }),
        /pairs purpose 'field' with algorithm 'HMAC-SHA256'/,
      ],
      [
        'a blind-index key declared as AES',
        blindKeyRow({ algorithm: 'AES-256-GCM' }),
        /pairs purpose 'blind_index' with algorithm 'AES-256-GCM'/,
      ],
      [
        'RSA, which has no consumer in this build',
        fieldKeyRow({ algorithm: 'RSA-OAEP-256' }),
        /RSA-OAEP-256 has no consumer yet/,
      ],
    ])('refuses %s', async (_label, row, pattern) => {
      await expect(buildRegistry([row])).rejects.toThrow(pattern);
    });

    it('refuses a scheme with no registered resolver', async () => {
      const db = new FakeDb();
      db.keyRows = [fieldKeyRow()];
      const registry = new KeyRegistryService(db.asSequelize(), []);
      await expect(registry.load()).rejects.toThrow(/No key material resolver.*'env'/);
    });

    it.each([
      [
        'too short for AES-256',
        keyMaterial(0x55, 16),
        /is 16 bytes; AES-256-GCM requires exactly 32/,
      ],
      [
        'too long for AES-256',
        keyMaterial(0x55, 48),
        /is 48 bytes; AES-256-GCM requires exactly 32/,
      ],
    ])('refuses field key material that is %s', async (_label, material, pattern) => {
      await expect(
        buildRegistry([fieldKeyRow()], testEnv({ [FIELD_ENV]: material })),
      ).rejects.toThrow(pattern);
    });

    it('refuses an HMAC key below 32 bytes but accepts the 32–64 range', async () => {
      await expect(
        buildRegistry([blindKeyRow()], testEnv({ [BLIND_ENV]: keyMaterial(0x66, 31) })),
      ).rejects.toThrow(/requires 32–64 bytes/);
      await expect(
        buildRegistry([blindKeyRow()], testEnv({ [BLIND_ENV]: keyMaterial(0x66, 65) })),
      ).rejects.toThrow(/requires 32–64 bytes/);
      await expect(
        buildRegistry([blindKeyRow()], testEnv({ [BLIND_ENV]: keyMaterial(0x66, 64) })),
      ).resolves.toBeDefined();
    });

    it('never puts key material in an error message', async () => {
      const material = keyMaterial(0x77, 16);
      try {
        await buildRegistry([fieldKeyRow()], testEnv({ [FIELD_ENV]: material }));
        throw new Error('expected a throw');
      } catch (err) {
        expect((err as Error).message).not.toContain(material);
        expect((err as Error).message).toContain('16 bytes');
      }
    });

    it('refuses a duplicate kid even though the database also forbids it', async () => {
      await expect(
        buildRegistry([fieldKeyRow(), fieldKeyRow({ key_ref: `env:${FIELD_ENV_V2}` })]),
      ).rejects.toThrow(/Duplicate kid/);
    });

    it('refuses two active keys for the same purpose', async () => {
      await expect(
        buildRegistry([
          fieldKeyRow(),
          fieldKeyRow({ kid: FIELD_KID_V2, key_ref: `env:${FIELD_ENV_V2}` }),
        ]),
      ).rejects.toThrow(/Two active keys for purpose 'field'/);
    });
  });

  describe('TC-20 — the blind-index key must not be the field key', () => {
    it('refuses a registry where two keys resolve to the same material', async () => {
      await expect(
        buildRegistry(
          [fieldKeyRow(), blindKeyRow()],
          testEnv({ [BLIND_ENV]: keyMaterial(0x11) }), // same bytes as the field key
        ),
      ).rejects.toThrow(/resolve to identical key material/);
    });

    it('refuses two kids pointing at the same environment variable', async () => {
      // Two *distinct* kids, one active and one rotating, both resolving `env:TEST_FIELD_KEY_1`.
      // Nothing about the rows is duplicated — the duplicate is the key material behind them,
      // which is precisely the copy-paste that makes a "rotation" a no-op that looks like it
      // worked. Only `assertKeysAreDistinct` catches this; the `uq` on kid does not.
      await expect(
        buildRegistry([fieldKeyRow(), fieldKeyRow({ kid: FIELD_KID_V2, status: 'rotating' })]),
      ).rejects.toThrow(/resolve to identical key material/);
      await expect(
        buildRegistry([
          fieldKeyRow(),
          blindKeyRow({ key_ref: `env:${FIELD_ENV}`, algorithm: 'HMAC-SHA256' }),
        ]),
      ).rejects.toThrow(/resolve to identical key material/);
    });

    it('confirms the loaded keys genuinely differ', async () => {
      const registry = await buildDefaultRegistry();
      const field = registry.getActiveKey('field');
      const blind = registry.getActiveKey('blind_index');
      expect(field.kid).not.toBe(blind.kid);
      expect(field.material.equals(blind.material)).toBe(false);
    });
  });

  describe('lookup', () => {
    it('returns the active key for a purpose', async () => {
      const registry = await buildDefaultRegistry();
      expect(registry.getActiveKey('field').kid).toBe(FIELD_KID);
    });

    it('refuses a purpose with only a rotating key — rotating decrypts, never encrypts', async () => {
      const registry = await buildRegistry([fieldKeyRow({ status: 'rotating' })]);
      expect(() => registry.getActiveKey('field')).toThrow(/No active key for purpose 'field'/);
      expect(registry.getKeyForDecryption(FIELD_KID).status).toBe('rotating');
    });

    it('TC-15 — a retired key refuses to decrypt', async () => {
      const registry = await buildRegistry([
        fieldKeyRow({ kid: FIELD_KID_V2, key_ref: `env:${FIELD_ENV_V2}` }),
        fieldKeyRow({ status: 'retired' }),
      ]);
      expect(() => registry.getKeyForDecryption(FIELD_KID)).toThrow(DecryptionError);
      try {
        registry.getKeyForDecryption(FIELD_KID);
      } catch (err) {
        expect((err as DecryptionError).reason).toBe('retired_key');
        expect((err as DecryptionError).kid).toBe(FIELD_KID);
      }
    });

    it('reports an unknown kid as unknown_key', async () => {
      const registry = await buildDefaultRegistry();
      try {
        registry.getKeyForDecryption('never_existed');
        throw new Error('expected a throw');
      } catch (err) {
        expect((err as DecryptionError).reason).toBe('unknown_key');
      }
    });

    it('refuses every lookup before load() has run', () => {
      const registry = new KeyRegistryService(new FakeDb().asSequelize(), resolvers(testEnv()));
      expect(() => registry.getActiveKey('field')).toThrow(/has not been loaded/);
      expect(() => registry.getKeyForDecryption(FIELD_KID)).toThrow(/has not been loaded/);
    });
  });

  describe('reload and shutdown', () => {
    it('leaves the previous key set intact when a reload fails', async () => {
      const db = new FakeDb();
      const registry = await buildDefaultRegistry(db);
      db.keyRows = [fieldKeyRow({ key_ref: 'env:MISSING' })];

      await expect(registry.load()).rejects.toThrow(KeyRegistryError);
      // Still usable on the old key set — a failed hot reload must not disarm the portal.
      expect(registry.getActiveKey('field').kid).toBe(FIELD_KID);
    });

    it('zero-fills key material on shutdown', async () => {
      const registry = await buildDefaultRegistry();
      const material = registry.getActiveKey('field').material;
      expect(material.every((b) => b === 0)).toBe(false);

      registry.onModuleDestroy();

      expect(material.every((b) => b === 0)).toBe(true);
      expect(registry.isLoaded()).toBe(false);
    });

    it('wipes the superseded key set on a successful reload', async () => {
      const db = new FakeDb();
      const registry = await buildDefaultRegistry(db);
      const oldMaterial = registry.getActiveKey('field').material;

      db.keyRows = [fieldKeyRow({ kid: FIELD_KID_V2, key_ref: `env:${FIELD_ENV_V2}` })];
      await registry.load();

      expect(oldMaterial.every((b) => b === 0)).toBe(true);
      expect(registry.getActiveKey('field').kid).toBe(FIELD_KID_V2);
    });
  });
});
