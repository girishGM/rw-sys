/**
 * T-017 — **TC-25 and verification step 4**, the two the task file calls decisive alongside
 * TC-12 and TC-21.
 *
 * > *"Feed `log-masking.serializer.ts` a sample log object containing every seeded PII value
 * > (built from the same fixtures TC-1…TC-24 use, not a live app) ⇒ **zero** unmasked hits in the
 * > serialised output."*
 *
 * ---
 *
 * ## Why this file exists separately, and what changed on 2026-08-18
 *
 * TC-25 originally asked for an end-to-end run against a live application logger, then a grep of
 * the resulting log **file**. No such logger exists: `main.ts`/`app.module.ts` never instantiate
 * one, and that bootstrap belongs to T-019 — which depends on *this* task being `done` first,
 * because piping real request logs through an unproven masking layer is not something to do in
 * that order. The architect re-scoped TC-25 and verification step 4 on 2026-08-18 to prove the
 * masking function itself, in isolation, against every seeded value. T-019 then repeats the check
 * end-to-end (its TC-17) once a transport actually exists.
 *
 * **That re-scoping moved *where* the guarantee is proven, not *how strong* it is**, so this file
 * is deliberately built to be un-cheatable in the three ways a test like this usually rots:
 *
 *  1. **It reads the real seed list.** The policy set comes from `SEEDED_POLICIES` in
 *     `T017_002_seed_policies.ts` — the exact rows the migration writes — not from a hand-kept
 *     copy that can drift from it.
 *  2. **It fails when a seed row is added without a sample value** (`every seeded pii/secret row
 *     has a fixture`). A future policy row for a new PII column cannot silently escape TC-25.
 *  3. **It proves the payload actually contains the plaintext before masking** (`the sample
 *     payload really does carry every plaintext`). Without that, a typo in the payload builder
 *     would make "no PII in the output" true and meaningless — the classic vacuous green.
 *
 * ## What "zero unmasked hits" is asserted to mean
 *
 * For an `omit` field: the whole value must be absent. For a `mask` field: the *sensitive* part
 * must be absent — the local part of an address, the middle of a name, every digit of a phone
 * number except the last four. The surviving fragments (`@example.com`, a first initial, `7788`)
 * are not oversights: 07-DATA-PROTECTION.md §7 chooses those strategies precisely so PII stays
 * *recognisable* in a trace, and `mask.strategies.ts` documents each one. Asserting their absence
 * would be asserting that the design is different from what it is. Every other character of every
 * seeded value is required to be gone.
 */
import {
  createLogMaskingSerialiser,
  SWEEP_REPLACEMENT_PREFIX,
  type SweepHit,
} from '@/common/data-protection/log-masking.serializer';
import { MASK_CHAR } from '@/common/data-protection/data-protection.constants';
import { aliasesFor, type DataProtectionPolicy } from '@/common/data-protection/policy.service';
import { SEEDED_POLICIES } from '@/database/migrations/T017_002_seed_policies';
import { policy, policySet } from './support/policies';

/**
 * The seeded rows, as the engine sees them.
 *
 * `SEEDED_POLICIES` is the migration's own array, so this cannot drift from what a real database
 * holds after `T017_002` runs. `T056_001` later flips `portal_users.email`'s `at_rest` to
 * `aes_256_gcm`; that column governs encryption, not logging, so it does not affect a single
 * assertion here — the log treatment (`mask`/`email`) is identical either way.
 */
const SEEDED_SET = policySet(
  SEEDED_POLICIES.map((row): DataProtectionPolicy =>
    policy({
      policyKey: row.policyKey,
      scope: row.scope,
      classification: row.classification,
      atRest: row.atRest ?? 'none',
      blindIndex: row.blindIndex ?? false,
      inTransit: row.inTransit ?? 'tls_only',
      logTreatment: row.logTreatment,
      maskStrategy: row.maskStrategy ?? null,
      uiVisibility: row.uiVisibility,
      revealRoles: row.revealRoles ?? null,
      keyPurpose: row.keyPurpose ?? null,
      note: row.note,
    }),
  ),
);

const sweepHits: SweepHit[] = [];
const serialise = createLogMaskingSerialiser({
  policies: SEEDED_SET,
  onSweepHit: (hit) => sweepHits.push(hit),
});

/**
 * One seeded field's sample value, and the substrings that must not survive.
 *
 * `forbidden` is written out per fixture rather than derived, so that reading this table tells you
 * exactly what is being claimed. Every entry is a distinctive token (`TC25…`) or a real local
 * part, chosen so that finding it in the output can only mean the value leaked — never a
 * coincidental match against a UUID or a timestamp.
 */
interface PiiFixture {
  readonly policyKey: string;
  readonly value: string;
  /**
   * Substrings of {@link value} itself. Each must be present in the payload *before* masking (the
   * vacuity check) and absent from it *after* (TC-25).
   */
  readonly forbidden: readonly string[];
  /**
   * Forms the value could take *after* a transformation, which therefore do not appear in the raw
   * payload and are exempt from the vacuity check — but must still not appear in the output.
   *
   * Exists for exactly one case: `maskPhone` strips punctuation before masking, so a leak of
   * `+60 12-345 7788` could surface as the bare digit run `6012345`, which the raw payload never
   * contains. Exempting it from the presence check is not a loosening — it is still asserted
   * absent from the output — but the exemption is narrow and named on purpose, because "the
   * needle wasn't in the input either" is precisely how this kind of test goes quietly vacuous.
   */
  readonly derivedForbidden?: readonly string[];
}

const PII_FIXTURES: readonly PiiFixture[] = [
  // --- reward_portal --------------------------------------------------------------------------
  {
    // Verification step 4's *"your own email"*. Masked to `g••••@gmail.com`.
    policyKey: 'reward_portal.portal_users.email',
    value: 'gm.mathpal@gmail.com',
    forbidden: ['gm.mathpal', 'm.mathpal', 'mathpal'],
  },
  {
    policyKey: 'reward_portal.portal_users.display_name',
    value: 'Gauri TC25NAME Mathpal',
    forbidden: ['TC25NAME', 'Gauri', 'Mathpal', 'auri TC25NAME Mathpa'],
  },
  {
    policyKey: 'reward_portal.portal_users.mfa_secret_enc',
    value: 'JBSWY3DPEHPK3PXP-TC25MFASEED',
    forbidden: ['TC25MFASEED', 'JBSWY3DPEHPK3PXP'],
  },
  {
    policyKey: 'reward_portal.portal_user_credentials.password_hash',
    value: '$argon2id$v=19$m=65536,t=3,p=4$TC25SALTVALUE$TC25DIGESTVALUE',
    forbidden: ['TC25SALTVALUE', 'TC25DIGESTVALUE', '$argon2id$'],
  },
  {
    policyKey: 'reward_portal.portal_sessions.transport_key_enc',
    value: 'TC25TRANSPORTKEYMATERIAL',
    forbidden: ['TC25TRANSPORTKEYMATERIAL'],
  },
  {
    policyKey: 'reward_portal.portal_refresh_tokens.token_hash',
    value: 'TC25REFRESHTOKENDIGEST',
    forbidden: ['TC25REFRESHTOKENDIGEST'],
  },
  {
    policyKey: 'reward_portal.portal_password_resets.token_hash',
    value: 'TC25RESETTOKENDIGEST',
    forbidden: ['TC25RESETTOKENDIGEST'],
  },
  {
    policyKey: 'reward_portal.portal_login_attempts.email',
    value: 'attacker.TC25LOGIN@example.org',
    forbidden: ['attacker.TC25LOGIN', 'TC25LOGIN'],
  },

  // --- reward_config --------------------------------------------------------------------------
  {
    policyKey: 'reward_config.merchants.contact_email',
    value: 'ops.TC25MERCHANT@merchant.example',
    forbidden: ['ops.TC25MERCHANT', 'TC25MERCHANT'],
  },
  {
    // `phone` keeps the last four digits only, and drops the country code with the punctuation.
    policyKey: 'reward_config.merchants.contact_phone',
    value: '+60 12-345 7788',
    forbidden: ['+60', '12-345', '+60 12-345 7788'],
    derivedForbidden: ['6012345'],
  },
  {
    policyKey: 'reward_config.tenants.contact_email',
    value: 'billing.TC25TENANT@tenant.example',
    forbidden: ['billing.TC25TENANT', 'TC25TENANT'],
  },
  {
    policyKey: 'reward_config.tenants.contact_phone',
    value: '+44 20 7946 0958',
    forbidden: ['+44', '7946', '+44 20 7946 0958'],
    derivedForbidden: ['4420794'],
  },
  {
    policyKey: 'reward_config.tenant_api_keys.key_hash',
    value: 'TC25APIKEYDIGEST-0123456789abcdef',
    forbidden: ['TC25APIKEYDIGEST', '0123456789abcdef'],
  },
  {
    policyKey: 'reward_config.reward_versions.connector_config',
    value: '{"provider":"acme","apiKey":"TC25CONNECTORSECRET"}',
    forbidden: ['TC25CONNECTORSECRET'],
  },

  // --- DTO fields -----------------------------------------------------------------------------
  {
    policyKey: 'dto.LoginRequest.email',
    value: 'login.TC25DTO@example.com',
    forbidden: ['login.TC25DTO', 'TC25DTO'],
  },
  {
    policyKey: 'dto.LoginRequest.password',
    value: 'TC25-Login-Password-Value',
    forbidden: ['TC25-Login-Password-Value'],
  },
  {
    policyKey: 'dto.ChangePasswordRequest.currentPassword',
    value: 'TC25-Current-Password-Value',
    forbidden: ['TC25-Current-Password-Value'],
  },
  {
    policyKey: 'dto.ChangePasswordRequest.newPassword',
    value: 'TC25-New-Password-Value',
    forbidden: ['TC25-New-Password-Value'],
  },
  {
    policyKey: 'dto.ResetPasswordRequest.newPassword',
    value: 'TC25-Reset-Password-Value',
    forbidden: ['TC25-Reset-Password-Value'],
  },
  {
    policyKey: 'dto.CreateUserResponse.temporaryPassword',
    value: 'TC25-Temporary-Password-Value',
    forbidden: ['TC25-Temporary-Password-Value'],
  },
];

/**
 * One object per fixture, carrying its value under **every alias the policy claims to govern** —
 * the snake_case column name and its camelCase DTO form.
 *
 * One object *per fixture* rather than one merged object, because several seeded rows share a bare
 * name (`email` is claimed by `portal_users`, `portal_login_attempts` and `dto.LoginRequest`;
 * `token_hash` by two tables; `newPassword` by two DTOs). Merging them would let a later fixture
 * overwrite an earlier one and quietly drop it from the payload — the vacuity check below would
 * catch it, but not producing the bug is better than detecting it.
 */
function sectionFor(fixture: PiiFixture): Record<string, unknown> {
  const section: Record<string, unknown> = { policyKey: fixture.policyKey };
  for (const alias of aliasesFor(fixture.policyKey)) section[alias] = fixture.value;
  return section;
}

const SECTIONS = PII_FIXTURES.map(sectionFor);

/** A Sequelize-shaped row, so the container-aware branch is exercised inside TC-25 too. */
class SeededUserRow {
  static getTableName(): { tableName: string; schema: string } {
    return { tableName: 'portal_users', schema: 'reward_portal' };
  }
  getDataValue(): unknown {
    return undefined;
  }
  email = 'gm.mathpal@gmail.com';
  displayName = 'Gauri TC25NAME Mathpal';
  mfaSecretEnc = 'JBSWY3DPEHPK3PXP-TC25MFASEED';
  /** No policy row, on a table classified `secret` — must be omitted (the TC-12 ladder). */
  preferredLocale = 'en-GB';
}

/** Shape-matched credentials in free prose, where the key-based layer cannot help (note 5). */
const SAMPLE_JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJUQzI1IiwiaWF0IjoxNzAwMDAwMDAwfQ.' +
  'TC25SignatureValueAAAAAAAAAAAAAAAAAAAAAAA';
const SAMPLE_ARGON2 = '$argon2id$v=19$m=65536,t=3,p=4$TC25SWEEPSALT$TC25SWEEPDIGEST';

/**
 * The sample log object: every seeded value, at every structural position the walk handles.
 *
 * Nesting is kept inside `MAX_LOG_DEPTH` on purpose. Truncation would *also* hide the values, so a
 * payload deep enough to be truncated would pass TC-25 without the masking layer doing anything —
 * proving the depth guard, not the guarantee under test.
 */
function samplePayload(): Record<string, unknown> {
  return {
    msg: 'POST /auth/login',
    correlationId: '0f3d6b2a-3f5b-4c2e-9a11-2f7c9d4e5a60',
    // depth 1, an array of objects
    rows: SECTIONS,
    // inside a request envelope
    request: { method: 'POST', url: '/auth/login', body: { sections: SECTIONS } },
    // five levels of objects and arrays (TC-8's shape, applied to the whole seed set)
    deep: { a: [{ b: { c: [{ d: { e: SECTIONS } }] } }] },
    // Map and Set, both of which the walk flattens
    asMap: new Map(SECTIONS.map((section, index) => [`section_${String(index)}`, section])),
    asSet: new Set(SECTIONS),
    // a real model instance, so resolution goes by column + classification ladder
    model: new SeededUserRow(),
    // free prose: only the shape-based sweep can catch these
    error: new Error(`upstream rejected token ${SAMPLE_JWT} for hash ${SAMPLE_ARGON2}`),
  };
}

/** `Map`/`Set` render as `{}`/`{}` under plain `JSON.stringify`; expand them so nothing is hidden. */
function stringifyDeep(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item instanceof Map) return Object.fromEntries(item);
    if (item instanceof Set) return [...item];
    if (item instanceof Error) return { name: item.name, message: item.message };
    return item;
  });
}

describe('TC-25 — every seeded PII value through the log serialiser', () => {
  beforeEach(() => {
    sweepHits.length = 0;
  });

  /**
   * The self-maintenance guard. A new `pii`/`secret` seed row with no sample value here is a hole
   * in TC-25, and it should stop the build rather than quietly shrink the test's coverage.
   */
  it('has a fixture for every seeded pii/secret policy row', () => {
    const needFixtures = SEEDED_POLICIES.filter(
      (row) => row.classification === 'pii' || row.classification === 'secret',
    ).map((row) => row.policyKey);
    const covered = new Set(PII_FIXTURES.map((fixture) => fixture.policyKey));

    expect(needFixtures.filter((key) => !covered.has(key))).toEqual([]);
    // And nothing in the table names a row the migration does not seed.
    const seeded = new Set(SEEDED_POLICIES.map((row) => row.policyKey));
    expect(PII_FIXTURES.map((f) => f.policyKey).filter((key) => !seeded.has(key))).toEqual([]);
  });

  /**
   * The anti-vacuity guard. If the payload does not actually contain the plaintext, then "no
   * plaintext in the output" is true for the wrong reason and TC-25 proves nothing at all.
   */
  it('the sample payload really does carry every plaintext before masking', () => {
    const raw = stringifyDeep(samplePayload());
    const missing = PII_FIXTURES.flatMap((fixture) =>
      fixture.forbidden
        .filter((needle) => !raw.includes(needle))
        .map((needle) => `${fixture.policyKey}: ${needle}`),
    );
    expect(missing).toEqual([]);
  });

  /** TC-25 itself. */
  it('produces zero unmasked hits for any seeded PII value (TC-25)', () => {
    const out = serialise(samplePayload());
    const serialised = stringifyDeep(out);

    // Reported all at once, not first-failure: if this ever breaks, the useful information is
    // *which* fields leaked, not merely that one did.
    const leaks = PII_FIXTURES.flatMap((fixture) =>
      [...fixture.forbidden, ...(fixture.derivedForbidden ?? [])]
        .filter((needle) => serialised.includes(needle))
        .map((needle) => `${fixture.policyKey} leaked ${JSON.stringify(needle)}`),
    );

    expect(leaks).toEqual([]);
  });

  /**
   * TC-25's counterpart: the output is not empty, and the survivors are the documented ones.
   *
   * A serialiser that returned `{}` would pass the assertion above perfectly. §7's whole premise is
   * that a masked trace stays *usable*, so the masked forms have to be there.
   */
  it('keeps the line readable — masked forms present, structure intact', () => {
    const out = serialise(samplePayload()) as Record<string, unknown>;
    const serialised = stringifyDeep(out);

    expect(out.msg).toBe('POST /auth/login');
    expect(out.correlationId).toBe('0f3d6b2a-3f5b-4c2e-9a11-2f7c9d4e5a60');

    // The email mask, the name mask and the phone mask each appear in their documented form.
    expect(serialised).toContain(`g${MASK_CHAR.repeat(4)}@gmail.com`);
    expect(serialised).toContain(`G${MASK_CHAR.repeat(20)}l`);
    expect(serialised).toContain(`${MASK_CHAR.repeat(7)}7788`);

    // Omitted keys are gone rather than nulled — a null would still say "this user has a TOTP".
    const firstSection = (out.rows as Record<string, unknown>[])[0];
    expect(Object.keys(firstSection)).toContain('email');
    const mfaSection = (out.rows as Record<string, unknown>[]).find(
      (s) => s.policyKey === 'reward_portal.portal_users.mfa_secret_enc',
    );
    expect(mfaSection).toBeDefined();
    expect('mfa_secret_enc' in (mfaSection ?? {})).toBe(false);
    expect('mfaSecretEnc' in (mfaSection ?? {})).toBe(false);
  });

  /** The container-aware half, inside the same payload: TC-12's ladder still applies. */
  it('omits an unlisted column of the secret-classified users table (TC-12, within TC-25)', () => {
    const out = serialise(samplePayload()) as { model: Record<string, unknown> };
    expect(out.model.email).toBe(`g${MASK_CHAR.repeat(4)}@gmail.com`);
    expect('preferredLocale' in out.model).toBe(false);
    expect('mfaSecretEnc' in out.model).toBe(false);
  });

  /** Layer 2, and the loud warning note 5 requires. */
  it('catches shape-matched credentials in free prose and raises the alarm (TC-10, TC-11)', () => {
    const out = serialise(samplePayload()) as { error: Record<string, unknown> };
    const message = String(out.error.message);

    expect(message).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
    expect(message).not.toContain('TC25SWEEPDIGEST');
    expect(message).toContain(`${SWEEP_REPLACEMENT_PREFIX}jwt]`);
    expect(message).toContain(`${SWEEP_REPLACEMENT_PREFIX}argon2]`);

    expect(sweepHits.map((hit) => hit.pattern).sort()).toEqual(['argon2', 'jwt']);
  });

  /**
   * Verification step 4, run as a test so it cannot rot: the exact line the step describes.
   *
   * Kept separate from the bulk payload above because the step names one concrete thing — *"a
   * sample log line containing your own email and every other seeded PII field"* — and a reviewer
   * re-running it wants to see that line's before and after, not a 20-section fixture.
   */
  it('verification step 4 — only the masked form of a real address survives', () => {
    const line = {
      msg: 'user signed in',
      email: 'gm.mathpal@gmail.com',
      displayName: 'Gauri TC25NAME Mathpal',
      password: 'TC25-Login-Password-Value',
      contactPhone: '+60 12-345 7788',
      contactEmail: 'ops.TC25MERCHANT@merchant.example',
      mfaSecretEnc: 'JBSWY3DPEHPK3PXP-TC25MFASEED',
      passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$TC25SALTVALUE$TC25DIGESTVALUE',
      connectorConfig: '{"provider":"acme","apiKey":"TC25CONNECTORSECRET"}',
      temporaryPassword: 'TC25-Temporary-Password-Value',
    };

    const out = serialise(line) as Record<string, unknown>;
    const serialised = JSON.stringify(out);

    expect(out.email).toBe(`g${MASK_CHAR.repeat(4)}@gmail.com`);
    expect(serialised).not.toContain('gm.mathpal');
    expect(serialised).not.toContain('mathpal');

    for (const key of [
      'password',
      'mfaSecretEnc',
      'connectorConfig',
      'temporaryPassword',
    ] as const) {
      expect(key in out).toBe(false);
    }
    // `passwordHash` is caught by T-014's key pattern as well as by its policy row — either way,
    // the digest itself is gone.
    expect(serialised).not.toContain('TC25DIGESTVALUE');
    expect(serialised).not.toContain('TC25CONNECTORSECRET');
    expect(serialised).not.toContain('TC25-Temporary-Password-Value');
  });

  /**
   * **The documented boundary of this guarantee**, asserted rather than left implicit.
   *
   * Layer 1 is key-based and layer 2 is shape-based, so an address pasted into a free-text message
   * is caught by neither: an email has no distinctive shape that a sweep could match without also
   * redacting `noreply@portal` out of every operational line. Implementation note 5 lists exactly
   * four sweep patterns and an email is deliberately not among them.
   *
   * This is stated here, as a passing test of the *current* behaviour, so that nobody reads TC-25
   * as a broader promise than it is, and so that the day someone decides to widen the sweep, the
   * change is visible as an edit to this expectation rather than as a silent behaviour change.
   * Flagged to the architect in the T-017 completion report and to T-019, which owns the transport.
   */
  it('does not (and does not claim to) mask an address inside free prose', () => {
    const out = serialise({
      msg: 'bounced delivery for ops.TC25MERCHANT@merchant.example',
    }) as Record<string, unknown>;

    expect(String(out.msg)).toContain('ops.TC25MERCHANT@merchant.example');
  });
});
