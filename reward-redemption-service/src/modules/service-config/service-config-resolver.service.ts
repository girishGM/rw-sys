/**
 * T-RR-006. `ServiceConfigResolverService` — the general-purpose scoped-configuration reader every
 * later task's "configurable knob" (cache TTLs, claim-worker poll interval, claim batch size,
 * default max retry attempts, advisory-lock wait timeout, outbox poll interval,
 * `completionSweep.intervalSeconds`/`graceSeconds`) reads through (`01-DATABASE.md` §6).
 *
 * A direct port of RAP's own proven `ServiceConfigResolverService` pattern
 * (`realtime-activity-processing-service/src/modules/service-config/service-config-resolver.service.ts`,
 * confirmed by direct read) — same first-match-wins precedence walk (`CAMPAIGN` → `TENANT` →
 * `COUNTRY` → `GLOBAL`) and the same "throw on an unconfigured key, never silently return
 * `undefined`" discipline. Two things deliberately differ from RAP's own version, both because
 * this plan's own `01-DATABASE.md` §6 DDL differs from RAP's `01-DATABASE.md` §11:
 *
 *   1. Scope-level vocabulary is upper-case (`'CAMPAIGN' | 'TENANT' | 'COUNTRY' | 'GLOBAL'`), not
 *      RAP's lower-case `'campaign' | 'tenant' | ...`, and every scope ref — including the tenant
 *      one — is a `*_code` string (R5: reference another service's entity by code value only,
 *      never an internal id), not RAP's own numeric `tenantId`.
 *   2. This module owns no in-memory cache (implementation note 5) — RAP's resolver rebuilds a
 *      full in-memory rule map via its own `refresh()`/`onModuleInit()` hook; this resolver hits
 *      `service_config` directly on every call instead, via `ServiceConfigRepository`'s own
 *      single-round-trip `ORDER BY CASE ... LIMIT 1` query. `06-CACHING-AND-TENANT-CONFIG.md` §1
 *      is explicit that the `serviceConfig` cache wraps *this* resolver in T-RR-007, not this
 *      task — keeping "correctness of resolution" and "performance of repeated resolution" as two
 *      separately testable concerns.
 *
 * `value_type` coercion (`'string' | 'int' | 'boolean' | 'json'`) is explicit and total
 * (implementation note 3): every branch either returns a correctly-typed value or throws a named
 * error, never a silent fallback (`0`, `false`, `undefined`) that would hide a real data/config
 * error in a lower environment until it surfaces as a silent behaviour change in production.
 */
import { Injectable } from '@nestjs/common';
import type {
  ServiceConfigRow,
  ServiceConfigValueType,
} from '@/database/models/service-config.model';
import {
  ServiceConfigRepository,
  type ServiceConfigScopeContext,
} from './service-config.repository';

export type { ServiceConfigScopeContext };

function describeRow(row: ServiceConfigRow): string {
  return `service_config row id=${row.id} (config_key="${row.config_key}", scope_level="${row.scope_level}", scope_ref=${row.scope_ref === null ? 'NULL' : `"${row.scope_ref}"`})`;
}

/** TC-4. Thrown instead of returning `undefined`/a hardcoded fallback when a `configKey` has no
 * row at any scope, including no `GLOBAL` row — a missing `GLOBAL` seed row for some knob must be
 * caught immediately in a lower environment, not silently swallowed. */
export class ServiceConfigNotFoundError extends Error {
  constructor(configKey: string) {
    super(
      `Unconfigured service_config key "${configKey}": no row matched at any scope ` +
        '(CAMPAIGN, TENANT, COUNTRY or GLOBAL) for the given context.',
    );
    this.name = 'ServiceConfigNotFoundError';
  }
}

/** TC-5/TC-6. Thrown when a stored `config_value` cannot be coerced to its own row's declared
 * `value_type` (a malformed boolean/int/json literal), or when a caller's requested type doesn't
 * match what the row itself declares — either way, a data/caller error surfaced loudly rather than
 * silently coerced (implementation note 3; R2's "no `any`" is protecting against exactly this). */
export class ServiceConfigTypeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceConfigTypeError';
  }
}

function coerceValue(row: ServiceConfigRow): string | number | boolean | unknown {
  switch (row.value_type) {
    case 'string':
      return row.config_value;
    case 'int': {
      const parsed = Number.parseInt(row.config_value, 10);
      if (Number.isNaN(parsed)) {
        throw new ServiceConfigTypeError(
          `Invalid service_config value: expected an integer, got ${JSON.stringify(row.config_value)} (${describeRow(row)}).`,
        );
      }
      return parsed;
    }
    case 'boolean': {
      if (row.config_value === 'true') {
        return true;
      }
      if (row.config_value === 'false') {
        return false;
      }
      throw new ServiceConfigTypeError(
        `Invalid service_config value: expected "true" or "false", got ${JSON.stringify(row.config_value)} (${describeRow(row)}).`,
      );
    }
    case 'json':
      // Deliberately uncaught: a malformed `config_value` is an operator data error worth
      // surfacing loudly via JSON.parse's own SyntaxError (TC-6), never a silent default.
      return JSON.parse(row.config_value) as unknown;
    default: {
      // Exhaustiveness guard — `value_type` is a closed union at the type level; this branch can
      // only run if the DB itself holds a value outside that union (R2: no `any`, no silent cast).
      const exhaustiveCheck: never = row.value_type;
      throw new ServiceConfigTypeError(
        `Unknown service_config value_type "${String(exhaustiveCheck)}" (${describeRow(row)}).`,
      );
    }
  }
}

@Injectable()
export class ServiceConfigResolverService {
  constructor(private readonly repository: ServiceConfigRepository) {}

  /**
   * Resolves `configKey` against `context`, returning the correctly-typed value the caller
   * declares it expects (implementation note 4: an overloaded signature keyed on the
   * caller-supplied `expectedType`, so a caller asking for a `boolean` gets a `boolean` back at
   * the type level — never `unknown`/`any` requiring an unchecked cast at the call site).
   *
   * `expectedType` is also asserted against the resolved row's own stored `value_type`: without
   * that check, a caller declaring `'int'` against a row actually stored as `'string'` would get
   * back a string at runtime while TypeScript's own overload resolution insists it's a `number` —
   * exactly the silent-mismatch bug class R2 exists to prevent. A mismatch throws
   * `ServiceConfigTypeError` rather than silently trusting either side.
   */
  resolve(
    configKey: string,
    expectedType: 'string',
    context?: ServiceConfigScopeContext,
  ): Promise<string>;
  resolve(
    configKey: string,
    expectedType: 'int',
    context?: ServiceConfigScopeContext,
  ): Promise<number>;
  resolve(
    configKey: string,
    expectedType: 'boolean',
    context?: ServiceConfigScopeContext,
  ): Promise<boolean>;
  resolve(
    configKey: string,
    expectedType: 'json',
    context?: ServiceConfigScopeContext,
  ): Promise<unknown>;
  async resolve(
    configKey: string,
    expectedType: ServiceConfigValueType,
    context: ServiceConfigScopeContext = {},
  ): Promise<string | number | boolean | unknown> {
    const row = await this.repository.findFirstMatch(configKey, context);
    if (row === null) {
      throw new ServiceConfigNotFoundError(configKey);
    }
    if (row.value_type !== expectedType) {
      throw new ServiceConfigTypeError(
        `service_config key "${configKey}" is stored as value_type="${row.value_type}" but was ` +
          `resolved as "${expectedType}" (${describeRow(row)}).`,
      );
    }
    return coerceValue(row);
  }
}
