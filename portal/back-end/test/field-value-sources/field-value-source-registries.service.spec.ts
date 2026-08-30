/**
 * T-121 — `FieldValueSourceRegistriesService` against a doubled `ScopedRepository` and a **real**
 * `FieldApiLookupConfigCrypto` (built on a real `FieldCryptoService` with test keys), so the
 * encrypt-on-write path is exercised for real rather than mocked away. What reaches the repository
 * double is exactly what would reach Postgres — which is what makes the "no plaintext is ever
 * handed to the database" assertions below meaningful.
 */
import { FieldCryptoService } from '@/common/crypto';
import { FieldApiLookupConfigCrypto } from '@/modules/field-value-sources/field-api-lookup-config.crypto';
import { FieldValueSourceRegistriesService } from '@/modules/field-value-sources/field-value-source-registries.service';
import {
  FieldApiLookupProviderCodeExistsError,
  FieldContextProviderCodeExistsError,
} from '@/modules/field-value-sources/field-value-sources.errors';
import { FieldApiLookupProvider, FieldContextProvider } from '@/database/models';
import { UniqueConstraintError } from 'sequelize';
import type { ScopedRepository } from '@/common/scope/scoped.repository';
import type { AuditService } from '@/common/audit/audit.service';
import type { AuthenticatedUser } from '@/modules/auth/decorators/current-user.decorator';
import { buildDefaultRegistry } from '../crypto/support/keys';

const SECRET = 'sk_live_service_spec_71b2';

const superAdmin = { sub: 1, role: 'super_admin' } as unknown as AuthenticatedUser;
const maker = { sub: 2, role: 'maker', tenantId: 7, countryId: 3 } as unknown as AuthenticatedUser;

interface Doubles {
  service: FieldValueSourceRegistriesService;
  scoped: {
    listAll: jest.Mock;
    count: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    findByPk: jest.Mock;
    findByPkOrFail: jest.Mock;
  };
  audit: { annotate: jest.Mock };
  crypto: FieldApiLookupConfigCrypto;
}

async function build(): Promise<Doubles> {
  const scoped = {
    listAll: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
    create: jest.fn(),
    update: jest.fn().mockResolvedValue(1),
    findByPk: jest.fn(),
    findByPkOrFail: jest.fn(),
  };
  const audit = { annotate: jest.fn() };
  const crypto = new FieldApiLookupConfigCrypto(
    new FieldCryptoService(await buildDefaultRegistry()),
  );
  // The create path runs inside `sequelize.transaction(cb)`; the double just runs the callback.
  const sequelize = {
    transaction: jest.fn(async (cb: (t: unknown) => Promise<unknown>) => cb({ id: 'tx' })),
  };

  const service = new FieldValueSourceRegistriesService(
    scoped as unknown as ScopedRepository,
    crypto,
    audit as unknown as AuditService,
    sequelize as never,
  );
  return { service, scoped, audit, crypto };
}

describe('FieldValueSourceRegistriesService — reads', () => {
  it('TC-1/TC-2: both lists go through ScopedRepository, never a raw Model.findAll (R2)', async () => {
    const { service, scoped } = await build();
    await service.listContextProviders();
    await service.listApiLookupProviders();

    expect(scoped.listAll).toHaveBeenNthCalledWith(1, FieldContextProvider, {
      order: [['name', 'ASC']],
    });
    expect(scoped.listAll).toHaveBeenNthCalledWith(2, FieldApiLookupProvider, {
      order: [['name', 'ASC']],
    });
  });

  it('the API lookup DTO never carries the encrypted credential', async () => {
    const { service, scoped, crypto } = await build();
    scoped.listAll.mockResolvedValue([
      {
        id: 1,
        providerCode: 'PRODUCT_CATALOG',
        name: 'Product Catalog',
        description: null,
        endpointUrl: 'PLACEHOLDER',
        httpMethod: 'GET',
        authType: 'api_key',
        authConfigEnc: crypto.encryptForRow(1, { apiKey: SECRET }),
        responseValueKey: 'productId',
        responseLabelKey: 'productName',
        status: 'planned',
      },
    ]);

    const [dto] = await service.listApiLookupProviders();

    // Verification step 2 — neither the ciphertext nor anything derived from it leaves the service.
    expect(dto).not.toHaveProperty('authConfigEnc');
    expect(dto).not.toHaveProperty('authConfig');
    expect(JSON.stringify(dto)).not.toContain(SECRET);
    // The non-secret metadata a UI legitimately needs is still present.
    expect(dto.authType).toBe('api_key');
    expect(dto.status).toBe('planned');
  });
});

describe('FieldValueSourceRegistriesService — writes are super_admin only (layer 2)', () => {
  it('TC-5: a non-super_admin is refused by the service itself, independently of the guard', async () => {
    const { service } = await build();

    // The controller's @RequirePermission is layer 1; this is layer 2. Both must refuse.
    await expect(
      service.createContextProvider(maker, { providerCode: 'X_Y', name: 'n' }),
    ).rejects.toThrow();
    await expect(service.updateContextProvider(maker, 1, { name: 'n' })).rejects.toThrow();
    await expect(
      service.createApiLookupProvider(maker, {
        providerCode: 'X_Y',
        name: 'n',
        endpointUrl: 'u',
        responseValueKey: 'v',
        responseLabelKey: 'l',
      }),
    ).rejects.toThrow();
    await expect(service.updateApiLookupProvider(maker, 1, { name: 'n' })).rejects.toThrow();
  });

  it('a refused write never reaches the database', async () => {
    const { service, scoped } = await build();
    await expect(
      service.createContextProvider(maker, { providerCode: 'X_Y', name: 'n' }),
    ).rejects.toThrow();
    expect(scoped.create).not.toHaveBeenCalled();
    expect(scoped.count).not.toHaveBeenCalled();
  });
});

describe('FieldValueSourceRegistriesService — context provider writes', () => {
  it('creates with status active and trims the free-text fields', async () => {
    const { service, scoped, audit } = await build();
    scoped.create.mockResolvedValue({
      id: 9,
      providerCode: 'NEW_SOURCE',
      name: 'New Source',
      description: 'd',
      status: 'active',
    });

    await service.createContextProvider(superAdmin, {
      providerCode: 'NEW_SOURCE',
      name: '  New Source  ',
      description: '  d  ',
    });

    expect(scoped.create).toHaveBeenCalledWith(
      FieldContextProvider,
      expect.objectContaining({
        providerCode: 'NEW_SOURCE',
        name: 'New Source',
        description: 'd',
        status: 'active',
      }),
    );
    expect(audit.annotate).toHaveBeenCalledWith({
      targetId: 9,
      detail: { providerCode: 'NEW_SOURCE' },
    });
  });

  it('TC-6: a duplicate providerCode is a 409, not a 500', async () => {
    const { service, scoped } = await build();
    scoped.count.mockResolvedValue(1);

    await expect(
      service.createContextProvider(superAdmin, { providerCode: 'SIBLING_COMPONENTS', name: 'n' }),
    ).rejects.toBeInstanceOf(FieldContextProviderCodeExistsError);
    expect(scoped.create).not.toHaveBeenCalled();
  });

  it('update applies only the supplied fields and re-reads the row', async () => {
    const { service, scoped } = await build();
    scoped.findByPkOrFail.mockResolvedValue({
      id: 2,
      providerCode: 'A',
      name: 'old',
      description: null,
      status: 'active',
    });

    await service.updateContextProvider(superAdmin, 2, { status: 'inactive' });

    expect(scoped.update).toHaveBeenCalledWith(
      FieldContextProvider,
      { status: 'inactive' },
      { where: { id: 2 } },
    );
  });

  it('an empty patch performs no UPDATE at all', async () => {
    const { service, scoped } = await build();
    scoped.findByPkOrFail.mockResolvedValue({
      id: 2,
      providerCode: 'A',
      name: 'old',
      description: null,
      status: 'active',
    });

    await service.updateContextProvider(superAdmin, 2, {});

    expect(scoped.update).not.toHaveBeenCalled();
  });
});

describe('FieldValueSourceRegistriesService — API lookup provider writes', () => {
  it('TC-4/TC-3: authConfig is encrypted before it reaches the database, and rebound to the real id', async () => {
    const { service, scoped, crypto } = await build();
    scoped.create.mockImplementation((_model: unknown, values: Record<string, unknown>) =>
      Promise.resolve({
        id: 55,
        ...values,
        // Mimic Sequelize returning the row instance with the value that was written.
        authConfigEnc: values.authConfigEnc as string | null,
      }),
    );

    await service.createApiLookupProvider(superAdmin, {
      providerCode: 'NEW_LOOKUP',
      name: 'New Lookup',
      endpointUrl: 'https://internal.invalid/products',
      authType: 'api_key',
      authConfig: { apiKey: SECRET },
      responseValueKey: 'id',
      responseLabelKey: 'label',
    });

    // Phase 1 — what was handed to INSERT is ciphertext, not the credential.
    const inserted = scoped.create.mock.calls[0][1] as Record<string, unknown>;
    expect(inserted.authConfigEnc).toEqual(expect.stringMatching(/^v1\./));
    expect(JSON.stringify(inserted)).not.toContain(SECRET);

    // Phase 2 — the follow-up UPDATE rebinds it to the real id, and the result decrypts there.
    const [, values] = scoped.update.mock.calls[0] as [unknown, Record<string, unknown>];
    const rebound = values.authConfigEnc as string;
    expect(JSON.stringify(values)).not.toContain(SECRET);
    expect(crypto.decryptForRow(55, rebound)).toEqual({ apiKey: SECRET });
  });

  it('defaults status to planned, not active, when the caller does not say', async () => {
    const { service, scoped } = await build();
    scoped.create.mockResolvedValue({ id: 1, authConfigEnc: null });

    await service.createApiLookupProvider(superAdmin, {
      providerCode: 'NEW_LOOKUP',
      name: 'n',
      endpointUrl: 'u',
      responseValueKey: 'v',
      responseLabelKey: 'l',
    });

    // A provider nobody has confirmed must make T-123 decline rather than call an unverified
    // endpoint — `planned` is the safe default for an omitted status.
    const inserted = scoped.create.mock.calls[0][1] as Record<string, unknown>;
    expect(inserted.status).toBe('planned');
    expect(inserted.authType).toBe('none');
    expect(inserted.httpMethod).toBe('GET');
  });

  it('a provider created without a credential stores SQL NULL and performs no rebind UPDATE', async () => {
    const { service, scoped } = await build();
    scoped.create.mockResolvedValue({ id: 1, authConfigEnc: null });

    await service.createApiLookupProvider(superAdmin, {
      providerCode: 'NEW_LOOKUP',
      name: 'n',
      endpointUrl: 'u',
      responseValueKey: 'v',
      responseLabelKey: 'l',
    });

    const inserted = scoped.create.mock.calls[0][1] as Record<string, unknown>;
    expect(inserted.authConfigEnc).toBeNull();
    expect(scoped.update).not.toHaveBeenCalled();
  });

  it('TC-6: a duplicate providerCode is a 409', async () => {
    const { service, scoped } = await build();
    scoped.count.mockResolvedValue(1);

    await expect(
      service.createApiLookupProvider(superAdmin, {
        providerCode: 'PRODUCT_CATALOG',
        name: 'n',
        endpointUrl: 'u',
        responseValueKey: 'v',
        responseLabelKey: 'l',
      }),
    ).rejects.toBeInstanceOf(FieldApiLookupProviderCodeExistsError);
  });

  it('PATCH re-encrypts a supplied authConfig under the real id, no rebind needed', async () => {
    const { service, scoped, crypto } = await build();
    scoped.findByPkOrFail.mockResolvedValue({ id: 77, authConfigEnc: null, providerCode: 'P' });

    await service.updateApiLookupProvider(superAdmin, 77, { authConfig: { token: SECRET } });

    const [, values] = scoped.update.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(JSON.stringify(values)).not.toContain(SECRET);
    expect(crypto.decryptForRow(77, values.authConfigEnc as string)).toEqual({ token: SECRET });
  });

  it('PATCH omitting authConfig leaves the stored credential untouched', async () => {
    const { service, scoped } = await build();
    scoped.findByPkOrFail.mockResolvedValue({
      id: 77,
      authConfigEnc: 'v1.existing',
      providerCode: 'P',
    });

    await service.updateApiLookupProvider(superAdmin, 77, { name: 'renamed' });

    const [, values] = scoped.update.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(values).not.toHaveProperty('authConfigEnc');
  });

  it('the audit trail records which fields changed, never a credential value', async () => {
    const { service, scoped, audit } = await build();
    scoped.findByPkOrFail.mockResolvedValue({ id: 77, authConfigEnc: null, providerCode: 'P' });

    await service.updateApiLookupProvider(superAdmin, 77, { authConfig: { token: SECRET } });

    const annotation = audit.annotate.mock.calls[0][0] as Record<string, unknown>;
    // The audit store has a longer retention and a wider read audience than the row itself.
    expect(JSON.stringify(annotation)).not.toContain(SECRET);
    expect(annotation).toEqual({ targetId: 77, detail: { changedFields: ['authConfigEnc'] } });
  });
});

describe('FieldValueSourceRegistriesService — the unique-constraint race is handled, not just pre-checked', () => {
  // The `count` pre-check can pass and the INSERT still collide, because another request can
  // commit the same code in between. The DB constraint is the real authority; these tests prove
  // that losing the race still produces a clean 409 rather than a 500.
  it('a context provider losing the insert race becomes a 409', async () => {
    const { service, scoped } = await build();
    scoped.create.mockRejectedValue(
      new UniqueConstraintError({ errors: [], fields: { provider_code: 'X_Y' } }),
    );

    await expect(
      service.createContextProvider(superAdmin, { providerCode: 'X_Y', name: 'n' }),
    ).rejects.toBeInstanceOf(FieldContextProviderCodeExistsError);
  });

  it('an API lookup provider losing the insert race becomes a 409', async () => {
    const { service, scoped } = await build();
    scoped.create.mockRejectedValue(
      new UniqueConstraintError({ errors: [], fields: { provider_code: 'X_Y' } }),
    );

    await expect(
      service.createApiLookupProvider(superAdmin, {
        providerCode: 'X_Y',
        name: 'n',
        endpointUrl: 'u',
        responseValueKey: 'v',
        responseLabelKey: 'l',
      }),
    ).rejects.toBeInstanceOf(FieldApiLookupProviderCodeExistsError);
  });

  it('an unrelated database error is propagated unchanged, never disguised as a 409', async () => {
    const { service, scoped } = await build();
    const boom = new Error('connection reset');

    scoped.create.mockRejectedValue(boom);
    await expect(
      service.createContextProvider(superAdmin, { providerCode: 'X_Y', name: 'n' }),
    ).rejects.toBe(boom);

    await expect(
      service.createApiLookupProvider(superAdmin, {
        providerCode: 'X_Y',
        name: 'n',
        endpointUrl: 'u',
        responseValueKey: 'v',
        responseLabelKey: 'l',
      }),
    ).rejects.toBe(boom);
  });
});

describe('FieldValueSourceRegistriesService — optional field handling', () => {
  it('a create with no description stores NULL rather than an empty string', async () => {
    const { service, scoped } = await build();
    scoped.create.mockResolvedValue({ id: 1, providerCode: 'X_Y' });

    await service.createContextProvider(superAdmin, { providerCode: 'X_Y', name: 'n' });

    const inserted = scoped.create.mock.calls[0][1] as Record<string, unknown>;
    expect(inserted.description).toBeNull();
  });

  it('an API lookup create with no description and no authConfig stores NULL for both', async () => {
    const { service, scoped } = await build();
    scoped.create.mockResolvedValue({ id: 1, authConfigEnc: null });

    await service.createApiLookupProvider(superAdmin, {
      providerCode: 'X_Y',
      name: 'n',
      endpointUrl: 'u',
      responseValueKey: 'v',
      responseLabelKey: 'l',
    });

    const inserted = scoped.create.mock.calls[0][1] as Record<string, unknown>;
    expect(inserted.description).toBeNull();
    expect(inserted.authConfigEnc).toBeNull();
  });

  it('a full API lookup PATCH applies every mutable field, trimmed, and never providerCode', async () => {
    const { service, scoped } = await build();
    scoped.findByPkOrFail.mockResolvedValue({ id: 3, authConfigEnc: null, providerCode: 'ORIG' });

    await service.updateApiLookupProvider(superAdmin, 3, {
      name: '  n  ',
      description: '  d  ',
      endpointUrl: '  https://internal.invalid/x  ',
      httpMethod: 'POST',
      authType: 'bearer',
      responseValueKey: '  v  ',
      responseLabelKey: '  l  ',
      status: 'active',
    });

    const [, values] = scoped.update.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(values).toEqual({
      name: 'n',
      description: 'd',
      endpointUrl: 'https://internal.invalid/x',
      httpMethod: 'POST',
      authType: 'bearer',
      responseValueKey: 'v',
      responseLabelKey: 'l',
      status: 'active',
    });
    expect(values).not.toHaveProperty('providerCode');
  });

  it('an empty API lookup PATCH performs no UPDATE at all', async () => {
    const { service, scoped } = await build();
    scoped.findByPkOrFail.mockResolvedValue({ id: 3, authConfigEnc: null, providerCode: 'ORIG' });

    await service.updateApiLookupProvider(superAdmin, 3, {});

    expect(scoped.update).not.toHaveBeenCalled();
  });

  it('a context provider PATCH applies name and description, trimmed', async () => {
    const { service, scoped } = await build();
    scoped.findByPkOrFail.mockResolvedValue({ id: 3, providerCode: 'ORIG' });

    await service.updateContextProvider(superAdmin, 3, { name: '  n  ', description: '  d  ' });

    const [, values] = scoped.update.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(values).toEqual({ name: 'n', description: 'd' });
  });
});

describe('FieldValueSourceRegistriesService — getAuthConfigForLookup (for T-123)', () => {
  it('decrypts the credential for an existing row', async () => {
    const { service, scoped, crypto } = await build();
    scoped.findByPkOrFail.mockResolvedValue({
      id: 5,
      authConfigEnc: crypto.encryptForRow(5, { apiKey: SECRET }),
    });

    await expect(service.getAuthConfigForLookup(5)).resolves.toEqual({ apiKey: SECRET });
  });

  it('returns null for a credential-less row and for a ciphertext bound to a different row', async () => {
    const { service, scoped, crypto } = await build();

    scoped.findByPkOrFail.mockResolvedValue({ id: 5, authConfigEnc: null });
    await expect(service.getAuthConfigForLookup(5)).resolves.toBeNull();

    // Bound to a different row — the AAD check must fail rather than yield the credential.
    scoped.findByPkOrFail.mockResolvedValue({
      id: 6,
      authConfigEnc: crypto.encryptForRow(5, { apiKey: SECRET }),
    });
    await expect(service.getAuthConfigForLookup(6)).resolves.toBeNull();
  });

  it('propagates the not-found error for a provider id that does not exist', async () => {
    // Deliberately distinct from the `null` above: "no such provider" is a caller bug (404),
    // "provider exists but has no usable credential" is an ordinary state T-123 must handle.
    const { service, scoped } = await build();
    scoped.findByPkOrFail.mockRejectedValue(new Error('ScopeViolationError'));

    await expect(service.getAuthConfigForLookup(404)).rejects.toThrow();
  });
});
