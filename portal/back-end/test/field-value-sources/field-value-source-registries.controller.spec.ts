/**
 * T-121 — `FieldValueSourceRegistriesController`: thin, and metadata-driven. Same shape
 * `test/rules/rules.controller.spec.ts` establishes: the 403/404 behaviour itself belongs to
 * `RolesGuard`/`PermissionsGuard` and the service (both tested elsewhere); this suite proves the
 * controller declares the right `role_entity_permissions` grant per route (R6) and delegates
 * without adding logic.
 */
import 'reflect-metadata';
import {
  ALL_PORTAL_ROLES,
  PERMISSION_METADATA_KEY,
  ROLES_METADATA_KEY,
} from '@/common/rbac/rbac.constants';
import { AUDIT_METADATA } from '@/common/audit/decorators/audit.decorator';
import { FieldValueSourceRegistriesController } from '@/modules/field-value-sources/field-value-source-registries.controller';
import {
  FIELD_API_LOOKUP_PROVIDER_ENTITY,
  FIELD_CONTEXT_PROVIDER_ENTITY,
} from '@/modules/field-value-sources/field-value-sources.constants';
import type { FieldValueSourceRegistriesService } from '@/modules/field-value-sources/field-value-source-registries.service';

function permissionOf(handler: (...args: never[]) => unknown): { entity: string; action: string } {
  return Reflect.getMetadata(PERMISSION_METADATA_KEY, handler) as {
    entity: string;
    action: string;
  };
}

function auditOf(handler: (...args: never[]) => unknown): { event: string; targetType?: string } {
  return Reflect.getMetadata(AUDIT_METADATA, handler) as { event: string; targetType?: string };
}

const actor = { sub: 1, role: 'super_admin' } as never;

describe('FieldValueSourceRegistriesController — authorisation metadata (R6)', () => {
  it('TC-1/TC-2: the controller is reachable by every authenticated role', () => {
    // Every role needs to read both registries to render a value-source dropdown — the reads are
    // deliberately not permission-gated. See the controller header.
    const roles = Reflect.getMetadata(
      ROLES_METADATA_KEY,
      FieldValueSourceRegistriesController,
    ) as readonly string[];
    expect(roles).toEqual(ALL_PORTAL_ROLES);
  });

  it('the two GET handlers carry no @RequirePermission', () => {
    expect(
      permissionOf(FieldValueSourceRegistriesController.prototype.listContextProviders),
    ).toBeUndefined();
    expect(
      permissionOf(FieldValueSourceRegistriesController.prototype.listApiLookupProviders),
    ).toBeUndefined();
  });

  it('TC-5: writes require create/update on their own entity — super_admin only per T121_002', () => {
    expect(
      permissionOf(FieldValueSourceRegistriesController.prototype.createContextProvider),
    ).toEqual({
      entity: FIELD_CONTEXT_PROVIDER_ENTITY,
      action: 'create',
    });
    expect(
      permissionOf(FieldValueSourceRegistriesController.prototype.updateContextProvider),
    ).toEqual({
      entity: FIELD_CONTEXT_PROVIDER_ENTITY,
      action: 'update',
    });
    expect(
      permissionOf(FieldValueSourceRegistriesController.prototype.createApiLookupProvider),
    ).toEqual({
      entity: FIELD_API_LOOKUP_PROVIDER_ENTITY,
      action: 'create',
    });
    expect(
      permissionOf(FieldValueSourceRegistriesController.prototype.updateApiLookupProvider),
    ).toEqual({
      entity: FIELD_API_LOOKUP_PROVIDER_ENTITY,
      action: 'update',
    });
  });

  it('every write is audited', () => {
    expect(auditOf(FieldValueSourceRegistriesController.prototype.createContextProvider)).toEqual({
      event: 'field_context_provider_created',
      targetType: 'field_context_provider',
    });
    expect(auditOf(FieldValueSourceRegistriesController.prototype.updateApiLookupProvider)).toEqual(
      {
        event: 'field_api_lookup_provider_updated',
        targetType: 'field_api_lookup_provider',
      },
    );
  });
});

describe('FieldValueSourceRegistriesController — delegation', () => {
  it('each handler delegates to the service and wraps the result in the { data } envelope', async () => {
    const service = {
      listContextProviders: jest.fn().mockResolvedValue([{ id: 1 }]),
      listApiLookupProviders: jest.fn().mockResolvedValue([{ id: 2 }]),
      createContextProvider: jest.fn().mockResolvedValue({ id: 3 }),
      updateContextProvider: jest.fn().mockResolvedValue({ id: 4 }),
      createApiLookupProvider: jest.fn().mockResolvedValue({ id: 5 }),
      updateApiLookupProvider: jest.fn().mockResolvedValue({ id: 6 }),
    };
    const controller = new FieldValueSourceRegistriesController(
      service as unknown as FieldValueSourceRegistriesService,
    );

    expect(await controller.listContextProviders()).toEqual({ data: [{ id: 1 }] });
    expect(await controller.listApiLookupProviders()).toEqual({ data: [{ id: 2 }] });

    const createCtx = { providerCode: 'X_Y', name: 'n' } as never;
    expect(await controller.createContextProvider(actor, createCtx)).toEqual({ data: { id: 3 } });
    expect(service.createContextProvider).toHaveBeenCalledWith(actor, createCtx);

    const updateCtx = { name: 'n2' } as never;
    expect(await controller.updateContextProvider(actor, 4, updateCtx)).toEqual({
      data: { id: 4 },
    });
    expect(service.updateContextProvider).toHaveBeenCalledWith(actor, 4, updateCtx);

    const createApi = { providerCode: 'A_B' } as never;
    expect(await controller.createApiLookupProvider(actor, createApi)).toEqual({ data: { id: 5 } });
    expect(service.createApiLookupProvider).toHaveBeenCalledWith(actor, createApi);

    const updateApi = { status: 'active' } as never;
    expect(await controller.updateApiLookupProvider(actor, 6, updateApi)).toEqual({
      data: { id: 6 },
    });
    expect(service.updateApiLookupProvider).toHaveBeenCalledWith(actor, 6, updateApi);
  });

  it('exposes no handler that returns a decrypted credential', () => {
    // The service can decrypt (`getAuthConfigForLookup`, for T-123), but nothing on the HTTP
    // surface may. If a future edit adds such a route, this fails.
    const handlers = Object.getOwnPropertyNames(FieldValueSourceRegistriesController.prototype);
    expect(handlers).toEqual([
      'constructor',
      'listContextProviders',
      'createContextProvider',
      'updateContextProvider',
      'listApiLookupProviders',
      'createApiLookupProvider',
      'updateApiLookupProvider',
    ]);
  });
});
