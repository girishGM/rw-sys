/**
 * T-RAP-064 (Phase 2 of the rule-expression binding fix — see
 * `realtime-activity-processing-service-plan/brain-storm/T-RAP-063-rule-expression-binding-diagnosis.md`
 * for the full evidence base). One interface every rule resolver implements — the registry
 * (`resolver-registry.ts`) dispatches by asking each registered resolver whether it recognizes a
 * clause's own shape; `rule-evaluator.service.ts` never special-cases a specific resolver by name
 * (implementation note 1 of this task's own file).
 *
 * **Dispatch is by expression shape, not by `resolverId` — still true even now that
 * `resolverId`/`resolverConfig`/`defaultOperators`/`operator` (`T-175`) are on the wire.** This
 * task's own "Files owned" list named `campaign-config.client.ts` (the file that types
 * `BoundRuleProto`), but that file — and `proto/campaign_config.proto`, the physical wire schema
 * it loads — are `agent-rap-cache`'s exclusive scope per
 * `realtime-activity-processing-service-plan/project.config.json`, not `agent-rap-processing`'s
 * (this task's actual owner). Per this project's own established precedent for exactly this
 * situation (`T-RAP-062` → `T-RAP-065`), widening scope to edit another agent's files was not
 * done; instead a follow-up defect (`T-RAP-066`) was filed, and has since landed —
 * `BoundRuleProto` now carries all four fields (`campaign-config.client.ts:109-131`). **This
 * resolver mechanism still does not dispatch on `resolverId` even so**, for a reason independent
 * of file scope: `resolver_id` is an opaque numeric foreign key into the portal's own
 * `rule_resolvers` registry table, and that registry — the `resolver_id → resolver_code` mapping
 * itself — "is not served here" (`campaign_config.proto`'s own comment on the field). A bare `5`
 * on the wire is not actionable without also hardcoding a second, independent `id → code` table in
 * this codebase, which would be strictly worse than matching on the clause's own expression text:
 * a wrong/stale hardcoded id mapping fails silently (wrong resolver invoked), while a clause this
 * service doesn't recognize by shape safely falls through to Phase 1's own unresolved-placeholder
 * path. A resolver is matched purely by its own `canHandle()` reading the clause's raw
 * **expression text** (already on the wire, `BoundRule.expression`), and `ScheduleContextResolver`
 * (the one resolver this task ships) reads its window parameters from `rule.boundValuesJson`
 * (also already on the wire) rather than from `resolverConfig`. Nothing about this interface's own
 * shape blocks a future resolver from additionally consulting `resolverConfig`/`defaultOperators`
 * once a real second resolver type needs them — `resolverId` specifically is unlikely to ever be
 * useful for dispatch unless the portal starts serving the registry's own code alongside the id.
 */
import type { ActivityLogRow } from '@/database/models/activity-log.model';

export interface RuleResolverContext {
  /** The raw clause text — one `&&`-split segment of `rule.expression` — unsubstituted. Resolvers
   * decide for themselves what, if anything, they need to extract from it via their own
   * `canHandle`/`resolve`. */
  clause: string;
  /** `rule.boundValuesJson`, already parsed to a plain object (`{}` when absent/malformed) — the
   * exact same object `rule-evaluator.service.ts`'s own `:placeholder` substitution step
   * (`resolveClauseCondition`) reads for the non-resolver path. */
  boundValues: Readonly<Record<string, unknown>>;
  /** The claimed `activity_logs` row this rule is being evaluated against. */
  row: ActivityLogRow;
}

export interface RuleResolverOutcome {
  /** `false` when this resolver recognized the clause (its own `canHandle` returned `true`) but
   * could not produce a definitive answer for it today — e.g. an unsupported `windowType`, or a
   * malformed window bound. The caller (`rule-evaluator.service.ts`) treats this exactly like
   * Phase 1's (`T-RAP-063`) "unresolved placeholder" outcome: the rule evaluates as **not
   * passed**, a warning is logged naming the reason, and the claimed transaction never throws. */
  resolved: boolean;
  /** Only meaningful when `resolved` is `true`. */
  passed?: boolean;
  /** Human-readable reason. Always present when `resolved` is `false` — feeds the same warning
   * log / `activity_logs.comment` shape `rule-evaluator.service.ts` already uses for an
   * unresolved `:placeholder`. */
  reason?: string;
}

export interface RuleResolver {
  /** A stable identifier for this resolver, used for logging and for `ResolverRegistry#byCode`
   * only — mirrors the portal's own `rule_resolvers.resolver_code` naming convention
   * (`SCHEDULE_CONTEXT`) without depending on that value actually arriving over the wire (see
   * this file's own header on why). */
  readonly resolverCode: string;

  /** Whether this resolver recognizes `clause`'s own shape — pure, no side effect. Checked before
   * `resolve()`; a resolver whose `canHandle` returns `false` for a given clause is never asked
   * to `resolve()` that clause. */
  canHandle(clause: string): boolean;

  /** Produces a definitive outcome for a clause this resolver has already claimed via
   * `canHandle()`. Must never throw for a clause it cannot fully resolve — report
   * `{ resolved: false, reason }` instead (this file's own header, and `T-RAP-063`'s "never
   * poison the batch" discipline, both apply here unchanged). */
  resolve(context: RuleResolverContext): RuleResolverOutcome;
}
