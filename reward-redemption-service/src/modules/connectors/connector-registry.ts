/**
 * T-RR-030. `ConnectorRegistry` — `Map<connector_type, RewardSystemConnector>`
 * (`08-EXTERNAL-INTEGRATION-CONTRACTS.md` §4), keyed by `connector_type`
 * (`external_reward_system_config.connector_type`), never by `system_code` (implementation note
 * 2) — two different `system_code` values that are both promo-code-style integrations share one
 * connector class and differ only in their own `external_reward_system_config` row.
 *
 * Starts empty at bootstrap (implementation note 3, TC-6) — T-RR-031/T-RR-032 both depend on this
 * task and haven't landed at the point this one runs, so this file has no forward dependency on
 * either connector's own module. Each of those tasks calls `register()` from its own module's
 * `onModuleInit` (or equivalent) once it exists.
 */
import { Injectable } from '@nestjs/common';
import type { RewardSystemConnector } from './reward-system-connector.interface';

/** Thrown when `resolve()` is asked for a `connector_type` no connector class has registered — a
 * data/config error (`external_reward_system_config.connector_type` names a type nothing
 * implements), never silently surfaced as `undefined` (implementation note 5). Distinct from "no
 * connector needed at all" (`05-PROCESSING-PIPELINE.md` §2's direct `→ completed` path), which
 * T-RR-023's resolution step already handles before ever calling into this registry — that path
 * never calls `resolve()` at all. */
export class UnknownConnectorTypeError extends Error {
  constructor(public readonly connectorType: string) {
    super(`No connector registered for connector_type="${connectorType}"`);
    this.name = 'UnknownConnectorTypeError';
  }
}

@Injectable()
export class ConnectorRegistry {
  private readonly connectors = new Map<string, RewardSystemConnector>();

  /**
   * Registers `connector` under `connectorType`. Registering the same `connectorType` twice
   * **replaces** the previous entry (TC-4) — deliberate, not accidental: this keeps `register()`
   * idempotent under a re-run `onModuleInit` (e.g. a test harness rebuilding the module tree)
   * rather than forcing every caller to guard against a "already registered" throw for a
   * situation that is not itself an error.
   */
  register(connectorType: string, connector: RewardSystemConnector): void {
    this.connectors.set(connectorType, connector);
  }

  /**
   * Resolves the connector registered for `connectorType`. Lookup is case-sensitive — a
   * `connector_type` value must match exactly as stored (TC-7); `'promo_code_service'` and
   * `'PROMO_CODE_SERVICE'` are different keys, never coalesced.
   *
   * @throws UnknownConnectorTypeError if no connector is registered for `connectorType` (TC-2,
   *   TC-6) — never returns `undefined`.
   */
  resolve(connectorType: string): RewardSystemConnector {
    const connector = this.connectors.get(connectorType);
    if (!connector) {
      throw new UnknownConnectorTypeError(connectorType);
    }
    return connector;
  }
}
