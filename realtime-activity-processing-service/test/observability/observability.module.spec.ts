/**
 * T-RAP-043. DI-wiring smoke test — same shape as `encryption.module.spec.ts`'s own precedent
 * (T-RAP-012, `ObservabilityModule` imports `EncryptionModule` directly for `LogRedactorService`).
 * `.compile()` alone never calls `LogRedactorService.onModuleInit` (that needs `moduleRef.init()`),
 * so this suite never touches the real DB.
 */
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@/config/config.module';
import { LogRedactorService } from '@/modules/encryption/log-redactor.service';
import { MetricsService } from '@/observability/metrics.service';
import { ObservabilityModule } from '@/observability/observability.module';
import { StructuredLogger, StructuredLoggerFactory } from '@/observability/structured-logger';

const AES_KEY_B64 = Buffer.alloc(32, 1).toString('base64');
const HMAC_KEY_B64 = Buffer.alloc(32, 2).toString('base64');

describe('ObservabilityModule', () => {
  const ENV_KEYS = ['FIELD_ENCRYPTION_AES_KEY', 'FIELD_ENCRYPTION_HMAC_KEY'] as const;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    process.env.FIELD_ENCRYPTION_AES_KEY = AES_KEY_B64;
    process.env.FIELD_ENCRYPTION_HMAC_KEY = HMAC_KEY_B64;
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

  it('provides and exports MetricsService and StructuredLoggerFactory', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, ObservabilityModule],
    }).compile();

    expect(moduleRef.get(MetricsService)).toBeInstanceOf(MetricsService);

    const loggers = moduleRef.get(StructuredLoggerFactory);
    expect(loggers).toBeInstanceOf(StructuredLoggerFactory);
    expect(loggers.forContext('AnyService')).toBeInstanceOf(StructuredLogger);

    await moduleRef.close();
  });

  it('StructuredLoggerFactory is wired to the same LogRedactorService instance the module exports', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, ObservabilityModule],
    }).compile();

    const redactor = moduleRef.get(LogRedactorService);
    // Config-driven redaction ("customerId" is redacted by the default seeded config) confirms
    // the factory-built logger is actually consulting the module's own LogRedactorService, not a
    // second, disconnected instance.
    jest.spyOn(redactor, 'resolve').mockReturnValue(true);

    const logger = moduleRef.get(StructuredLoggerFactory).forContext('IntegrationCheck');
    expect(logger.redactField('customerId', 'CUST-PLAINTEXT', {})).toBe('[REDACTED:customerId]');

    await moduleRef.close();
  });
});
