/**
 * T-RTS-010 — `ShardCountResolverService`. The "real seeded value" test runs against the real
 * Postgres 16 server (root `CLAUDE.md`) — `T-RTS-002`'s own migration seeds exactly one `GLOBAL` row
 * for `tracking.campaignCounterShardCount = 32` — while TC-6 (unseeded) and the malformed-value guard
 * use a fake `Pool` (same idiom `redemption-state-machine.service.spec.ts`'s own "rolled-back
 * transition" test already establishes in the sibling service), since the real DB genuinely has this
 * key seeded and there is no way to ask the resolver to look up a different key.
 */
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import type { Config } from '@/config/config.schema';
import {
  DEFAULT_SHARD_COUNT,
  InvalidShardCountConfigError,
  ShardCountResolverService,
} from '@/modules/ingestion/shard-count-resolver.service';

function realDbConfigService(): ConfigService<Config, true> {
  const values: Partial<Config> = {
    DB_HOST: process.env.DB_HOST,
    DB_PORT: Number(process.env.DB_PORT),
    DB_NAME: process.env.DB_NAME,
    DB_SSL: process.env.DB_SSL === 'true',
    DB_APP_USERNAME: process.env.DB_APP_USERNAME,
    DB_APP_PASSWORD: process.env.DB_APP_PASSWORD,
  } as Partial<Config>;
  return {
    get: ((key: keyof Config) => values[key]) as ConfigService<Config, true>['get'],
  } as ConfigService<Config, true>;
}

/** Minimal fake satisfying only the one `Pool` method this service actually calls (`query`) — same
 * idiom `redemption-state-machine.service.spec.ts`'s own fake-pool test already establishes. */
function fakePool(rows: Array<{ config_value: string }>): Pool {
  return {
    query: jest.fn(async () => ({ rows, rowCount: rows.length })),
    end: jest.fn(async () => undefined),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal structural fake, T-RTS-010
  } as any;
}

describe('T-RTS-010 — ShardCountResolverService', () => {
  describe('against the real, seeded GLOBAL row (T-RTS-002 seed)', () => {
    let service: ShardCountResolverService;

    afterEach(async () => {
      await service.onModuleDestroy();
    });

    it('resolves the real seeded value (32) and caches it (one DB round trip across two calls)', async () => {
      const pool = new Pool({
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT),
        database: process.env.DB_NAME,
        user: process.env.DB_APP_USERNAME,
        password: process.env.DB_APP_PASSWORD,
      });
      const querySpy = jest.spyOn(pool, 'query');
      service = new ShardCountResolverService(realDbConfigService(), pool);

      const first = await service.resolve();
      const second = await service.resolve();

      expect(first).toBe(32);
      expect(second).toBe(32);
      expect(querySpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('TC-6 — unseeded key falls back to the documented default with a one-time warn log', () => {
    let service: ShardCountResolverService;

    afterEach(async () => {
      await service.onModuleDestroy();
    });

    it('falls back to 32 and warns exactly once across two calls', async () => {
      const pool = fakePool([]);
      service = new ShardCountResolverService(realDbConfigService(), pool);
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      const first = await service.resolve();
      const second = await service.resolve();

      expect(first).toBe(DEFAULT_SHARD_COUNT);
      expect(second).toBe(DEFAULT_SHARD_COUNT);
      expect(pool.query).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledTimes(1);

      warnSpy.mockRestore();
    });
  });

  describe('a malformed config_value', () => {
    let service: ShardCountResolverService;

    afterEach(async () => {
      await service.onModuleDestroy();
    });

    it('throws InvalidShardCountConfigError rather than silently falling back', async () => {
      const pool = fakePool([{ config_value: 'not-a-number' }]);
      service = new ShardCountResolverService(realDbConfigService(), pool);

      await expect(service.resolve()).rejects.toThrow(InvalidShardCountConfigError);
    });

    it('throws for a negative integer', async () => {
      const pool = fakePool([{ config_value: '-5' }]);
      service = new ShardCountResolverService(realDbConfigService(), pool);

      await expect(service.resolve()).rejects.toThrow(InvalidShardCountConfigError);
    });
  });
});
