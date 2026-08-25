import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { flattenValidationErrors } from '@/common/errors/validation.exception-factory';
import { PreviewBlastDto } from '@/modules/blasts/dto/preview-blast.dto';

async function failures(body: Record<string, unknown>): Promise<Record<string, string[]>> {
  const errors = await validate(plainToInstance(PreviewBlastDto, body), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  const flat: Record<string, string[]> = {};
  for (const detail of flattenValidationErrors(errors)) {
    flat[detail.field] = [...(flat[detail.field] ?? []), detail.code];
  }
  return flat;
}

describe('PreviewBlastDto', () => {
  it('accepts a minimal valid body', async () => {
    await expect(
      failures({
        entityType: 'reward',
        entityId: 1,
        versionId: 2,
        scope: 'selected',
        countryIds: [1],
      }),
    ).resolves.toEqual({});
  });

  it('carries no note/originRequestId/confirmBreaking fields (unlike CreateBlastDto)', async () => {
    const result = await failures({
      entityType: 'rule',
      entityId: 1,
      versionId: 2,
      scope: 'all_countries',
      note: 'not allowed here',
    });
    expect(result.note).toBeDefined();
  });
});
