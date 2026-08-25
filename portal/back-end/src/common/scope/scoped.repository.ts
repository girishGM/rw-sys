/**
 * T-013 — the only sanctioned path from application code to a `reward_config` /
 * `reward_portal` table.
 *
 * ### The one property this class exists to guarantee
 *
 * > Every query it issues carries the actor's scope **in its WHERE clause**, and it issues no
 * > query at all when it does not know who the actor is.
 *
 * Everything else here is machinery in service of that sentence. Three consequences are worth
 * stating explicitly because each is a class of bug this design removes rather than mitigates:
 *
 * 1. **A cross-tenant id is unreachable, not rejected** (02-SECURITY.md §5.1). `findByPk` on
 *    another tenant's campaign produces `… WHERE id = 42 AND tenant_id = 7` and returns `null`.
 *    There is no branch that loads the row and compares — so there is no 403, no differing
 *    latency, and no error message shaped differently from "not found" (TC-5, TC-11).
 * 2. **`LIMIT`, `OFFSET` and `COUNT` are computed over the actor's rows only.** A post-fetch
 *    filter gets the *page* wrong even when it gets the *rows* right, which is how "page 3 is
 *    empty for tenant A because tenant B has more campaigns" becomes an information leak
 *    (TC-6).
 * 3. **A write cannot escape the scope.** `create` overwrites the scope columns from the
 *    context, and `update` refuses to change them, so neither a DTO field nor a hand-crafted
 *    body can move a row into — or out of — another tenant (TC-14).
 *
 * ### Why the subquery clauses use `literal()` + `replacements`
 *
 * `country_admin` scope on a table with no `country_id` needs `tenant_id IN (SELECT id FROM
 * tenants WHERE country_id = …)`. Sequelize has no first-class operator for a correlated
 * subquery, so the fragment is a `literal()`. Two things make that safe, and both are
 * deliberate:
 *
 *  - the SQL text is a compile-time constant of `scope-strategy.ts` — no part of it comes from
 *    a request;
 *  - the *value* is never in the text. It is bound through `options.replacements`, which
 *    Sequelize escapes, and which **throws** (`Named replacement ":rsScope0" has no entry in
 *    the replacement map`) if the binding is ever lost. That failure mode is the reason this
 *    is preferable to interpolating a validated integer: a refactor that drops the binding
 *    produces a hard error rather than a query that quietly stops being scoped.
 *
 * `scope-strategy.ts` additionally asserts every scope value is a safe integer before it is
 * bound, so the escaping is a second line of defence rather than the only one.
 *
 * ### Why the raw model statics below do not violate R2
 *
 * They are the implementation of R2. `src/common/scope/` is one of the two directories the
 * `no-raw-model-access` lint rule exempts (the other is `src/database/`), precisely so that
 * exactly one file in the application can call `model.findAll` and every reviewer knows which
 * one it is.
 */
import { Injectable, Logger } from '@nestjs/common';
import {
  Op,
  type Attributes,
  type CountOptions,
  type CreateOptions,
  type CreationAttributes,
  type DestroyOptions,
  type FindOptions,
  type Identifier,
  type Model,
  type ModelStatic,
  type UpdateOptions,
  type WhereOptions,
} from 'sequelize';
import { ScopeContext, type RequestScope } from './scope-context';
import { buildScopeWhere, forcedWriteValues, isDenied } from './scope-strategy';
import { ScopeViolationError } from './scope.exceptions';

/**
 * Sequelize accepts `replacements` on every query option object at runtime but does not declare
 * it on the typed `FindOptions`/`UpdateOptions` shapes. Declaring the intersection here keeps
 * the code free of `any` (R8) while being honest that the property is passed through.
 */
type WithReplacements<T> = T & { replacements?: Record<string, unknown> };

/** Reserved replacement-name prefix. A caller may not use it — see {@link mergeReplacements}. */
const SCOPE_REPLACEMENT_PREFIX = 'rsScope';

@Injectable()
export class ScopedRepository {
  private readonly logger = new Logger(ScopedRepository.name);

  /**
   * The actor's scope, or a hard failure.
   *
   * Every public method below starts here, and none of them has a branch that proceeds without
   * it. That is T-013 implementation note 2 in code: *"a missing context is a programming error
   * and must fail loudly (500), because the alternative is silently returning every tenant's
   * rows"* (TC-13).
   */
  private scope(operation: string): RequestScope {
    return ScopeContext.require(operation);
  }

  async findAll<M extends Model>(
    model: ModelStatic<M>,
    options: FindOptions<Attributes<M>> = {},
  ): Promise<M[]> {
    return model.findAll(this.scoped(model, 'findAll', options));
  }

  /**
   * {@link findAll}, under a name that a Sequelize model does not have. **This is the method a
   * service in `src/modules/` calls.** Added by T-015; see below for why it exists at all.
   *
   * ### The problem it solves
   *
   * The `no-raw-model-access` rule this class exists to serve bans the *property name*
   * `findAll` on **any** receiver, and `no-raw-model-access.spec.ts` asserts that breadth
   * deliberately (*"catches the finder methods on a non-class receiver too — the shape somebody
   * reaches for when a lint rule appears to only look at capitalised identifiers"*). That is the
   * right call for `this.model.findAll()`. Its unintended consequence is that
   * `this.scoped.findAll()` — the one call R2 actually *mandates* — is unlintable too, so no
   * service outside the three exempt directories could perform a scoped list read at all. T-015
   * is the first `src/modules/` consumer of this class and the first to hit it.
   *
   * ### Why an alias rather than an exemption, and why this weakens nothing
   *
   * The alternatives were to exempt a feature directory from the rule (a hole any future code in
   * that directory inherits), to narrow the selector (which would delete an assertion T-013's own
   * spec makes), or to write `eslint-disable` (forbidden by R2 in the same sentence that demands
   * the rule). This is none of those: the rule is untouched, and **the set of raw-model calls it
   * catches is unchanged**, because `listAll` is not part of Sequelize's `Model` static API.
   * `Campaign.listAll()` is a *compile error*, not an unlinted bypass — so the guarantee is
   * enforced by the type checker exactly where lint no longer has to be.
   *
   * The same property is already true of `findByPkOrFail` and `findOneOrFail` below, whose names
   * likewise exist only on this class.
   *
   * Escalated in the T-015 completion report: a type-aware rule (`callee.object` is a
   * `ScopedRepository`) would let every consumer use the natural name, and is an architect
   * decision rather than one this task should take on another task's security control.
   */
  async listAll<M extends Model>(
    model: ModelStatic<M>,
    options: FindOptions<Attributes<M>> = {},
  ): Promise<M[]> {
    return this.findAll(model, options);
  }

  async findOne<M extends Model>(
    model: ModelStatic<M>,
    options: FindOptions<Attributes<M>> = {},
  ): Promise<M | null> {
    return model.findOne(this.scoped(model, 'findOne', options));
  }

  /**
   * Primary-key lookup, scoped.
   *
   * Expressed as a `findOne` with an `id` predicate rather than by calling `model.findByPk`,
   * because `findByPk` in Sequelize *replaces* `options.where` with the primary key — silently
   * discarding the scope clause. That is the single most dangerous method in the ORM for this
   * codebase, and routing it through `findOne` is what makes it safe here.
   */
  async findByPk<M extends Model>(
    model: ModelStatic<M>,
    id: Identifier,
    options: FindOptions<Attributes<M>> = {},
  ): Promise<M | null> {
    const byPk = { [model.primaryKeyAttribute]: id } as WhereOptions<Attributes<M>>;
    return this.findOne(model, { ...options, where: mergeWhere(byPk, options.where) });
  }

  /**
   * {@link findByPk}, but 404 rather than `null` when the row is absent **or out of scope** —
   * the two are indistinguishable by construction (02-SECURITY.md §5.1, TC-5/TC-9/TC-11).
   *
   * Provided here so that Wave 3 does not each write its own `if (row === null) throw` and get
   * the status code wrong once. A 403 in this position would confirm the record exists.
   */
  async findByPkOrFail<M extends Model>(
    model: ModelStatic<M>,
    id: Identifier,
    options: FindOptions<Attributes<M>> = {},
  ): Promise<M> {
    const row = await this.findByPk(model, id, options);
    if (row === null) throw new ScopeViolationError();
    return row;
  }

  /** {@link findOne} with the same 404-on-absent contract as {@link findByPkOrFail}. */
  async findOneOrFail<M extends Model>(
    model: ModelStatic<M>,
    options: FindOptions<Attributes<M>> = {},
  ): Promise<M> {
    const row = await this.findOne(model, options);
    if (row === null) throw new ScopeViolationError();
    return row;
  }

  /**
   * Scoped `COUNT`.
   *
   * Sequelize's `count` returns `number` only when `options.group` is absent; grouped counts
   * return an array. Grouped counting is not offered here rather than typed around — a caller
   * that needs it should add it deliberately, with its own test, rather than inherit a
   * surprising return type from a security-critical class.
   */
  async count<M extends Model>(
    model: ModelStatic<M>,
    options: Omit<CountOptions<Attributes<M>>, 'group'> = {},
  ): Promise<number> {
    return model.count(this.scoped(model, 'count', options));
  }

  /**
   * Scoped INSERT.
   *
   * The scope columns are written **last**, over whatever the caller supplied. That ordering is
   * TC-14: a tenant-7 maker POSTing `{"tenantId": 999}` gets `tenant_id = 7`, whether or not
   * `forbidNonWhitelisted` rejected the field first. Two independent controls, as
   * 02-SECURITY.md §5 asks for.
   */
  async create<M extends Model>(
    model: ModelStatic<M>,
    values: CreationAttributes<M>,
    options: CreateOptions<Attributes<M>> = {},
  ): Promise<M> {
    const scope = this.scope(`create(${model.name})`);

    // Unlike a read or an update, an INSERT has no WHERE clause for the scope to constrain. A
    // model this role may not reach therefore has to be refused outright; writing the row and
    // being unable to read it back would be worse than either alternative.
    if (isDenied(model, scope)) {
      this.logger.warn(`Refusing ${scope.role} create on ${model.name}: denied by scope strategy`);
      throw new ScopeViolationError();
    }

    const forced = forcedWriteValues(model, scope);
    return model.create({ ...values, ...forced } as CreationAttributes<M>, options);
  }

  /**
   * Scoped UPDATE. Returns the number of rows actually changed.
   *
   * Two guarantees beyond the WHERE clause:
   *
   *  - `where` is **required**. Sequelize would happily update every row of a table for a
   *    `super_admin`, whose scope clause is empty by design; requiring the caller to say which
   *    rows they mean removes that possibility from the API rather than from convention.
   *  - the scope columns are stripped from `values`. Without that, an in-scope row could be
   *    *moved* out of scope — a write that passes every read test and loses the row forever.
   *
   * A returned `0` is how "the row belongs to another tenant" surfaces (TC-7): the row is not
   * matched, so it is not modified, and the caller answers 404.
   */
  async update<M extends Model>(
    model: ModelStatic<M>,
    values: Partial<Attributes<M>>,
    options: UpdateOptions<Attributes<M>>,
  ): Promise<number> {
    const scope = this.scope(`update(${model.name})`);
    requireWhere(model, 'update', options.where);

    const safeValues = { ...values };
    for (const attribute of Object.keys(forcedWriteValues(model, scope))) {
      delete safeValues[attribute as keyof Attributes<M>];
    }

    const [affected] = await model.update(safeValues, this.scoped(model, 'update', options));
    return affected;
  }

  /**
   * Scoped DELETE (soft, on every paranoid model — the portal soft-deletes, 01-DATABASE.md §3).
   *
   * `where` is required for the same reason as in {@link update}.
   */
  async destroy<M extends Model>(
    model: ModelStatic<M>,
    options: DestroyOptions<Attributes<M>>,
  ): Promise<number> {
    this.scope(`destroy(${model.name})`);
    requireWhere(model, 'destroy', options.where);
    return model.destroy(this.scoped(model, 'destroy', options));
  }

  /**
   * The single place scope is applied. Every read/write path above funnels through it, so
   * "did this method remember to scope?" is not a question that can be asked of any of them.
   */
  private scoped<M extends Model, O extends { where?: WhereOptions<Attributes<M>> }>(
    model: ModelStatic<M>,
    operation: string,
    options: O,
  ): O {
    const scope = this.scope(`${operation}(${model.name})`);
    const compiled = buildScopeWhere(model, scope);

    return {
      ...options,
      where: mergeWhere(compiled.where, options.where),
      replacements: mergeReplacements(
        (options as WithReplacements<O>).replacements,
        compiled.replacements,
      ),
    } as O;
  }
}

// --- helpers -----------------------------------------------------------------------------

/**
 * Conjoins the scope clause and the caller's clause.
 *
 * `Op.and` rather than a shallow object merge: `{ ...caller, ...scope }` would let a caller's
 * `tenantId` key be overwritten by the scope's — fine — but a *scope* key be overwritten by the
 * caller's whenever the spread order was ever flipped by a well-meaning refactor. An explicit
 * AND cannot be reordered into a bypass.
 */
export function mergeWhere<T>(
  scopeWhere: WhereOptions<T> | null | undefined,
  callerWhere: WhereOptions<T> | undefined,
): WhereOptions<T> | undefined {
  if (scopeWhere === null || scopeWhere === undefined) return callerWhere;
  if (callerWhere === undefined) return scopeWhere;
  return { [Op.and]: [callerWhere, scopeWhere] } as WhereOptions<T>;
}

/**
 * Merges the scope's bound values into the caller's, refusing a collision.
 *
 * A caller using a `rsScope…` name of its own would silently rebind a scope predicate to a
 * value it chose — the one way the `replacements` mechanism could be turned against the thing
 * it protects. Reserving the prefix costs nothing and closes it.
 */
export function mergeReplacements(
  callerReplacements: Record<string, unknown> | undefined,
  scopeReplacements: Readonly<Record<string, number>>,
): Record<string, unknown> | undefined {
  const scopeNames = Object.keys(scopeReplacements);
  if (callerReplacements === undefined) {
    return scopeNames.length === 0 ? undefined : { ...scopeReplacements };
  }

  for (const name of Object.keys(callerReplacements)) {
    if (name.startsWith(SCOPE_REPLACEMENT_PREFIX)) {
      throw new Error(
        `Replacement name "${name}" is reserved for tenancy scoping and may not be supplied ` +
          'by a caller.',
      );
    }
  }

  return { ...callerReplacements, ...scopeReplacements };
}

/**
 * Refuses a write with no `where`.
 *
 * Sequelize treats a missing `where` on `update`/`destroy` as "every row". For a `super_admin`,
 * whose scope clause is intentionally empty, that is a whole-table write one forgotten argument
 * away. Making it a thrown error rather than a lint rule means it cannot be forgotten.
 */
function requireWhere<M extends Model>(
  model: ModelStatic<M>,
  operation: string,
  where: WhereOptions<Attributes<M>> | undefined,
): void {
  // `Reflect.ownKeys`, not `Object.keys`: a clause built from `Op.and` / `Op.or` has only
  // symbol keys, and `Object.keys` would report it as empty and reject a perfectly valid write.
  if (where === undefined || (typeof where === 'object' && Reflect.ownKeys(where).length === 0)) {
    throw new Error(
      `ScopedRepository.${operation}(${model.name}) requires an explicit \`where\`; ` +
        'an unbounded write is never issued.',
    );
  }
}
