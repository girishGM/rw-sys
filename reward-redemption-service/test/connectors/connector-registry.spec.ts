/**
 * T-RR-030 — `ConnectorRegistry` (`08-EXTERNAL-INTEGRATION-CONTRACTS.md` §4). TC-1…TC-7 exactly as
 * the task file specifies; TC-5 is a compile-time-only check (no runtime assertion can catch it),
 * asserted via `@ts-expect-error` and confirmed by `npm run typecheck` (verification step 2).
 */
import type {
  ClaimedRewardEntry,
  ExternalRewardSystemConfig,
  RedemptionResult,
  RewardSystemConnector,
} from '@/modules/connectors/reward-system-connector.interface';
import {
  ConnectorRegistry,
  UnknownConnectorTypeError,
} from '@/modules/connectors/connector-registry';

function buildConnector(outcome: RedemptionResult): RewardSystemConnector {
  return {
    redeem: async (_entry: ClaimedRewardEntry, _config: ExternalRewardSystemConfig) => outcome,
  };
}

const SUCCESS_RESULT: RedemptionResult = {
  outcome: 'SUCCESS',
  externalReferenceId: 'ext-ref-1',
  responseSummary: {},
};

describe('T-RR-030 — ConnectorRegistry', () => {
  let registry: ConnectorRegistry;

  beforeEach(() => {
    registry = new ConnectorRegistry();
  });

  // TC-6.
  it('TC-6: resolve() on an empty registry (before any register() call) throws UnknownConnectorTypeError, not an unhandled crash', () => {
    expect(() => registry.resolve('PROMO_CODE_SERVICE')).toThrow(UnknownConnectorTypeError);
  });

  // TC-1.
  it('TC-1: registers a connector under PROMO_CODE_SERVICE and resolves the same instance back', () => {
    const connector = buildConnector(SUCCESS_RESULT);
    registry.register('PROMO_CODE_SERVICE', connector);
    expect(registry.resolve('PROMO_CODE_SERVICE')).toBe(connector);
  });

  // TC-2.
  it('TC-2: resolving an unregistered connector_type throws UnknownConnectorTypeError, never returns undefined', () => {
    registry.register('PROMO_CODE_SERVICE', buildConnector(SUCCESS_RESULT));
    let thrown: unknown;
    try {
      registry.resolve('CORE_BANKING');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(UnknownConnectorTypeError);
    expect(thrown).not.toBeUndefined();
  });

  // TC-3.
  it('TC-3: registers two different connector types, both resolvable independently with no cross-contamination', () => {
    const promoConnector = buildConnector(SUCCESS_RESULT);
    const coreBankingConnector = buildConnector({
      outcome: 'PERMANENT_FAILURE',
      errorCode: null,
      errorMessage: 'stub',
    });
    registry.register('PROMO_CODE_SERVICE', promoConnector);
    registry.register('CORE_BANKING', coreBankingConnector);

    expect(registry.resolve('PROMO_CODE_SERVICE')).toBe(promoConnector);
    expect(registry.resolve('CORE_BANKING')).toBe(coreBankingConnector);
    expect(registry.resolve('PROMO_CODE_SERVICE')).not.toBe(coreBankingConnector);
  });

  // TC-4: registering the same connector_type twice deterministically replaces the first entry.
  it('TC-4: registering the same connector_type twice replaces the first registration', () => {
    const first = buildConnector(SUCCESS_RESULT);
    const second = buildConnector(SUCCESS_RESULT);
    registry.register('PROMO_CODE_SERVICE', first);
    registry.register('PROMO_CODE_SERVICE', second);

    expect(registry.resolve('PROMO_CODE_SERVICE')).toBe(second);
    expect(registry.resolve('PROMO_CODE_SERVICE')).not.toBe(first);
  });

  // TC-7.
  it('TC-7: connector_type lookup is case-sensitive — no accidental match on differing case', () => {
    registry.register('PROMO_CODE_SERVICE', buildConnector(SUCCESS_RESULT));
    expect(() => registry.resolve('promo_code_service')).toThrow(UnknownConnectorTypeError);
  });

  // TC-5 (type-level, no runtime assertion possible).
  it('TC-5: a SUCCESS RedemptionResult constructed without externalReferenceId fails to compile', () => {
    function buildInvalidSuccessResult(): RedemptionResult {
      // @ts-expect-error TC-5: `externalReferenceId` is required on the SUCCESS variant
      // (`08-EXTERNAL-INTEGRATION-CONTRACTS.md` §1) — this line must remain a compile error. If
      // this directive ever becomes unused, `npm run typecheck` fails with "Unused
      // '@ts-expect-error' directive", which is exactly the signal that this guarantee broke.
      return { outcome: 'SUCCESS', responseSummary: {} };
    }
    expect(typeof buildInvalidSuccessResult).toBe('function');
  });
});
