import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { putNavConfigRequestSchema } from '@reward-portal/shared';
import { flattenValidationErrors } from '@/common/errors/validation.exception-factory';
import { PutNavConfigDto } from '@/modules/access-control/dto/nav-config.dto';

async function failures(body: Record<string, unknown>): Promise<Record<string, string[]>> {
  const errors = await validate(plainToInstance(PutNavConfigDto, body), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  const flat: Record<string, string[]> = {};
  for (const detail of flattenValidationErrors(errors)) {
    flat[detail.field] = [...(flat[detail.field] ?? []), detail.code];
  }
  return flat;
}

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    expectedVersion: 1,
    items: [
      {
        navKey: 'dashboard',
        label: 'Dashboard',
        path: '/dashboard',
        sortOrder: 10,
        enabled: true,
      },
    ],
    ...overrides,
  };
}

describe('PutNavConfigDto', () => {
  it('accepts a minimal valid body', async () => {
    await expect(failures(validBody())).resolves.toEqual({});
  });

  it('accepts an empty items array (TC-24)', async () => {
    await expect(failures(validBody({ items: [] }))).resolves.toEqual({});
  });

  it('accepts icon and parentNavKey, including explicit null', async () => {
    await expect(
      failures(
        validBody({
          items: [
            {
              navKey: 'campaign_new',
              label: 'Create Campaign',
              icon: 'plus',
              path: '/campaigns/new',
              parentNavKey: null,
              sortOrder: 30,
              enabled: true,
            },
          ],
        }),
      ),
    ).resolves.toEqual({});
  });

  it('rejects a negative expectedVersion', async () => {
    const result = await failures(validBody({ expectedVersion: -1 }));
    expect(result.expectedVersion).toContain('MIN');
  });

  it('rejects an upper-case navKey', async () => {
    const result = await failures(validBody({ items: [{ ...oneItem(), navKey: 'Dashboard' }] }));
    expect(result['items[0].navKey']).toContain('MATCHES');
  });

  it('rejects a negative sortOrder', async () => {
    const result = await failures(validBody({ items: [{ ...oneItem(), sortOrder: -1 }] }));
    expect(result['items[0].sortOrder']).toContain('MIN');
  });

  it('rejects a non-boolean enabled', async () => {
    const result = await failures(validBody({ items: [{ ...oneItem(), enabled: 'yes' }] }));
    expect(result['items[0].enabled']).toContain('IS_BOOLEAN');
  });

  it('rejects an unexpected top-level field (R3 — no client-supplied role)', async () => {
    const errors = await validate(
      plainToInstance(PutNavConfigDto, validBody({ role: 'super_admin' })),
      {
        whitelist: true,
        forbidNonWhitelisted: true,
      },
    );
    const flat = Object.fromEntries(errors.map((error) => [error.property, error.constraints]));
    expect(flat['role']).toHaveProperty('whitelistValidation');
  });

  it('is a subset of the shared Zod request schema', () => {
    expect(putNavConfigRequestSchema.safeParse(validBody()).success).toBe(true);
    expect(putNavConfigRequestSchema.safeParse(validBody({ role: 'super_admin' })).success).toBe(
      false,
    );
  });
});

function oneItem(): Record<string, unknown> {
  return {
    navKey: 'dashboard',
    label: 'Dashboard',
    path: '/dashboard',
    sortOrder: 10,
    enabled: true,
  };
}
