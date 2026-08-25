/**
 * T-015 — `UpdateMeDto`, the whitelist that stands between every authenticated account and a
 * self-service role change.
 *
 * TC-16/TC-17 are asserted end to end in `me.e2e-spec.ts`, through the real `ValidationPipe`. This
 * suite asserts the same rule one layer down — that the DTO *declares* three properties and no
 * others — because the pipe is configured in `main.ts`, a file this task does not own. If a future
 * change there ever relaxed `forbidNonWhitelisted`, the e2e assertion would flip from 400 to 200
 * and this one would still hold the line.
 *
 * It also runs the validators directly, which is the only practical way to cover the branches of
 * `isIanaTimeZone` (a `RangeError` from ICU is not a thing an HTTP request can be asked for).
 */
import { getMetadataStorage, validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { updateMeSchema } from '@reward-portal/shared';
import {
  IsIanaTimeZoneConstraint,
  UPDATE_ME_FIELDS,
  UpdateMeDto,
  isIanaTimeZone,
} from '@/modules/me/dto/me-request.dto';

/** Every property name `class-validator` knows about on the DTO. */
function declaredProperties(): string[] {
  const metadata = getMetadataStorage().getTargetValidationMetadatas(
    UpdateMeDto,
    '',
    false,
    false,
    undefined,
  );
  return [...new Set(metadata.map((entry) => entry.propertyName))].sort();
}

/** Validation failures as `property → constraint names`. */
async function failures(body: Record<string, unknown>): Promise<Record<string, string[]>> {
  const errors = await validate(plainToInstance(UpdateMeDto, body));
  return Object.fromEntries(
    errors.map((error) => [error.property, Object.keys(error.constraints ?? {})]),
  );
}

describe('UpdateMeDto — the whitelist', () => {
  it('declares exactly displayName, preferredLocale and preferredTimezone', () => {
    expect(declaredProperties()).toEqual(['displayName', 'preferredLocale', 'preferredTimezone']);
  });

  it('declares no role, status or scope field of any kind', () => {
    const forbidden = ['role', 'status', 'tenantId', 'countryId', 'merchantId', 'id', 'email'];

    for (const name of forbidden) {
      expect(declaredProperties()).not.toContain(name);
    }
  });

  it('UPDATE_ME_FIELDS matches the decorated properties, so the service loop cannot drift', () => {
    expect([...UPDATE_ME_FIELDS].sort()).toEqual(declaredProperties());
  });

  it('names the same three fields as the shared Zod schema the SPA validates with', () => {
    // Two independent declarations of one rule — the server's `class-validator` DTO and
    // `packages/shared/src/bootstrap.schema.ts`. This is the assertion that keeps them one rule.
    expect(Object.keys(updateMeSchema.shape).sort()).toEqual(declaredProperties());
  });

  it('the shared schema is strict, so a client sending `role` fails before the request is made', () => {
    expect(updateMeSchema.safeParse({ role: 'super_admin' }).success).toBe(false);
    expect(updateMeSchema.safeParse({ displayName: 'ok' }).success).toBe(true);
  });
});

describe('UpdateMeDto — field validation', () => {
  it('accepts an empty body: every field is optional', async () => {
    await expect(failures({})).resolves.toEqual({});
  });

  it('accepts all three valid values', async () => {
    await expect(
      failures({
        displayName: 'Amrita Sharma',
        preferredLocale: 'en-GB',
        preferredTimezone: 'Asia/Kolkata',
      }),
    ).resolves.toEqual({});
  });

  it('rejects a displayName over the varchar(100) column width', async () => {
    const result = await failures({ displayName: 'x'.repeat(101) });
    expect(result.displayName).toContain('maxLength');
  });

  it('rejects an empty displayName — a nameless user renders as a blank menu header', async () => {
    const result = await failures({ displayName: '' });
    expect(result.displayName).toContain('minLength');
  });

  it('rejects a non-string displayName', async () => {
    const result = await failures({ displayName: 42 });
    expect(result.displayName).toContain('isString');
  });

  it('accepts the locale shapes the portal actually uses', async () => {
    for (const locale of ['en', 'en-GB', 'fr', 'pt-BR', 'sr-Latn-RS']) {
      await expect(failures({ preferredLocale: locale })).resolves.toEqual({});
    }
  });

  it('rejects a locale that is not a language tag', async () => {
    for (const locale of ['en_GB', 'english!', '../../etc', '1234']) {
      const result = await failures({ preferredLocale: locale });
      expect(result.preferredLocale).toContain('matches');
    }
  });

  it('rejects a locale over the varchar(10) column width', async () => {
    const result = await failures({ preferredLocale: 'en-GB-oed-x-toolong' });
    expect(result.preferredLocale).toContain('maxLength');
  });

  it('rejects a timezone that ICU does not recognise', async () => {
    const result = await failures({ preferredTimezone: 'Mars/Olympus_Mons' });
    expect(result.preferredTimezone).toContain('isIanaTimeZone');
  });

  it('rejects a timezone over the varchar(60) column width', async () => {
    const result = await failures({ preferredTimezone: 'A'.repeat(61) });
    expect(result.preferredTimezone).toContain('maxLength');
  });
});

describe('isIanaTimeZone', () => {
  it('accepts real zones, including UTC', () => {
    for (const zone of ['UTC', 'Asia/Kolkata', 'Europe/Paris', 'America/New_York']) {
      expect(isIanaTimeZone(zone)).toBe(true);
    }
  });

  it('rejects an unknown zone, an empty string and a non-string', () => {
    expect(isIanaTimeZone('Mars/Olympus_Mons')).toBe(false);
    expect(isIanaTimeZone('')).toBe(false);
    expect(isIanaTimeZone(undefined)).toBe(false);
    expect(isIanaTimeZone(null)).toBe(false);
    expect(isIanaTimeZone(42)).toBe(false);
  });

  it('the constraint class delegates to it and carries a server-side message', () => {
    const constraint = new IsIanaTimeZoneConstraint();

    expect(constraint.validate('UTC')).toBe(true);
    expect(constraint.validate('Nowhere/Nothing')).toBe(false);
    expect(constraint.defaultMessage()).toContain('IANA');
  });
});
