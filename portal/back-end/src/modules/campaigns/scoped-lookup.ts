/**
 * T-037 — "the scoped row, or `null`", expressed with a method name the R2 lint rule allows.
 *
 * ### Why this exists
 *
 * `ScopedRepository` offers `findOne`/`findByPk` (returning `null`) and
 * `findOneOrFail`/`findByPkOrFail` (throwing a 404). This module needs the **first** shape in
 * several places — an unassigned rule must become a 400 `RULE_NOT_ASSIGNED_TO_COUNTRY`, not a 404
 * (TC-15, see `campaigns.errors.ts`'s header) — but `no-raw-model-access` bans the *property
 * names* `findOne` and `findByPk` on **any** receiver:
 *
 * ```js
 * selector: 'CallExpression[callee.property.name=/^(findAll|findOne|findByPk|…)$/]'
 * ```
 *
 * That breadth is deliberate and correct (`no-raw-model-access.spec.ts` asserts it catches a
 * non-class receiver too), and R2 forbids disabling the rule to make a task's own code pass. The
 * same collision is already documented in `ScopedRepository` itself, which added `listAll` as the
 * lint-safe alias for `findAll` *"rather than an exemption … the rule is untouched, and the set
 * of raw-model calls it catches is unchanged"*.
 *
 * These two helpers are the same move for the nullable single-row reads, and they weaken nothing:
 * both go through `ScopedRepository.listAll`, so the actor's scope clause is in the WHERE of
 * every query they issue, exactly as it would have been through `findOne`. `LIMIT 1` is applied
 * inside the scoped query, not by taking the first element of an unbounded read.
 */
import type { Attributes, FindOptions, Model, ModelStatic } from 'sequelize';
import type { ScopedRepository } from '@/common/scope/scoped.repository';

/** The first scoped row matching `options`, or `null`. */
export async function firstOrNull<M extends Model>(
  scoped: ScopedRepository,
  model: ModelStatic<M>,
  options: FindOptions<Attributes<M>> = {},
): Promise<M | null> {
  const rows = await scoped.listAll(model, { ...options, limit: 1 });
  return rows[0] ?? null;
}

/** The scoped row with this primary key, or `null`. The nullable counterpart of
 * `ScopedRepository.findByPkOrFail`. */
export async function byIdOrNull<M extends Model>(
  scoped: ScopedRepository,
  model: ModelStatic<M>,
  id: number,
  options: FindOptions<Attributes<M>> = {},
): Promise<M | null> {
  const where = { [model.primaryKeyAttribute]: id } as Attributes<M>;
  return firstOrNull(scoped, model, {
    ...options,
    where: { ...(options.where as object), ...where } as FindOptions<Attributes<M>>['where'],
  });
}
