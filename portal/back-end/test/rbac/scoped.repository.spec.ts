/**
 * T-013 — `ScopedRepository`.
 *
 * The models here are the **real** model classes, registered on a never-connected Sequelize
 * instance, with their statics spied on. That combination is deliberate:
 *
 *  - real classes, so `primaryKeyAttribute` and the attribute names are the production ones and
 *    a rename in `scope-strategy.ts` that no longer matches a column is caught here;
 *  - spied statics, so every assertion is about the **options object actually handed to
 *    Sequelize** — which is the thing that becomes a WHERE clause. A test that asserted on rows
 *    returned by a fake repository would be testing the fake.
 *
 * Whether those options produce the right SQL, and whether that SQL returns the right rows, is
 * `rbac.e2e-spec.ts`'s job against the real database.
 */
import { Op, literal } from 'sequelize';
import {
  CampaignMerchant,
  SystemMessage,
  Tenant,
  TenantCampaign,
  VersionBlast,
} from '@/database/models';
import { buildTestSequelize } from '@/database/models/build-test-sequelize';
import {
  MissingScopeContextError,
  ScopeContext,
  ScopeViolationError,
  ScopedRepository,
  mergeReplacements,
  mergeWhere,
  type RequestScope,
} from '@/common/scope';

buildTestSequelize();

const superAdmin: RequestScope = {
  userId: 1,
  role: 'super_admin',
  countryId: null,
  tenantId: null,
  merchantId: null,
};
const makerA: RequestScope = {
  userId: 3,
  role: 'maker',
  countryId: 3,
  tenantId: 7,
  merchantId: null,
};
const countryAdmin: RequestScope = {
  userId: 2,
  role: 'country_admin',
  countryId: 3,
  tenantId: null,
  merchantId: null,
};
const merchantUser: RequestScope = {
  userId: 4,
  role: 'merchant',
  countryId: 3,
  tenantId: 7,
  merchantId: 42,
};

/** Last options object a spied static received. */
type Captured = Record<string, unknown>;

describe('ScopedRepository', () => {
  let repository: ScopedRepository;

  beforeEach(() => {
    repository = new ScopedRepository();
    jest.restoreAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // --- TC-13: no context, no query ----------------------------------------------------------

  describe('TC-13 — with no scope context', () => {
    it.each([
      ['findAll', () => repository.findAll(TenantCampaign)],
      ['findOne', () => repository.findOne(TenantCampaign)],
      ['findByPk', () => repository.findByPk(TenantCampaign, 1)],
      ['findByPkOrFail', () => repository.findByPkOrFail(TenantCampaign, 1)],
      ['findOneOrFail', () => repository.findOneOrFail(TenantCampaign)],
      ['count', () => repository.count(TenantCampaign)],
      ['create', () => repository.create(TenantCampaign, {} as never)],
      ['update', () => repository.update(TenantCampaign, {}, { where: { id: 1 } })],
      ['destroy', () => repository.destroy(TenantCampaign, { where: { id: 1 } })],
    ])('%s throws MissingScopeContextError and issues no query', async (_name, call) => {
      const findAll = jest.spyOn(TenantCampaign, 'findAll').mockResolvedValue([]);
      const create = jest.spyOn(TenantCampaign, 'create').mockResolvedValue({} as never);
      const update = jest.spyOn(TenantCampaign, 'update').mockResolvedValue([0] as never);
      const destroy = jest.spyOn(TenantCampaign, 'destroy').mockResolvedValue(0);

      await expect(call()).rejects.toThrow(MissingScopeContextError);

      // The important half: not merely "it threw", but "it never reached the database".
      expect(findAll).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
      expect(destroy).not.toHaveBeenCalled();
    });
  });

  // --- reads -------------------------------------------------------------------------------

  describe('findAll', () => {
    it('applies the tenant clause for a maker', async () => {
      const spy = jest.spyOn(TenantCampaign, 'findAll').mockResolvedValue([]);
      await ScopeContext.run(makerA, () => repository.findAll(TenantCampaign));

      expect((spy.mock.calls[0][0] as Captured).where).toEqual({ tenantId: 7 });
    });

    it('conjoins the caller’s clause with the scope clause, never replacing it', async () => {
      const spy = jest.spyOn(TenantCampaign, 'findAll').mockResolvedValue([]);
      await ScopeContext.run(makerA, () =>
        repository.findAll(TenantCampaign, { where: { status: 'draft' } }),
      );

      expect((spy.mock.calls[0][0] as Captured).where).toEqual({
        [Op.and]: [{ status: 'draft' }, { tenantId: 7 }],
      });
    });

    it('cannot be talked out of the scope by a caller supplying its own tenantId', async () => {
      const spy = jest.spyOn(TenantCampaign, 'findAll').mockResolvedValue([]);
      await ScopeContext.run(makerA, () =>
        repository.findAll(TenantCampaign, { where: { tenantId: 999 } }),
      );

      // Both predicates survive, so the query is `tenantId = 999 AND tenantId = 7` — which
      // matches nothing. A shallow merge would have produced one or the other.
      expect((spy.mock.calls[0][0] as Captured).where).toEqual({
        [Op.and]: [{ tenantId: 999 }, { tenantId: 7 }],
      });
    });

    it('adds no clause for a super_admin (global by design)', async () => {
      const spy = jest.spyOn(TenantCampaign, 'findAll').mockResolvedValue([]);
      await ScopeContext.run(superAdmin, () => repository.findAll(TenantCampaign));

      expect((spy.mock.calls[0][0] as Captured).where).toBeUndefined();
    });

    it('preserves the caller’s clause verbatim for a super_admin', async () => {
      const spy = jest.spyOn(TenantCampaign, 'findAll').mockResolvedValue([]);
      await ScopeContext.run(superAdmin, () =>
        repository.findAll(TenantCampaign, { where: { status: 'draft' } }),
      );

      expect((spy.mock.calls[0][0] as Captured).where).toEqual({ status: 'draft' });
    });

    it('passes the subquery’s bound value through as a replacement', async () => {
      const spy = jest.spyOn(TenantCampaign, 'findAll').mockResolvedValue([]);
      await ScopeContext.run(countryAdmin, () => repository.findAll(TenantCampaign));

      expect((spy.mock.calls[0][0] as Captured).replacements).toEqual({ rsScope0: 3 });
    });

    it('leaves replacements undefined when the clause needs none', async () => {
      const spy = jest.spyOn(TenantCampaign, 'findAll').mockResolvedValue([]);
      await ScopeContext.run(makerA, () => repository.findAll(TenantCampaign));

      expect((spy.mock.calls[0][0] as Captured).replacements).toBeUndefined();
    });

    it('preserves unrelated options such as limit, order and include', async () => {
      const spy = jest.spyOn(TenantCampaign, 'findAll').mockResolvedValue([]);
      await ScopeContext.run(makerA, () =>
        repository.findAll(TenantCampaign, { limit: 20, offset: 40, order: [['id', 'DESC']] }),
      );

      const options = spy.mock.calls[0][0] as Captured;
      expect(options.limit).toBe(20);
      expect(options.offset).toBe(40);
      expect(options.order).toEqual([['id', 'DESC']]);
    });

    it('adds nothing at all for unrestricted reference data', async () => {
      const spy = jest.spyOn(SystemMessage, 'findAll').mockResolvedValue([]);
      await ScopeContext.run(merchantUser, () => repository.findAll(SystemMessage));

      expect((spy.mock.calls[0][0] as Captured).where).toBeUndefined();
    });

    it('produces a matches-nothing clause for a denied model instead of erroring', async () => {
      const spy = jest.spyOn(VersionBlast, 'findAll').mockResolvedValue([]);
      await ScopeContext.run(makerA, () => repository.findAll(VersionBlast));

      expect(((spy.mock.calls[0][0] as Captured).where as { val: string }).val).toBe('1 = 0');
    });
  });

  describe('findOne', () => {
    it('scopes the same way findAll does', async () => {
      const spy = jest.spyOn(TenantCampaign, 'findOne').mockResolvedValue(null);
      await ScopeContext.run(makerA, () => repository.findOne(TenantCampaign));

      expect((spy.mock.calls[0][0] as Captured).where).toEqual({ tenantId: 7 });
    });

    it('returns the row when there is one', async () => {
      const row = { id: 1 } as TenantCampaign;
      jest.spyOn(TenantCampaign, 'findOne').mockResolvedValue(row);

      await expect(
        ScopeContext.run(makerA, () => repository.findOne(TenantCampaign)),
      ).resolves.toBe(row);
    });
  });

  describe('findByPk — the most dangerous method in the ORM', () => {
    it('TC-5: keeps the scope clause alongside the primary key', async () => {
      const spy = jest.spyOn(TenantCampaign, 'findOne').mockResolvedValue(null);
      await ScopeContext.run(makerA, () => repository.findByPk(TenantCampaign, 42));

      // `id = 42 AND tenant_id = 7`. Tenant B's campaign 42 is unreachable, not rejected.
      expect((spy.mock.calls[0][0] as Captured).where).toEqual({
        [Op.and]: [{ id: 42 }, { tenantId: 7 }],
      });
    });

    it('never calls Sequelize’s own findByPk, which would discard the scope', async () => {
      const findByPk = jest.spyOn(TenantCampaign, 'findByPk');
      jest.spyOn(TenantCampaign, 'findOne').mockResolvedValue(null);

      await ScopeContext.run(makerA, () => repository.findByPk(TenantCampaign, 42));
      expect(findByPk).not.toHaveBeenCalled();
    });

    it('uses the model’s declared primary key attribute, not a hardcoded "id"', async () => {
      const spy = jest.spyOn(Tenant, 'findOne').mockResolvedValue(null);
      await ScopeContext.run(superAdmin, () => repository.findByPk(Tenant, 5));

      expect((spy.mock.calls[0][0] as Captured).where).toEqual({ [Tenant.primaryKeyAttribute]: 5 });
    });

    it('keeps a caller’s extra predicate as well', async () => {
      const spy = jest.spyOn(TenantCampaign, 'findOne').mockResolvedValue(null);
      await ScopeContext.run(makerA, () =>
        repository.findByPk(TenantCampaign, 42, { where: { status: 'draft' } }),
      );

      expect((spy.mock.calls[0][0] as Captured).where).toEqual({
        [Op.and]: [{ [Op.and]: [{ status: 'draft' }, { id: 42 }] }, { tenantId: 7 }],
      });
    });
  });

  describe('the *OrFail variants — 404, never 403 (02-SECURITY §5.1)', () => {
    it('throws a 404 for an out-of-scope row', async () => {
      jest.spyOn(TenantCampaign, 'findOne').mockResolvedValue(null);

      await expect(
        ScopeContext.run(makerA, () => repository.findByPkOrFail(TenantCampaign, 42)),
      ).rejects.toBeInstanceOf(ScopeViolationError);
    });

    it('TC-3: the 404 body carries a code and nothing else', async () => {
      jest.spyOn(TenantCampaign, 'findOne').mockResolvedValue(null);

      const error: ScopeViolationError = await ScopeContext.run(makerA, () =>
        repository
          .findByPkOrFail(TenantCampaign, 42)
          .then(() => {
            throw new Error('expected findByPkOrFail to reject');
          })
          .catch((e: ScopeViolationError) => e),
      );

      expect(error.getStatus()).toBe(404);
      expect(error.getResponse()).toEqual({ error: { code: 'NOT_FOUND' } });
      // No id, no model name, no reason — a 404 that named the resource would be a 403 in
      // disguise.
      expect(JSON.stringify(error.getResponse())).not.toContain('42');
      expect(JSON.stringify(error.getResponse())).not.toContain('TenantCampaign');
    });

    it('returns the row when it is in scope', async () => {
      const row = { id: 42 } as TenantCampaign;
      jest.spyOn(TenantCampaign, 'findOne').mockResolvedValue(row);

      await expect(
        ScopeContext.run(makerA, () => repository.findByPkOrFail(TenantCampaign, 42)),
      ).resolves.toBe(row);
    });

    it('findOneOrFail behaves identically', async () => {
      jest.spyOn(TenantCampaign, 'findOne').mockResolvedValue(null);
      await expect(
        ScopeContext.run(makerA, () => repository.findOneOrFail(TenantCampaign)),
      ).rejects.toBeInstanceOf(ScopeViolationError);

      const row = { id: 1 } as TenantCampaign;
      jest.spyOn(TenantCampaign, 'findOne').mockResolvedValue(row);
      await expect(
        ScopeContext.run(makerA, () => repository.findOneOrFail(TenantCampaign)),
      ).resolves.toBe(row);
    });
  });

  describe('count', () => {
    it('TC-6: counts within the scope, so pagination totals cannot leak', async () => {
      const spy = jest.spyOn(TenantCampaign, 'count').mockResolvedValue(3);
      const total = await ScopeContext.run(makerA, () => repository.count(TenantCampaign));

      expect(total).toBe(3);
      expect((spy.mock.calls[0][0] as Captured).where).toEqual({ tenantId: 7 });
    });
  });

  // --- writes ------------------------------------------------------------------------------

  describe('create', () => {
    it('TC-14: overwrites a caller-supplied tenantId with the scope’s', async () => {
      const spy = jest.spyOn(TenantCampaign, 'create').mockResolvedValue({} as never);
      await ScopeContext.run(makerA, () =>
        repository.create(TenantCampaign, { name: 'X', tenantId: 999 } as never),
      );

      expect(spy.mock.calls[0][0]).toEqual({ name: 'X', tenantId: 7 });
    });

    it('forces every scope column, not just the first', async () => {
      const spy = jest.spyOn(CampaignMerchant, 'create').mockResolvedValue({} as never);
      await ScopeContext.run(merchantUser, () =>
        repository.create(CampaignMerchant, {
          campaignId: 1,
          tenantId: 999,
          merchantId: 999,
        } as never),
      );

      expect(spy.mock.calls[0][0]).toEqual({ campaignId: 1, tenantId: 7, merchantId: 42 });
    });

    it('leaves a super_admin’s values untouched', async () => {
      const spy = jest.spyOn(TenantCampaign, 'create').mockResolvedValue({} as never);
      await ScopeContext.run(superAdmin, () =>
        repository.create(TenantCampaign, { name: 'X', tenantId: 999 } as never),
      );

      expect(spy.mock.calls[0][0]).toEqual({ name: 'X', tenantId: 999 });
    });

    it('refuses outright on a denied model rather than writing an unreadable row', async () => {
      const spy = jest.spyOn(VersionBlast, 'create').mockResolvedValue({} as never);

      await expect(
        ScopeContext.run(makerA, () => repository.create(VersionBlast, {} as never)),
      ).rejects.toBeInstanceOf(ScopeViolationError);
      expect(spy).not.toHaveBeenCalled();
    });

    it('passes creation options (a transaction) through', async () => {
      const spy = jest.spyOn(TenantCampaign, 'create').mockResolvedValue({} as never);
      const transaction = { id: 'tx' } as never;

      await ScopeContext.run(makerA, () =>
        repository.create(TenantCampaign, { name: 'X' } as never, { transaction }),
      );

      expect((spy.mock.calls[0][1] as Captured).transaction).toBe(transaction);
    });
  });

  describe('update', () => {
    it('TC-7: scopes the WHERE, so another tenant’s row is not matched', async () => {
      const spy = jest.spyOn(TenantCampaign, 'update').mockResolvedValue([0] as never);
      const affected = await ScopeContext.run(makerA, () =>
        repository.update(TenantCampaign, { name: 'X' }, { where: { id: 42 } }),
      );

      expect(affected).toBe(0);
      expect((spy.mock.calls[0][1] as unknown as Captured).where).toEqual({
        [Op.and]: [{ id: 42 }, { tenantId: 7 }],
      });
    });

    it('returns the affected count when the row is in scope', async () => {
      jest.spyOn(TenantCampaign, 'update').mockResolvedValue([1] as never);
      await expect(
        ScopeContext.run(makerA, () =>
          repository.update(TenantCampaign, { name: 'X' }, { where: { id: 42 } }),
        ),
      ).resolves.toBe(1);
    });

    it('strips the scope columns from the values — a row cannot be moved out of scope', async () => {
      const spy = jest.spyOn(TenantCampaign, 'update').mockResolvedValue([1] as never);
      await ScopeContext.run(makerA, () =>
        repository.update(TenantCampaign, { name: 'X', tenantId: 999 }, { where: { id: 42 } }),
      );

      expect(spy.mock.calls[0][0]).toEqual({ name: 'X' });
    });

    it('does not mutate the caller’s values object while doing so', async () => {
      jest.spyOn(TenantCampaign, 'update').mockResolvedValue([1] as never);
      const values = { name: 'X', tenantId: 999 };

      await ScopeContext.run(makerA, () =>
        repository.update(TenantCampaign, values, { where: { id: 42 } }),
      );

      expect(values).toEqual({ name: 'X', tenantId: 999 });
    });

    it('refuses an update with no where — an unbounded write is never issued', async () => {
      const spy = jest.spyOn(TenantCampaign, 'update').mockResolvedValue([0] as never);

      await expect(
        ScopeContext.run(superAdmin, () =>
          repository.update(TenantCampaign, { name: 'X' }, {} as never),
        ),
      ).rejects.toThrow(/requires an explicit `where`/);
      expect(spy).not.toHaveBeenCalled();
    });

    it('refuses an update whose where is an empty object', async () => {
      await expect(
        ScopeContext.run(superAdmin, () =>
          repository.update(TenantCampaign, { name: 'X' }, { where: {} }),
        ),
      ).rejects.toThrow(/requires an explicit `where`/);
    });

    it('accepts a symbol-keyed where such as Op.and (Reflect.ownKeys, not Object.keys)', async () => {
      const spy = jest.spyOn(TenantCampaign, 'update').mockResolvedValue([1] as never);
      await ScopeContext.run(makerA, () =>
        repository.update(
          TenantCampaign,
          { name: 'X' },
          { where: { [Op.and]: [{ id: 1 }, { status: 'draft' }] } },
        ),
      );

      expect(spy).toHaveBeenCalled();
    });
  });

  describe('destroy', () => {
    it('scopes the WHERE and returns the deleted count', async () => {
      const spy = jest.spyOn(TenantCampaign, 'destroy').mockResolvedValue(1);
      const deleted = await ScopeContext.run(makerA, () =>
        repository.destroy(TenantCampaign, { where: { id: 42 } }),
      );

      expect(deleted).toBe(1);
      expect((spy.mock.calls[0][0] as Captured).where).toEqual({
        [Op.and]: [{ id: 42 }, { tenantId: 7 }],
      });
    });

    it('refuses a destroy with no where', async () => {
      const spy = jest.spyOn(TenantCampaign, 'destroy').mockResolvedValue(0);

      await expect(
        ScopeContext.run(superAdmin, () => repository.destroy(TenantCampaign, {} as never)),
      ).rejects.toThrow(/requires an explicit `where`/);
      expect(spy).not.toHaveBeenCalled();
    });
  });

  // --- the merge helpers, directly ----------------------------------------------------------

  describe('mergeWhere', () => {
    // Explicit type argument: `WhereOptions<unknown>` rejects arbitrary attribute names, and the
    // point of these cases is the merge behaviour, not the attribute typing.
    interface Row {
      id: number;
      tenantId: number;
    }

    it('returns the caller’s clause when there is no scope clause', () => {
      expect(mergeWhere<Row>(null, { id: 1 })).toEqual({ id: 1 });
      expect(mergeWhere<Row>(undefined, { id: 1 })).toEqual({ id: 1 });
    });

    it('returns the scope clause when the caller supplied none', () => {
      expect(mergeWhere<Row>({ tenantId: 7 }, undefined)).toEqual({ tenantId: 7 });
    });

    it('returns undefined when there is neither', () => {
      expect(mergeWhere<Row>(null, undefined)).toBeUndefined();
    });

    it('conjoins both, caller first', () => {
      expect(mergeWhere<Row>({ tenantId: 7 }, { id: 1 })).toEqual({
        [Op.and]: [{ id: 1 }, { tenantId: 7 }],
      });
    });
  });

  describe('mergeReplacements', () => {
    it('returns undefined when neither side has any', () => {
      expect(mergeReplacements(undefined, {})).toBeUndefined();
    });

    it('returns the scope’s when the caller supplied none', () => {
      expect(mergeReplacements(undefined, { rsScope0: 3 })).toEqual({ rsScope0: 3 });
    });

    it('merges both', () => {
      expect(mergeReplacements({ status: 'draft' }, { rsScope0: 3 })).toEqual({
        status: 'draft',
        rsScope0: 3,
      });
    });

    it('refuses a caller that tries to bind a reserved rsScope name', () => {
      // The one way the replacement mechanism could be turned against the clause it protects.
      expect(() => mergeReplacements({ rsScope0: 999 }, { rsScope0: 3 })).toThrow(/reserved/);
    });

    it('refuses the reserved prefix even when the scope needs no replacements of its own', () => {
      expect(() => mergeReplacements({ rsScope7: 1 }, {})).toThrow(/reserved/);
    });
  });

  describe('caller-supplied replacements', () => {
    it('are merged with the scope’s rather than dropped', async () => {
      const spy = jest.spyOn(TenantCampaign, 'findAll').mockResolvedValue([]);
      await ScopeContext.run(countryAdmin, () =>
        repository.findAll(TenantCampaign, {
          where: literal('name = :wanted'),
          replacements: { wanted: 'X' },
        } as never),
      );

      expect((spy.mock.calls[0][0] as Captured).replacements).toEqual({
        wanted: 'X',
        rsScope0: 3,
      });
    });
  });

  /**
   * Appended by T-015, which added `listAll` to `ScopedRepository`. See that method's own comment
   * for why it exists: T-013's `no-raw-model-access` rule bans the property name `findAll` on
   * every receiver — an assertion this very suite's sibling `no-raw-model-access.spec.ts` makes
   * deliberately — which leaves a service in `src/modules/` unable to call the one method R2
   * requires it to call. `listAll` is the same method under a name no Sequelize `Model` has, so
   * `Campaign.listAll()` is a compile error rather than an unlinted bypass.
   *
   * The tests below therefore assert one thing above all: **it is `findAll`, not a second
   * implementation.** An alias that drifted from the method it aliases would be a scoped read
   * that scopes differently, which is the worst possible outcome for a convenience name.
   */
  describe('listAll — the alias src/modules/ uses (T-015)', () => {
    it('applies the identical scope clause to findAll', async () => {
      const spy = jest.spyOn(TenantCampaign, 'findAll').mockResolvedValue([]);

      await ScopeContext.run(makerA, () => repository.listAll(TenantCampaign));
      await ScopeContext.run(makerA, () => repository.findAll(TenantCampaign));

      expect(spy.mock.calls[0][0]).toEqual(spy.mock.calls[1][0]);
      expect((spy.mock.calls[0][0] as Captured).where).toEqual({ tenantId: 7 });
    });

    it('conjoins a caller clause and binds subquery replacements, exactly as findAll does', async () => {
      const spy = jest.spyOn(TenantCampaign, 'findAll').mockResolvedValue([]);

      await ScopeContext.run(countryAdmin, () =>
        repository.listAll(TenantCampaign, { where: { status: 'draft' } }),
      );

      const captured = spy.mock.calls[0][0] as Captured;
      expect(captured.replacements).toEqual({ rsScope0: 3 });

      // The caller's clause is conjoined, not replaced — the scope predicate sits beside it under
      // `Op.and`, which is a symbol key and therefore invisible to `JSON.stringify`.
      const conjoined = (captured.where as Record<symbol, unknown[]>)[Op.and];
      expect(conjoined[0]).toEqual({ status: 'draft' });
      expect(conjoined).toHaveLength(2);
    });

    it('returns the rows the model returns', async () => {
      const rows = [{ id: 1 }] as never;
      jest.spyOn(TenantCampaign, 'findAll').mockResolvedValue(rows);

      await expect(
        ScopeContext.run(makerA, () => repository.listAll(TenantCampaign)),
      ).resolves.toBe(rows);
    });

    it('throws MissingScopeContextError with no context, and issues no query (TC-13)', async () => {
      // The property that makes the alias safe to add: it inherits every guarantee of `findAll`,
      // including the one that matters most.
      const spy = jest.spyOn(TenantCampaign, 'findAll').mockResolvedValue([]);

      await expect(repository.listAll(TenantCampaign)).rejects.toThrow(MissingScopeContextError);
      expect(spy).not.toHaveBeenCalled();
    });

    it('a denied model yields a clause matching nothing, not an error', async () => {
      // `VersionBlast` is `deny()` for every role below super_admin (scope-strategy.ts). A list
      // read must look like an empty result, never like a refusal that confirms the table exists
      // (02-SECURITY.md §5.1).
      const spy = jest.spyOn(VersionBlast, 'findAll').mockResolvedValue([]);

      await ScopeContext.run(merchantUser, () => repository.listAll(VersionBlast));

      expect(JSON.stringify((spy.mock.calls[0][0] as Captured).where)).toContain('1 = 0');
    });
  });
});
