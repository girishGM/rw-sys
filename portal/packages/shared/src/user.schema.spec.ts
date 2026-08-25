/**
 * T-035 — the `/users` wire contract. Same discipline `tenant.schema.spec.ts` establishes: every
 * object is `.strict()`, so an unexpected key fails here rather than shipping.
 */
import {
  createUserRequestSchema,
  emptyRequestSchema,
  updateUserRequestSchema,
  userEnvelopeSchema,
  userListEnvelopeSchema,
  userSchema,
  userWithTemporaryPasswordEnvelopeSchema,
  userWithTemporaryPasswordSchema,
} from './user.schema';

function validUser() {
  return {
    id: 500,
    email: 'maker@example.invalid',
    displayName: 'A Maker',
    role: 'maker' as const,
    countryId: 1,
    tenantId: 10,
    merchantId: null,
    status: 'active' as const,
    mustChangePassword: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('userSchema', () => {
  it('accepts a well-formed user', () => {
    expect(userSchema.safeParse(validUser()).success).toBe(true);
  });

  it('accepts every ck_portal_users_status value', () => {
    for (const status of ['pending_activation', 'active', 'inactive', 'locked', 'suspended']) {
      expect(userSchema.safeParse({ ...validUser(), status }).success).toBe(true);
    }
  });

  it('accepts every one of the six roles', () => {
    for (const role of [
      'super_admin',
      'country_admin',
      'tenant_admin',
      'maker',
      'checker',
      'merchant',
    ]) {
      expect(userSchema.safeParse({ ...validUser(), role }).success).toBe(true);
    }
  });

  it('rejects an unknown role or status', () => {
    expect(userSchema.safeParse({ ...validUser(), role: 'god_mode' }).success).toBe(false);
    expect(userSchema.safeParse({ ...validUser(), status: 'deleted' }).success).toBe(false);
  });

  it('accepts a super_admin row with every scope id null', () => {
    expect(
      userSchema.safeParse({
        ...validUser(),
        role: 'super_admin',
        countryId: null,
        tenantId: null,
        merchantId: null,
      }).success,
    ).toBe(true);
  });

  it('rejects an extra key — strict, so a leaked credential column fails the contract test (TC-16/TC-29)', () => {
    expect(userSchema.safeParse({ ...validUser(), passwordHash: 'x' }).success).toBe(false);
    expect(userSchema.safeParse({ ...validUser(), mfaSecretEnc: 'x' }).success).toBe(false);
  });
});

describe('userEnvelopeSchema / userListEnvelopeSchema', () => {
  it('wraps a single user in {data}', () => {
    expect(userEnvelopeSchema.safeParse({ data: validUser() }).success).toBe(true);
  });

  it('wraps a list in {data, meta}', () => {
    expect(
      userListEnvelopeSchema.safeParse({
        data: [validUser()],
        meta: { page: 1, pageSize: 20, total: 1 },
      }).success,
    ).toBe(true);
  });

  it('rejects a list envelope with no meta', () => {
    expect(userListEnvelopeSchema.safeParse({ data: [validUser()] }).success).toBe(false);
  });
});

describe('createUserRequestSchema', () => {
  it('accepts a body with only the required fields', () => {
    expect(
      createUserRequestSchema.safeParse({
        email: 'maker@example.invalid',
        displayName: 'A Maker',
        role: 'maker',
      }).success,
    ).toBe(true);
  });

  it('accepts every scope id populated at once — the service decides which one is read', () => {
    expect(
      createUserRequestSchema.safeParse({
        email: 'maker@example.invalid',
        displayName: 'A Maker',
        role: 'maker',
        countryId: 1,
        tenantId: 10,
        merchantId: 20,
      }).success,
    ).toBe(true);
  });

  it('rejects a client-supplied password — the server always generates it (BACKLOG.md B-01)', () => {
    expect(
      createUserRequestSchema.safeParse({
        email: 'maker@example.invalid',
        displayName: 'A Maker',
        role: 'maker',
        password: 'whatever',
      }).success,
    ).toBe(false);
  });

  it('rejects a missing role', () => {
    expect(
      createUserRequestSchema.safeParse({ email: 'maker@example.invalid', displayName: 'A Maker' })
        .success,
    ).toBe(false);
  });
});

describe('userWithTemporaryPasswordSchema / userWithTemporaryPasswordEnvelopeSchema', () => {
  it('accepts the one-time-shown credential response (T-035 TC-16/TC-24, BACKLOG.md B-01)', () => {
    expect(
      userWithTemporaryPasswordSchema.safeParse({
        ...validUser(),
        temporaryPassword: 'Xy9!kLmnpQ2*Zvwr4Tabcd7',
      }).success,
    ).toBe(true);
  });

  it('rejects a missing temporaryPassword', () => {
    expect(userWithTemporaryPasswordSchema.safeParse(validUser()).success).toBe(false);
  });

  it('wraps the response in {data}', () => {
    expect(
      userWithTemporaryPasswordEnvelopeSchema.safeParse({
        data: { ...validUser(), temporaryPassword: 'x' },
      }).success,
    ).toBe(true);
  });
});

describe('updateUserRequestSchema', () => {
  it('accepts an empty body — every field optional', () => {
    expect(updateUserRequestSchema.safeParse({}).success).toBe(true);
  });

  it('accepts a displayName change', () => {
    expect(updateUserRequestSchema.safeParse({ displayName: 'Renamed' }).success).toBe(true);
  });

  it('never accepts role, email or any scope id — no role transition, ever, through this route (T-035 TC-28)', () => {
    expect(updateUserRequestSchema.safeParse({ role: 'tenant_admin' }).success).toBe(false);
    expect(updateUserRequestSchema.safeParse({ email: 'new@example.invalid' }).success).toBe(false);
    expect(updateUserRequestSchema.safeParse({ countryId: 1 }).success).toBe(false);
    expect(updateUserRequestSchema.safeParse({ tenantId: 1 }).success).toBe(false);
    expect(updateUserRequestSchema.safeParse({ merchantId: 1 }).success).toBe(false);
  });
});

describe('emptyRequestSchema', () => {
  it('accepts {} — the body of deactivate/reset-password', () => {
    expect(emptyRequestSchema.safeParse({}).success).toBe(true);
  });

  it('rejects any key at all', () => {
    expect(emptyRequestSchema.safeParse({ anything: true }).success).toBe(false);
  });
});
