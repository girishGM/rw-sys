/**
 * T-PC-021. `PromoCodeGenerationService`'s collision-retry/exhaustion branch and the
 * correlation-conflict race branch, with a deliberately mocked `PromoCodeRepository` — same
 * rationale as `campaign-binding.service.retry.spec.ts` (T-PC-012): a real `23505` race is
 * inherently non-deterministic, so `promo-code-generation.service.spec.ts`'s own real-Postgres
 * TC-12/TC-13 cannot *guarantee* the retry-then-succeed, retry-exhausted and
 * correlation-conflict-race paths are all actually exercised on every single run (Verification
 * step 3's "100% on the idempotency/retry/transaction branches" needs that guarantee).
 *
 * Only `PromoCodeRepository.create`/`findByCorrelationId`/`createOutboxRow` are mocked (via
 * `jest.spyOn` on a real instance, never a hand-rolled stand-in) — `isCodeCollision`/
 * `isCorrelationConflict` are the real, unmodified implementations, keyed off the exact
 * Postgres-error shape (`{ parent: { code: '23505', constraint: '...' } }`) those methods
 * actually check in production, so this still asserts the observable property (call counts,
 * returned/thrown value), not a restated implementation string.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { Sequelize } from 'sequelize-typescript';
import type { CampaignBindingService } from '@/modules/campaign-binding/campaign-binding.service';
import type { PromoCodeConfigService } from '@/modules/promo-code-config/promo-code-config.service';
import type { CodeGenerator } from '@/modules/generation/code-generator';
import {
  PromoCodeRepository,
  UC_PROMO_CODE_CODE,
  UC_PROMO_CODE_CORRELATION,
} from '@/modules/generation/promo-code.repository';
import type { PromoCode } from '@/modules/generation/promo-code.entity';
import { PromoCodeGenerationService } from '@/modules/generation/promo-code-generation.service';

function uniqueViolationError(constraint: string): Error {
  const error = new Error(
    `duplicate key value violates unique constraint "${constraint}"`,
  ) as Error & { parent?: { code: string; constraint: string } };
  error.parent = { code: '23505', constraint };
  return error;
}

function fakePromoCode(overrides: Partial<PromoCode> = {}): PromoCode {
  return {
    id: randomUUID(),
    promoCodeConfigId: randomUUID(),
    campaignPromoConfigId: null,
    code: `CODE-${randomUUID().slice(0, 8)}`,
    customerId: 'cust_8213',
    tenantId: randomUUID(),
    merchantId: null,
    rewardValueType: 'FIXED_AMOUNT',
    rewardValue: '10.0000',
    rewardUnit: 'USD',
    status: 'ISSUED',
    correlationId: randomUUID(),
    transport: 'GRPC',
    issuedAt: new Date(),
    expiresAt: null,
    redeemedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function activeConfig(): {
  id: string;
  status: 'ACTIVE';
  characterSet: 'ALPHANUMERIC';
  codeLength: number;
  codePrefix: null;
  codePostfix: null;
  excludeAmbiguousChars: boolean;
  rewardValueType: 'FIXED_AMOUNT';
  rewardValue: string;
  rewardUnit: string;
  codeExpiryDays: null;
} {
  return {
    id: randomUUID(),
    status: 'ACTIVE',
    characterSet: 'ALPHANUMERIC',
    codeLength: 10,
    codePrefix: null,
    codePostfix: null,
    excludeAmbiguousChars: true,
    rewardValueType: 'FIXED_AMOUNT',
    rewardValue: '10.0000',
    rewardUnit: 'USD',
    codeExpiryDays: null,
  };
}

function buildService(
  createImpl: jest.Mock,
  options: { maxRetryAttempts?: number; findByCorrelationIdImpl?: jest.Mock } = {},
): {
  service: PromoCodeGenerationService;
  repository: PromoCodeRepository;
  findByCorrelationId: jest.Mock;
} {
  const repository = new PromoCodeRepository({} as unknown as Sequelize);
  jest.spyOn(repository, 'create').mockImplementation(createImpl);
  const findByCorrelationId = options.findByCorrelationIdImpl ?? jest.fn().mockResolvedValue(null);
  jest.spyOn(repository, 'findByCorrelationId').mockImplementation(findByCorrelationId);
  jest.spyOn(repository, 'createOutboxRow').mockResolvedValue(undefined);

  const config = activeConfig();
  const campaignBindingService = {
    resolveActiveBinding: jest
      .fn()
      .mockResolvedValue({ outcome: 'RESOLVED', promoCodeConfigId: config.id }),
  } as unknown as CampaignBindingService;
  const promoCodeConfigService = {
    findById: jest.fn().mockResolvedValue(config),
  } as unknown as PromoCodeConfigService;
  const codeGenerator = {
    generate: jest.fn(() => `CODE-${randomUUID().slice(0, 8)}`),
  } as unknown as CodeGenerator;
  // Real `Sequelize.transaction` invokes the callback and rejects with whatever it throws —
  // this stand-in reproduces exactly that contract without a real connection/BEGIN/COMMIT
  // (same convention `campaign-binding.service.retry.spec.ts` already established).
  const sequelize = {
    transaction: (cb: (t: unknown) => Promise<unknown>) => cb({}),
  } as unknown as Sequelize;

  const service = new PromoCodeGenerationService(
    repository,
    campaignBindingService,
    promoCodeConfigService,
    codeGenerator,
    sequelize,
    options.maxRetryAttempts ?? 5,
  );
  return { service, repository, findByCorrelationId };
}

function validInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    correlationId: randomUUID(),
    tenantId: randomUUID(),
    bindLevel: 'CAMPAIGN',
    bindRefId: randomUUID(),
    customerId: 'cust_8213',
    merchantId: null,
    transport: 'GRPC',
    activityContext: null,
    ...overrides,
  };
}

describe('T-PC-021 — PromoCodeGenerationService collision-retry branch (mocked repository)', () => {
  // TC-5
  it('TC-5: retries once on a promo_code.code collision and succeeds on the second attempt with a different code', async () => {
    const created = fakePromoCode();
    const create = jest
      .fn()
      .mockRejectedValueOnce(uniqueViolationError(UC_PROMO_CODE_CODE))
      .mockResolvedValueOnce(created);
    const { service } = buildService(create);

    const result = await service.generateCode(validInput());

    expect(result.status).toBe('SUCCESS');
    expect(result).toMatchObject({ promoCodeId: created.id, code: created.code });
    expect(create).toHaveBeenCalledTimes(2);
  });

  // TC-6
  it('TC-6: unique-violations on every attempt up to the configured max returns GENERATION_EXHAUSTED, no row committed', async () => {
    const create = jest.fn().mockRejectedValue(uniqueViolationError(UC_PROMO_CODE_CODE));
    const { service } = buildService(create, { maxRetryAttempts: 5 });

    const result = await service.generateCode(validInput());

    expect(result.status).toBe('FAILED');
    expect(result.errorCode).toBe('GENERATION_EXHAUSTED');
    expect(create).toHaveBeenCalledTimes(5);
  });

  // TC-15
  it('TC-15: a configured max override (2) exhausts after exactly 2 attempts, not the default 5', async () => {
    const create = jest.fn().mockRejectedValue(uniqueViolationError(UC_PROMO_CODE_CODE));
    const { service } = buildService(create, { maxRetryAttempts: 2 });

    const result = await service.generateCode(validInput());

    expect(result.status).toBe('FAILED');
    expect(result.errorCode).toBe('GENERATION_EXHAUSTED');
    expect(create).toHaveBeenCalledTimes(2);
  });

  // TC-13 (deterministic variant): the correlation-conflict race, forced rather than raced.
  it('TC-13 (deterministic): a correlation_id conflict reads back the committed winner instead of retrying generation', async () => {
    const winner = fakePromoCode();
    const create = jest.fn().mockRejectedValueOnce(uniqueViolationError(UC_PROMO_CODE_CORRELATION));
    const findByCorrelationIdImpl = jest
      .fn()
      .mockResolvedValueOnce(null) // implementation note 2's initial idempotency check — not found yet
      .mockResolvedValueOnce(winner); // read-back after the correlation conflict
    const { service } = buildService(create, { findByCorrelationIdImpl });

    const result = await service.generateCode(validInput());

    expect(result.status).toBe('SUCCESS');
    expect(result).toMatchObject({ promoCodeId: winner.id, code: winner.code });
    // Never regenerated/reattempted past the single correlation-conflict insert — this is an
    // idempotency hit, not a collision (implementation note 3).
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('rethrows an unrecognised database error immediately, without retrying', async () => {
    const otherError = new Error('some other, unrelated database error');
    const create = jest.fn().mockRejectedValue(otherError);
    const { service } = buildService(create);

    await expect(service.generateCode(validInput())).rejects.toThrow(otherError);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('a correlation_id conflict whose read-back finds nothing (extremely rare) rethrows rather than silently swallowing the error', async () => {
    const create = jest.fn().mockRejectedValueOnce(uniqueViolationError(UC_PROMO_CODE_CORRELATION));
    const findByCorrelationIdImpl = jest
      .fn()
      .mockResolvedValueOnce(null) // initial idempotency check
      .mockResolvedValueOnce(null); // read-back after the conflict still finds nothing
    const { service } = buildService(create, { findByCorrelationIdImpl });

    await expect(service.generateCode(validInput())).rejects.toMatchObject({
      parent: { constraint: UC_PROMO_CODE_CORRELATION },
    });
  });

  it('re-validates the resolved config defensively: a race that archives the config between resolveActiveBinding and findById returns CONFIG_INACTIVE', async () => {
    const create = jest.fn();
    const repository = new PromoCodeRepository({} as unknown as Sequelize);
    jest.spyOn(repository, 'create').mockImplementation(create);
    jest.spyOn(repository, 'findByCorrelationId').mockResolvedValue(null);
    jest.spyOn(repository, 'createOutboxRow').mockResolvedValue(undefined);

    const promoCodeConfigId = randomUUID();
    const campaignBindingService = {
      resolveActiveBinding: jest.fn().mockResolvedValue({ outcome: 'RESOLVED', promoCodeConfigId }),
    } as unknown as CampaignBindingService;
    // findById now disagrees with resolveActiveBinding's own just-prior check (R3: never trust a
    // resolved scope without re-validating against the resource it targets).
    const promoCodeConfigService = {
      findById: jest.fn().mockResolvedValue({ id: promoCodeConfigId, status: 'ARCHIVED' }),
    } as unknown as PromoCodeConfigService;
    const codeGenerator = { generate: jest.fn() } as unknown as CodeGenerator;
    const sequelize = {
      transaction: (cb: (t: unknown) => Promise<unknown>) => cb({}),
    } as unknown as Sequelize;
    const service = new PromoCodeGenerationService(
      repository,
      campaignBindingService,
      promoCodeConfigService,
      codeGenerator,
      sequelize,
      5,
    );

    const result = await service.generateCode(validInput());

    expect(result.status).toBe('FAILED');
    expect(result.errorCode).toBe('CONFIG_INACTIVE');
    expect(create).not.toHaveBeenCalled();
  });

  it('the initial idempotency check short-circuits generation entirely when a row already exists', async () => {
    const existing = fakePromoCode();
    const create = jest.fn();
    const findByCorrelationIdImpl = jest.fn().mockResolvedValue(existing);
    const { service } = buildService(create, { findByCorrelationIdImpl });

    const result = await service.generateCode(validInput());

    expect(result.status).toBe('SUCCESS');
    expect(result).toMatchObject({ promoCodeId: existing.id, code: existing.code });
    expect(create).not.toHaveBeenCalled();
  });
});
