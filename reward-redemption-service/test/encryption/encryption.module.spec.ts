/**
 * T-RR-005. DI-wiring smoke test. `.compile()` alone does not construct any DB connection eagerly
 * beyond what `FieldEncryptionConfigRepository`'s own constructor does (opening a `pg.Pool`, which
 * lazily connects on first query — no query runs here), so this stays a fast, no-DB-round-trip
 * test, matching `ClaimWorkerModule`'s own precedent of never opening a real socket just to prove
 * DI wiring.
 */
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@/config/config.module';
import { EncryptionModule } from '@/modules/encryption/encryption.module';
import { EncryptionService } from '@/modules/encryption/encryption.service';
import { FieldEncryptionConfigRepository } from '@/modules/encryption/field-encryption-config.repository';
import { LogRedactorService } from '@/modules/encryption/log-redactor.service';

const AES_KEY_B64 = Buffer.alloc(32, 1).toString('base64');
const HMAC_KEY_B64 = Buffer.alloc(32, 2).toString('base64');

describe('EncryptionModule', () => {
  const ENV_KEYS = ['FIELD_ENCRYPTION_AES_KEY', 'FIELD_ENCRYPTION_HMAC_KEY'] as const;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  it('provides and exports every public class this module owns', async () => {
    process.env.FIELD_ENCRYPTION_AES_KEY = AES_KEY_B64;
    process.env.FIELD_ENCRYPTION_HMAC_KEY = HMAC_KEY_B64;

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, EncryptionModule],
    }).compile();

    expect(moduleRef.get(EncryptionService)).toBeInstanceOf(EncryptionService);
    expect(moduleRef.get(FieldEncryptionConfigRepository)).toBeInstanceOf(
      FieldEncryptionConfigRepository,
    );
    expect(moduleRef.get(LogRedactorService)).toBeInstanceOf(LogRedactorService);

    await moduleRef.close();
  });

  // TC-5, at the DI-compile layer: a missing key fails module construction itself, before any
  // consumer could ever obtain an `EncryptionService` instance to encrypt/decrypt/hash with.
  it('fails to compile when FIELD_ENCRYPTION_AES_KEY is unset', async () => {
    delete process.env.FIELD_ENCRYPTION_AES_KEY;
    process.env.FIELD_ENCRYPTION_HMAC_KEY = HMAC_KEY_B64;

    await expect(
      Test.createTestingModule({ imports: [ConfigModule, EncryptionModule] }).compile(),
    ).rejects.toThrow(/FIELD_ENCRYPTION_AES_KEY/);
  });

  // TC-6, at the DI-compile layer.
  it('fails to compile when FIELD_ENCRYPTION_HMAC_KEY decodes to fewer than 32 bytes', async () => {
    process.env.FIELD_ENCRYPTION_AES_KEY = AES_KEY_B64;
    process.env.FIELD_ENCRYPTION_HMAC_KEY = Buffer.alloc(8, 2).toString('base64');

    await expect(
      Test.createTestingModule({ imports: [ConfigModule, EncryptionModule] }).compile(),
    ).rejects.toThrow(/at least 32 bytes/);
  });
});
