/**
 * T-PC-012. `CampaignBindingService`'s retry-on-conflict branch
 * (`deactivateAndCreateWithRetry`/`isActiveBindingConflict`), with a deliberately mocked
 * repository/connection — unlike every other spec in this task, which runs against the real
 * Postgres 16 server (`AGENT-PROTOCOL.md` §3's usual preference here).
 *
 * Why a mock is the right call for *this specific* branch: `campaign-binding.service.spec.ts`'s
 * own TC-10 already exercises the real unique-partial-index collision under real concurrent
 * load, but a real `23505` race is inherently non-deterministic — two genuinely concurrent
 * requests may or may not actually collide on a given run/machine, so that test alone cannot
 * guarantee the retry-then-succeed path or the retry-exhausted-then-409 path are ever actually
 * executed (Verification step 4's "100% on the deactivate+create transaction path" needs both to
 * be hit on every run, not just probabilistically). This file forces both outcomes
 * deterministically by having a fake `CampaignBindingRepository.create` reject with a
 * Postgres-error-shaped object (`{ parent: { code: '23505', constraint:
 * 'uc_campaign_promo_config_active' } }` — the exact shape Sequelize wraps a real driver
 * unique-violation in, the same shape `promo-code-config.repository.ts`'s own
 * `translateUniqueViolation` keys off) and asserting the service's real, unmodified control flow
 * responds correctly — this still asserts the observable property (call counts, thrown error
 * type, returned value), not a restated implementation string.
 */
import { randomUUID } from 'node:crypto';
import type { Sequelize } from 'sequelize-typescript';
import type { CampaignBindingRepository } from '@/modules/campaign-binding/campaign-binding.repository';
import { CampaignBindingService } from '@/modules/campaign-binding/campaign-binding.service';
import type { CampaignPromoConfig } from '@/modules/campaign-binding/campaign-promo-config.entity';
import { BindingConflictError } from '@/modules/campaign-binding/campaign-binding.errors';
import type { PromoCodeConfigService } from '@/modules/promo-code-config/promo-code-config.service';

function uniqueViolationError(): Error {
  const error = new Error(
    'duplicate key value violates unique constraint "uc_campaign_promo_config_active"',
  ) as Error & { parent?: { code: string; constraint: string } };
  error.parent = { code: '23505', constraint: 'uc_campaign_promo_config_active' };
  return error;
}

function buildService(createImpl: jest.Mock): {
  service: CampaignBindingService;
  deactivateActive: jest.Mock;
} {
  const deactivateActive = jest.fn().mockResolvedValue(undefined);
  const repository = {
    deactivateActive,
    create: createImpl,
    findActiveBinding: jest.fn(),
  } as unknown as CampaignBindingRepository;
  const promoCodeConfigService = {
    findById: jest.fn().mockResolvedValue({ id: randomUUID(), status: 'ACTIVE' }),
  } as unknown as PromoCodeConfigService;
  // Real `Sequelize.transaction` invokes the callback and rejects with whatever it throws —
  // this stand-in reproduces exactly that contract without a real connection/BEGIN/COMMIT.
  const sequelize = {
    transaction: (cb: (t: unknown) => Promise<unknown>) => cb({}),
  } as unknown as Sequelize;
  const service = new CampaignBindingService(repository, promoCodeConfigService, sequelize);
  return { service, deactivateActive };
}

function validBindInput(): Record<string, unknown> {
  return {
    promoCodeConfigId: randomUUID(),
    tenantId: randomUUID(),
    bindLevel: 'CAMPAIGN',
    bindRefId: randomUUID(),
    boundBy: randomUUID(),
  };
}

describe('T-PC-012 — CampaignBindingService deactivate+create retry branch (mocked collision)', () => {
  it('retries once on a unique-violation race and returns the second attempt’s result', async () => {
    const created = { id: randomUUID(), status: 'ACTIVE' } as CampaignPromoConfig;
    const create = jest
      .fn()
      .mockRejectedValueOnce(uniqueViolationError())
      .mockResolvedValueOnce(created);
    const { service, deactivateActive } = buildService(create);

    const result = await service.bind(validBindInput());

    expect(result).toBe(created);
    expect(create).toHaveBeenCalledTimes(2);
    expect(deactivateActive).toHaveBeenCalledTimes(2);
  });

  it('throws BindingConflictError, not the raw driver error, once the race repeats twice in a row', async () => {
    const create = jest.fn().mockRejectedValue(uniqueViolationError());
    const { service } = buildService(create);

    await expect(service.bind(validBindInput())).rejects.toThrow(BindingConflictError);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('rethrows a non-conflict error immediately, without retrying', async () => {
    const otherError = new Error('some other, unrelated database error');
    const create = jest.fn().mockRejectedValue(otherError);
    const { service } = buildService(create);

    await expect(service.bind(validBindInput())).rejects.toThrow(otherError);
    expect(create).toHaveBeenCalledTimes(1);
  });
});
