/**
 * T-014 — the other half of TC-11: the conversion from `class-validator`'s structure into
 * `details: [{ field, code }]`.
 *
 * The suite runs the **real** `ValidationPipe` over **real** DTOs rather than hand-building
 * `ValidationError` objects. Hand-built errors would test the flattening function against the
 * shape this file assumes `class-validator` produces — which is exactly the assumption most
 * likely to be wrong, and the one that changes between minor versions.
 */
import { ValidationPipe } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsNotEmpty, IsString, Min, ValidateNested } from 'class-validator';
import { ValidationFailedError, constraintCode, validationExceptionFactory } from '@/common/errors';

class PolicyDto {
  @IsString()
  unitCode!: string;

  @IsInt()
  @Min(0)
  amount!: number;
}

class CreateCampaignDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ValidateNested({ each: true })
  @Type(() => PolicyDto)
  policies!: PolicyDto[];
}

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  exceptionFactory: validationExceptionFactory,
});

/** Runs the pipe exactly as `main.ts` configures it and returns the error it produced. */
async function reject(value: unknown): Promise<ValidationFailedError> {
  try {
    await pipe.transform(value, { type: 'body', metatype: CreateCampaignDto });
  } catch (error) {
    return error as ValidationFailedError;
  }
  throw new Error('the pipe accepted a payload the test expected it to reject');
}

describe('validationExceptionFactory', () => {
  it('produces a ValidationFailedError — a 400 with details, once the filter renders it', async () => {
    const error = await reject({ name: '', policies: [] });

    expect(error).toBeInstanceOf(ValidationFailedError);
    expect(error.status).toBe(400);
    expect(error.code).toBe('VALIDATION_FAILED');
  });

  it('names the failing property and the constraint, not the sentence', async () => {
    const error = await reject({ name: '', policies: [] });

    expect(error.details).toEqual([{ field: 'name', code: 'REQUIRED' }]);
  });

  it('flattens a nested DTO into a dotted, indexed path', async () => {
    const error = await reject({ name: 'Summer', policies: [{ unitCode: 9, amount: -1 }] });

    expect(error.details).toEqual(
      expect.arrayContaining([
        { field: 'policies[0].unitCode', code: 'IS_STRING' },
        { field: 'policies[0].amount', code: 'MIN' },
      ]),
    );
  });

  it('reports a smuggled server-derived field as UNEXPECTED_FIELD (AGENT-PROTOCOL R3)', async () => {
    // `forbidNonWhitelisted` is what stops a client supplying its own `tenantId`; the audit trail
    // of *that* attempt is worth a code of its own rather than a generic one.
    const error = await reject({ name: 'Summer', policies: [], tenantId: 999 });

    expect(error.details).toContainEqual({ field: 'tenantId', code: 'UNEXPECTED_FIELD' });
  });

  it('never carries the validator’s prose, not even in the log message', async () => {
    const error = await reject({ name: '', policies: [{ unitCode: 9, amount: -1 }] });

    const serialised = JSON.stringify({ details: error.details, message: error.message });
    expect(serialised).not.toContain('should not be empty');
    expect(serialised).not.toContain('must be a string');
  });

  it('logs the field names only — a rejected DTO is where a plaintext password sits', async () => {
    const error = await reject({ name: '', policies: [] });

    expect(error.logContext).toEqual({ fields: ['name'] });
    expect(JSON.stringify(error.logContext)).not.toContain('password');
  });

  describe('constraintCode', () => {
    it.each([
      ['isEmail', 'IS_EMAIL'],
      ['maxLength', 'MAX_LENGTH'],
      ['isNotEmpty', 'REQUIRED'],
      ['isDefined', 'REQUIRED'],
      ['whitelistValidation', 'UNEXPECTED_FIELD'],
      ['min', 'MIN'],
      ['isInt', 'IS_INT'],
    ])('%s → %s', (constraint, expected) => {
      expect(constraintCode(constraint)).toBe(expected);
    });

    it('falls back to INVALID_VALUE for a constraint name that cannot be a safe code', () => {
      expect(constraintCode('_')).toBe('INVALID_VALUE');
      expect(constraintCode('')).toBe('INVALID_VALUE');
    });

    it('never produces a code the filter would refuse to serialise', () => {
      for (const constraint of ['isEmail', 'arrayNotEmpty', 'is-weird', 'x']) {
        expect(constraintCode(constraint)).toMatch(/^[A-Z][A-Z0-9_]{1,59}$/);
      }
    });
  });
});
