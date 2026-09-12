/**
 * T-RAP-064 (Phase 2). `resolver_code -> RuleResolver`, mirroring the shape of the portal's own
 * `rule_resolvers` registry table (diagnosis doc §3) so a future second resolver type is a new
 * file plus one entry in `DEFAULT_RESOLVERS` below — never a change to
 * `rule-evaluator.service.ts`'s own dispatch logic, which only ever calls
 * `findResolverForClause()` (implementation note 1 of this task's own file).
 */
import type { RuleResolver } from './rule-resolver.interface';
import { ScheduleContextResolver } from './schedule-context.resolver';

const DEFAULT_RESOLVERS: readonly RuleResolver[] = Object.freeze([new ScheduleContextResolver()]);

export class ResolverRegistry {
  private readonly resolvers: readonly RuleResolver[];

  constructor(resolvers: readonly RuleResolver[] = DEFAULT_RESOLVERS) {
    this.resolvers = resolvers;
  }

  /** The first registered resolver whose `canHandle()` recognizes `clause`, or `undefined` when
   * none do — `rule-evaluator.service.ts` falls through to its own pre-existing
   * placeholder-substitution/condition-parsing path (`T-RAP-063`) in that case, exactly as before
   * this task. */
  findResolverForClause(clause: string): RuleResolver | undefined {
    return this.resolvers.find((resolver) => resolver.canHandle(clause));
  }

  /** Looked up by `resolverCode` (e.g. `"SCHEDULE_CONTEXT"`) — not exercised by
   * `rule-evaluator.service.ts` today (clause-shape dispatch is what's wired in, per
   * `rule-resolver.interface.ts`'s own header on why `resolver_id` isn't available yet), but kept
   * as part of this registry's own public surface since the follow-up defect that eventually
   * plumbs `BoundRule.resolverId`/`resolverConfig` through will need exactly this lookup. */
  byCode(resolverCode: string): RuleResolver | undefined {
    return this.resolvers.find((resolver) => resolver.resolverCode === resolverCode);
  }
}

/** Shared, stateless default instance — every resolver in `DEFAULT_RESOLVERS` is itself pure, so
 * one process-wide instance is safe to reuse across every `RuleEvaluatorService` evaluation. */
export const defaultResolverRegistry = new ResolverRegistry();
