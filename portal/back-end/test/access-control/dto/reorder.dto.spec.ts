import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { reorderRequestSchema } from '@reward-portal/shared';
import { flattenValidationErrors } from '@/common/errors/validation.exception-factory';
import { ReorderDto } from '@/modules/access-control/dto/reorder.dto';

async function failures(body: Record<string, unknown>): Promise<Record<string, string[]>> {
  const errors = await validate(plainToInstance(ReorderDto, body), {
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
  return { expectedVersion: 1, order: [{ key: 'dashboard', sortOrder: 20 }], ...overrides };
}

describe('ReorderDto — implementation note 7 (single bulk call)', () => {
  it('accepts a valid reorder body', async () => {
    await expect(failures(validBody())).resolves.toEqual({});
  });

  it('accepts several rows in one call', async () => {
    await expect(
      failures(
        validBody({
          order: [
            { key: 'dashboard', sortOrder: 10 },
            { key: 'campaigns', sortOrder: 20 },
            { key: 'campaign_new', sortOrder: 30 },
          ],
        }),
      ),
    ).resolves.toEqual({});
  });

  it('rejects an empty key', async () => {
    const result = await failures(validBody({ order: [{ key: '', sortOrder: 1 }] }));
    expect(result['order[0].key']).toContain('MIN_LENGTH');
  });

  it('rejects a negative sortOrder', async () => {
    const result = await failures(validBody({ order: [{ key: 'dashboard', sortOrder: -1 }] }));
    expect(result['order[0].sortOrder']).toContain('MIN');
  });

  it('is a subset of the shared Zod request schema', () => {
    expect(reorderRequestSchema.safeParse(validBody()).success).toBe(true);
  });
});
