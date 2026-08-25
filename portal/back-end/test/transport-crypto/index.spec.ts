/**
 * T-018 — the `@/common/transport-crypto` barrel.
 *
 * Two properties, both of which have bitten this repository before:
 *
 *  1. **It is importable from a unit test.** `@/common/crypto`'s barrel documents the trap:
 *     re-exporting a module file pulls in `DatabaseModule` → `ConfigModule`, whose `validate`
 *     runs `validateEnv` at *import* time and calls `process.exit(1)` on an incomplete
 *     environment — killing the Jest worker with no failing test to point at. This spec importing
 *     cleanly is the assertion that neither module has crept into the barrel.
 *  2. **Every consumer-facing symbol is actually exported.** T-022 imports from here.
 */
import * as barrel from '@/common/transport-crypto';

describe('the transport-crypto barrel', () => {
  it('exports the surface T-011 and T-022 consume', () => {
    expect(typeof barrel.HandshakeService).toBe('function');
    expect(typeof barrel.PayloadDecryptInterceptor).toBe('function');
    expect(typeof barrel.PayloadEncryptInterceptor).toBe('function');
    expect(typeof barrel.TransportPolicyService).toBe('function');
    expect(typeof barrel.SessionTransportKeyRepository).toBe('function');
    expect(typeof barrel.PayloadDecryptFailedHttpException).toBe('function');
    expect(typeof barrel.TransportSessionInvalidHttpException).toBe('function');
    expect(typeof barrel.sealEnvelope).toBe('function');
    expect(typeof barrel.openEnvelope).toBe('function');
    expect(typeof barrel.isPayloadEnvelope).toBe('function');
    expect(typeof barrel.sessionKid).toBe('function');
    expect(typeof barrel.isAlwaysCleartext).toBe('function');
    expect(barrel.TRANSPORT_ENVELOPE_VERSION).toBe('v1');
  });

  it('does not re-export either module, so importing it cannot reach `process.exit`', () => {
    expect(barrel).not.toHaveProperty('TransportCryptoModule');
    expect(barrel).not.toHaveProperty('TransportHandshakeModule');
  });
});
