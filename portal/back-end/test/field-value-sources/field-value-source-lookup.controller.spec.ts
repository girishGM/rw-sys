/**
 * T-123 — `FieldValueSourceLookupController`: thin and metadata-driven, same shape
 * `field-value-source-registries.controller.spec.ts` (T-121) establishes. The 401/403 behaviour
 * itself belongs to the global guards (tested elsewhere); this suite proves the controller
 * declares no permission gate (implementation note 3: every authenticated role may call both
 * endpoints) and delegates without adding logic of its own.
 */
import 'reflect-metadata';
import {
  ALL_PORTAL_ROLES,
  PERMISSION_METADATA_KEY,
  ROLES_METADATA_KEY,
} from '@/common/rbac/rbac.constants';
import { FieldValueSourceLookupController } from '@/modules/field-value-sources/field-value-source-lookup.controller';
import type { FieldValueSourceLookupService } from '@/modules/field-value-sources/field-value-source-lookup.service';

function permissionOf(handler: (...args: never[]) => unknown): unknown {
  return Reflect.getMetadata(PERMISSION_METADATA_KEY, handler);
}

describe('FieldValueSourceLookupController — authorisation metadata', () => {
  it('is reachable by every authenticated role', () => {
    const roles = Reflect.getMetadata(
      ROLES_METADATA_KEY,
      FieldValueSourceLookupController,
    ) as readonly string[];
    expect(roles).toEqual(ALL_PORTAL_ROLES);
  });

  it('neither GET handler carries a @RequirePermission — both are plain reads', () => {
    expect(permissionOf(FieldValueSourceLookupController.prototype.contextLookup)).toBeUndefined();
    expect(permissionOf(FieldValueSourceLookupController.prototype.apiLookup)).toBeUndefined();
  });

  it('exposes exactly the two documented handlers', () => {
    const handlers = Object.getOwnPropertyNames(FieldValueSourceLookupController.prototype);
    expect(handlers).toEqual(['constructor', 'contextLookup', 'apiLookup']);
  });
});

describe('FieldValueSourceLookupController — delegation', () => {
  it('contextLookup passes providerCode/trackerId/excludeComponentId through and envelopes the result', async () => {
    const service = {
      contextLookup: jest.fn().mockResolvedValue([{ value: 1, label: 'A' }]),
      apiLookup: jest.fn(),
    };
    const controller = new FieldValueSourceLookupController(
      service as unknown as FieldValueSourceLookupService,
    );

    const result = await controller.contextLookup('SIBLING_COMPONENTS', {
      trackerId: 5,
      excludeComponentId: 9,
    } as never);

    expect(result).toEqual({ data: [{ value: 1, label: 'A' }] });
    expect(service.contextLookup).toHaveBeenCalledWith('SIBLING_COMPONENTS', 5, 9);
  });

  it('contextLookup tolerates an omitted excludeComponentId', async () => {
    const service = { contextLookup: jest.fn().mockResolvedValue([]), apiLookup: jest.fn() };
    const controller = new FieldValueSourceLookupController(
      service as unknown as FieldValueSourceLookupService,
    );

    await controller.contextLookup('JOURNEY_COMPONENTS', { trackerId: 5 } as never);

    expect(service.contextLookup).toHaveBeenCalledWith('JOURNEY_COMPONENTS', 5, undefined);
  });

  it('apiLookup passes providerCode through and envelopes the result', async () => {
    const service = {
      contextLookup: jest.fn(),
      apiLookup: jest.fn().mockResolvedValue([{ value: 'x', label: 'X' }]),
    };
    const controller = new FieldValueSourceLookupController(
      service as unknown as FieldValueSourceLookupService,
    );

    const result = await controller.apiLookup('PRODUCT_CATALOG');

    expect(result).toEqual({ data: [{ value: 'x', label: 'X' }] });
    expect(service.apiLookup).toHaveBeenCalledWith('PRODUCT_CATALOG');
  });
});
