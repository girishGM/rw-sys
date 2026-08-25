import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { putPermissionsRequestSchema } from '@reward-portal/shared';
import { flattenValidationErrors } from '@/common/errors/validation.exception-factory';
import { PutPermissionsDto } from '@/modules/access-control/dto/permission-matrix.dto';

async function failures(body: Record<string, unknown>): Promise<Record<string, string[]>> {
  const errors = await validate(plainToInstance(PutPermissionsDto, body), {
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
  return { expectedVersion: 1, permissions: { campaign: ['view'] }, ...overrides };
}

describe('PutPermissionsDto', () => {
  it('accepts a valid matrix', async () => {
    await expect(failures(validBody())).resolves.toEqual({});
  });

  it('accepts an empty permission map (TC-24 — a role may legitimately have none)', async () => {
    await expect(failures(validBody({ permissions: {} }))).resolves.toEqual({});
  });

  it('rejects an unknown entity (TC-23)', async () => {
    const result = await failures(validBody({ permissions: { not_a_real_entity: ['view'] } }));
    expect(result.permissions).toContain('IS_PERMISSIONS_MATRIX');
  });

  it('rejects a known entity with an action it does not offer (TC-23)', async () => {
    const result = await failures(validBody({ permissions: { audit: ['delete'] } }));
    expect(result.permissions).toContain('IS_PERMISSIONS_MATRIX');
  });

  it('rejects a non-array value for an entity', async () => {
    const result = await failures(validBody({ permissions: { campaign: 'view' } }));
    expect(result.permissions).toContain('IS_PERMISSIONS_MATRIX');
  });

  it('is a subset of the shared Zod request schema', () => {
    expect(putPermissionsRequestSchema.safeParse(validBody()).success).toBe(true);
  });
});
