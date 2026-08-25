/**
 * T-034 — `UpsertBudgetCeilingDto`: `PUT /tenants/:id/budget-ceilings` (11-BUDGETS-AND-LIMITS.md
 * §8.2, TC-21/TC-22/TC-27).
 */
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpsertBudgetCeilingDto } from '@/modules/tenants/dto/upsert-budget-ceiling.dto';

async function failures(body: Record<string, unknown>): Promise<Record<string, string[]>> {
  const errors = await validate(plainToInstance(UpsertBudgetCeilingDto, body));
  return Object.fromEntries(
    errors.map((error) => [error.property, Object.keys(error.constraints ?? {})]),
  );
}

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { unitType: 'currency', unitCode: 'MYR', maxCampaignBudget: '5000000', ...overrides };
}

describe('UpsertBudgetCeilingDto', () => {
  it('accepts a valid body without warnAboveAmount', async () => {
    await expect(failures(validBody())).resolves.toEqual({});
  });

  it('accepts a valid body with warnAboveAmount at or below the ceiling (TC-21)', async () => {
    await expect(failures(validBody({ warnAboveAmount: '4000000' }))).resolves.toEqual({});
    await expect(failures(validBody({ warnAboveAmount: '5000000' }))).resolves.toEqual({});
  });

  it('accepts a separate voucher/points unit (TC-22)', async () => {
    await expect(
      failures({ unitType: 'points', unitCode: 'PTS', maxCampaignBudget: '100000' }),
    ).resolves.toEqual({});
  });

  it('rejects an unknown unitType', async () => {
    const result = await failures(validBody({ unitType: 'crypto' }));
    expect(result.unitType).toContain('isIn');
  });

  it('rejects a zero or negative maxCampaignBudget (ck_tbc_positive)', async () => {
    expect((await failures(validBody({ maxCampaignBudget: '0' }))).maxCampaignBudget).toContain(
      'isPositiveDecimalString',
    );
    expect((await failures(validBody({ maxCampaignBudget: '-5' }))).maxCampaignBudget).toContain(
      'isPositiveDecimalString',
    );
  });

  it('rejects a maxCampaignBudget supplied as a number rather than a string (money is never a float)', async () => {
    const result = await failures(validBody({ maxCampaignBudget: 5000000 }));
    expect(result.maxCampaignBudget).toContain('isPositiveDecimalString');
  });

  it('rejects warnAboveAmount above the ceiling — ck_tbc_warn, TC-27', async () => {
    const result = await failures(validBody({ warnAboveAmount: '6000000' }));
    expect(result.warnAboveAmount).toContain('warnAboveNotExceedingCeiling');
  });

  it('rejects a missing unitCode', async () => {
    const result = await failures({ unitType: 'currency', maxCampaignBudget: '5000000' });
    expect(result.unitCode).toBeDefined();
  });
});
