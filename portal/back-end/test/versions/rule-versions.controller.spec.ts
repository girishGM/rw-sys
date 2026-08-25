/**
 * T-041 — `RuleVersionsController`: thin and metadata-driven, the same shape
 * `test/rules/rules.controller.spec.ts` establishes for `RulesController`.
 */
import 'reflect-metadata';
import { PERMISSION_METADATA_KEY, ROLES_METADATA_KEY } from '@/common/rbac/rbac.constants';
import { AUDIT_METADATA } from '@/common/audit/decorators/audit.decorator';
import { RuleVersionsController } from '@/modules/versions/rule-versions.controller';
import type { RuleVersionsService } from '@/modules/versions/rule-versions.service';
import { actor } from './support/versions-doubles';

function permissionOf(handler: (...args: never[]) => unknown): { entity: string; action: string } {
  return Reflect.getMetadata(PERMISSION_METADATA_KEY, handler) as {
    entity: string;
    action: string;
  };
}

function rolesOf(handler: (...args: never[]) => unknown): readonly string[] {
  return Reflect.getMetadata(ROLES_METADATA_KEY, handler) as readonly string[];
}

function auditOf(handler: (...args: never[]) => unknown): { event: string; targetType?: string } {
  return Reflect.getMetadata(AUDIT_METADATA, handler) as { event: string; targetType?: string };
}

describe('RuleVersionsController — authorisation metadata (R6)', () => {
  it('reads reuse rule:view', () => {
    for (const handler of [
      RuleVersionsController.prototype.list,
      RuleVersionsController.prototype.findOne,
      RuleVersionsController.prototype.diff,
      RuleVersionsController.prototype.countries,
    ]) {
      expect(permissionOf(handler)).toEqual({ entity: 'rule', action: 'view' });
    }
  });

  it('every write route is super_admin only', () => {
    for (const handler of [
      RuleVersionsController.prototype.create,
      RuleVersionsController.prototype.update,
      RuleVersionsController.prototype.publish,
      RuleVersionsController.prototype.deprecate,
      RuleVersionsController.prototype.retire,
      RuleVersionsController.prototype.withdraw,
    ]) {
      expect(rolesOf(handler)).toEqual(['super_admin']);
    }
  });

  it('every write route is audited', () => {
    expect(auditOf(RuleVersionsController.prototype.create)).toMatchObject({
      event: 'rule_version_drafted',
    });
    expect(auditOf(RuleVersionsController.prototype.publish)).toMatchObject({
      event: 'rule_version_published',
    });
    expect(auditOf(RuleVersionsController.prototype.withdraw)).toMatchObject({
      event: 'rule_version_withdrawn',
    });
  });
});

describe('RuleVersionsController — delegation', () => {
  function controllerWith(service: Partial<RuleVersionsService>): RuleVersionsController {
    return new RuleVersionsController(service as RuleVersionsService);
  }

  it('list() delegates the ruleId and wraps the result', async () => {
    const list = jest.fn().mockResolvedValue([{ id: 1 }]);
    const controller = controllerWith({ list });
    const response = await controller.list(1);
    expect(list).toHaveBeenCalledWith(1);
    expect(response.data).toHaveLength(1);
  });

  it('create() passes the actor, ruleId and dto through', async () => {
    const createDraft = jest.fn().mockResolvedValue({ id: 1 });
    const controller = controllerWith({ createDraft });
    const who = actor();
    await controller.create(who, 1, {});
    expect(createDraft).toHaveBeenCalledWith(who, 1, {});
  });

  it('diff() passes ruleId, versionId and otherVersionId through', async () => {
    const diff = jest.fn().mockResolvedValue({ versionId: 1 });
    const controller = controllerWith({ diff });
    await controller.diff(1, 2, 3);
    expect(diff).toHaveBeenCalledWith(1, 2, 3);
  });

  it('withdraw() passes the actor, ruleId, versionId and countryId through', async () => {
    const withdrawFromCountry = jest.fn().mockResolvedValue(undefined);
    const controller = controllerWith({ withdrawFromCountry });
    const who = actor();
    await controller.withdraw(who, 1, 2, 3);
    expect(withdrawFromCountry).toHaveBeenCalledWith(who, 1, 2, 3);
  });

  it('findOne() delegates ruleId and versionId', async () => {
    const getById = jest.fn().mockResolvedValue({ id: 9 });
    const controller = controllerWith({ getById });
    const response = await controller.findOne(1, 9);
    expect(getById).toHaveBeenCalledWith(1, 9);
    expect(response.data).toMatchObject({ id: 9 });
  });

  it('countries() delegates ruleId and versionId', async () => {
    const listCountryAssignments = jest.fn().mockResolvedValue([{ id: 1 }]);
    const controller = controllerWith({ listCountryAssignments });
    const response = await controller.countries(1, 2);
    expect(listCountryAssignments).toHaveBeenCalledWith(1, 2);
    expect(response.data).toHaveLength(1);
  });

  it('update() passes the actor, ruleId, versionId and dto through', async () => {
    const updateDraft = jest.fn().mockResolvedValue({ id: 1 });
    const controller = controllerWith({ updateDraft });
    const who = actor();
    await controller.update(who, 1, 2, { expression: 'x' });
    expect(updateDraft).toHaveBeenCalledWith(who, 1, 2, { expression: 'x' });
  });

  it('publish() passes the actor, ruleId and versionId through', async () => {
    const publish = jest.fn().mockResolvedValue({ id: 1 });
    const controller = controllerWith({ publish });
    const who = actor();
    await controller.publish(who, 1, 2);
    expect(publish).toHaveBeenCalledWith(who, 1, 2);
  });

  it('deprecate() passes the actor, ruleId and versionId through', async () => {
    const deprecate = jest.fn().mockResolvedValue({ id: 1 });
    const controller = controllerWith({ deprecate });
    const who = actor();
    await controller.deprecate(who, 1, 2);
    expect(deprecate).toHaveBeenCalledWith(who, 1, 2);
  });

  it('retire() passes the actor, ruleId and versionId through', async () => {
    const retire = jest.fn().mockResolvedValue({ id: 1 });
    const controller = controllerWith({ retire });
    const who = actor();
    await controller.retire(who, 1, 2);
    expect(retire).toHaveBeenCalledWith(who, 1, 2);
  });
});
