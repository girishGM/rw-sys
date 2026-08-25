/**
 * T-018 — "should this request/response be encrypted, and if so how much of it?"
 * (07-DATA-PROTECTION.md §5, "Configurable levels").
 *
 * Three inputs, one answer:
 *
 *  1. the always-cleartext list — `/auth/login`, `/auth/refresh`, `/auth/forgot-password`,
 *     `/auth/reset-password`, `/health*` — which beats everything, because on those routes the
 *     session key does not exist yet and bootstrapping encryption from nothing is circular;
 *  2. `transport.routeOverrides` from `config/data-protection.json`;
 *  3. `transport.mode`, the global default.
 *
 * The route-override key is built with T-017's own `normaliseRouteOverrideKey`, imported rather
 * than reimplemented — that function's doc comment names this file as the reason it is exported.
 * A normalisation that lives in one place cannot disagree with itself, and §5's own example
 * writes `"GET  /health"` with two spaces, so this is not a theoretical concern.
 */
import { Inject, Injectable } from '@nestjs/common';
import {
  DATA_PROTECTION_CONFIG,
  normaliseRouteOverrideKey,
  type DataProtectionConfig,
  type TransportMode,
} from '@/common/data-protection/data-protection.config';
import { PolicyCacheService } from '@/common/data-protection/policy-cache.service';
import {
  isAlwaysCleartext,
  normalisePath,
  type TransportPolicyAdvertisement,
} from './transport-crypto.constants';

@Injectable()
export class TransportPolicyService {
  constructor(
    @Inject(DATA_PROTECTION_CONFIG) private readonly config: DataProtectionConfig,
    private readonly policies: PolicyCacheService,
  ) {}

  /**
   * The effective mode for one route.
   *
   * Note the order: the always-cleartext check runs **before** the override lookup, so no entry
   * in `config/data-protection.json` can switch encryption on for `/auth/login`. That is not
   * defensive tidying — `dto.LoginRequest.password` is seeded `in_transit = 'payload_encrypt'` by
   * T017_002, so a naive implementation really would try to encrypt the login body with a key
   * that does not exist yet. Flagged in the T-018 completion report as a genuine tension between
   * two design documents, resolved in favour of §5's explicit sentence.
   */
  modeFor(method: string, path: string): TransportMode {
    if (isAlwaysCleartext(path)) return 'off';

    const key = normaliseRouteOverrideKey(`${method} ${normalisePath(path)}`);
    return this.config.transport.routeOverrides[key] ?? this.config.transport.mode;
  }

  /** Whether a field name's policy says its value must be encrypted in transit. */
  isPayloadEncryptField(name: string): boolean {
    // The *safe* resolver: an unavailable policy cache yields `FAIL_CLOSED_POLICY`, whose
    // `inTransit` is `tls_only`. That is the right direction here and is not a masking bypass —
    // the response has already been through `ResponseMaskingInterceptor`, which masks everything
    // when the same cache is unavailable, so what would go unencrypted is a row of dots.
    return this.policies.resolveFieldNameSafe(name)?.inTransit === 'payload_encrypt';
  }

  /**
   * What the client is told after a successful handshake — see
   * {@link TransportPolicyAdvertisement}.
   *
   * The field list exists because `fields` mode is asymmetric: the **server** resolves every field
   * it actually receives against the policy cache and needs no list, but the **client** has no
   * policy table and cannot know which request fields to encrypt unless it is told. Nothing here
   * is secret — the modes and overrides are a committed config file, and the names are field names
   * already in the API contract. Values and key material never appear.
   */
  advertisement(): TransportPolicyAdvertisement {
    return {
      mode: this.config.transport.mode,
      routeOverrides: this.config.transport.routeOverrides,
      fields: this.policies.isLoaded ? this.policies.current().payloadEncryptFieldNames() : [],
    };
  }
}
