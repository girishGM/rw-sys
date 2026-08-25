/**
 * T-041 — `BlastsController`: thin and metadata-driven, the same shape every other Wave 3
 * controller test in this codebase establishes.
 */
import 'reflect-metadata';
import { ROLES_METADATA_KEY } from '@/common/rbac/rbac.constants';
import { AUDIT_METADATA } from '@/common/audit/decorators/audit.decorator';
import { BlastsController } from '@/modules/blasts/blasts.controller';
import type { BlastsService } from '@/modules/blasts/blasts.service';
import { actor } from '../versions/support/versions-doubles';

function rolesOf(handler: (...args: never[]) => unknown): readonly string[] {
  return Reflect.getMetadata(ROLES_METADATA_KEY, handler) as readonly string[];
}

function auditOf(handler: (...args: never[]) => unknown): { event: string; targetType?: string } {
  return Reflect.getMetadata(AUDIT_METADATA, handler) as { event: string; targetType?: string };
}

describe('BlastsController — authorisation metadata (R6)', () => {
  it('preview and create are super_admin only', () => {
    expect(rolesOf(BlastsController.prototype.preview)).toEqual(['super_admin']);
    expect(rolesOf(BlastsController.prototype.create)).toEqual(['super_admin']);
  });

  it('list and findOne admit super_admin and country_admin (TC-16…TC-18)', () => {
    expect(rolesOf(BlastsController.prototype.list)).toEqual(['super_admin', 'country_admin']);
    expect(rolesOf(BlastsController.prototype.findOne)).toEqual(['super_admin', 'country_admin']);
  });

  it('the blast is audited (TC-28)', () => {
    expect(auditOf(BlastsController.prototype.create)).toMatchObject({
      event: 'version_blasted',
      targetType: 'version_blast',
    });
  });

  it('preview carries no @Audit — no write to record', () => {
    expect(auditOf(BlastsController.prototype.preview)).toBeUndefined();
  });
});

describe('BlastsController — delegation', () => {
  function controllerWith(service: Partial<BlastsService>): BlastsController {
    return new BlastsController(service as BlastsService);
  }

  it('preview() passes the actor and dto through', async () => {
    const preview = jest.fn().mockResolvedValue({ countries: [] });
    const controller = controllerWith({ preview });
    const who = actor();
    const dto = {
      entityType: 'rule',
      entityId: 1,
      versionId: 2,
      scope: 'all_countries',
    } as Parameters<BlastsService['preview']>[1];

    await controller.preview(who, dto);
    expect(preview).toHaveBeenCalledWith(who, dto);
  });

  it('create() passes the actor and dto through', async () => {
    const create = jest.fn().mockResolvedValue({ id: 1 });
    const controller = controllerWith({ create });
    const who = actor();
    const dto = {
      entityType: 'rule',
      entityId: 1,
      versionId: 2,
      scope: 'all_countries',
    } as Parameters<BlastsService['create']>[1];

    await controller.create(who, dto);
    expect(create).toHaveBeenCalledWith(who, dto);
  });

  it('list() wraps {rows, meta} into {data, meta}', async () => {
    const list = jest.fn().mockResolvedValue({
      rows: [{ id: 1 }],
      meta: { page: 1, pageSize: 20, total: 1 },
    });
    const controller = controllerWith({ list });
    const who = actor();

    const response = await controller.list(who, {});
    expect(list).toHaveBeenCalledWith(who, {});
    expect(response.data).toHaveLength(1);
    expect(response.meta.total).toBe(1);
  });

  it('findOne() passes the actor and id through', async () => {
    const getById = jest.fn().mockResolvedValue({ id: 9 });
    const controller = controllerWith({ getById });
    const who = actor();

    const response = await controller.findOne(who, 9);
    expect(getById).toHaveBeenCalledWith(who, 9);
    expect(response.data).toMatchObject({ id: 9 });
  });
});
