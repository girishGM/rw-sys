/**
 * T-017 — the policy model, and the one function that decides how any given field is treated.
 *
 * `PolicySet` is a **pure, immutable snapshot**: rows in, indexed lookups out, no I/O, no clock,
 * no DI. `PolicyCacheService` owns fetching and expiry; everything a reviewer needs to check
 * about *what the rules mean* is in this file, and every branch of it is reachable from a unit
 * test with a literal array of rows. That split is deliberate — this is the file where a mistake
 * silently under-protects a column, so it is the file that must be exhaustively testable.
 *
 * ---
 *
 * ## The fail-closed ladder, and the one interpretation this task had to make
 *
 * 07-DATA-PROTECTION.md §2 says:
 *
 * > *"If a field has no policy row, the engine falls back to **the classification default for
 * > its table**, not to `plain`. An unknown field in a `secret`-class table is treated as
 * > `secret`."*
 *
 * Two things follow, and the second is an interpretation worth stating plainly rather than
 * burying:
 *
 * **1. A table's classification is the maximum over its own policy rows.** There is no
 * table-level classification column in §2's DDL, and inventing one would be schema this task
 * does not own. Taking the maximum is the fail-closed reading: one `secret` column makes the
 * table `secret`, so an unlisted sibling column inherits the strict default rather than a
 * permissive one. `merchants` has a `pii` row, so an unlisted `merchants` column is `pii`.
 *
 * **2. `logging.defaultTreatment: "omit"` and `response.defaultVisibility: "masked"` apply to
 * fields in a *classified* container, not to every field in the process.** Read the other way —
 * "every unrecognised field anywhere is omitted from logs and masked in responses" — the portal
 * returns dots for `campaignName` and logs nothing but `[REDACTED]`, which is not a security
 * posture, it is an outage. §2's own sentence keys the default to *"its table"*, and §10's
 * commentary keys it to *"a sensitive-class table"*; both point the same way. So:
 *
 * | container classification | log treatment | ui visibility |
 * |---|---|---|
 * | *(no policy row for this container at all)* | `plain` | `plain` |
 * | `public`, `internal` | `plain` | `plain` |
 * | `confidential` | `mask` (`full`) | `masked` |
 * | `pii`, `secret` | `logging.defaultTreatment` (`omit`) | `response.defaultVisibility` (`masked`) |
 *
 * The residual risk of row 1 — a table nobody has classified at all, holding PII — is real, and
 * is covered by three independent things rather than by pretending it away: the key-pattern
 * fallback inherited from T-014's `redact()`, the final regex sweep in
 * `log-masking.serializer.ts` (whose whole job is to be loud when a policy row is missing), and
 * **T-044**, whose deliverable is the inventory of exactly those columns. Recorded in the T-017
 * completion report so it is a known, tracked gap and not a discovered one.
 *
 * `failClosed: false` in the config collapses the ladder to `plain`/`plain`. It exists so the
 * flag in §10 means something; it is not a mode anything should run in.
 *
 * ## Why an unknown enum value ranks as *most* sensitive
 *
 * {@link rankClassification} puts anything it does not recognise above `secret`. A row carrying
 * a classification this build has never heard of was written by a newer deployment against the
 * same database, and the safe assumption about data somebody else thought worth classifying is
 * not "harmless".
 */
import { assertBlindIndexAllowed } from '@/common/crypto';
import {
  CLASSIFICATIONS,
  maxClassification,
  strictestLogTreatment,
  strictestUiVisibility,
  type AtRest,
  type Classification,
  type InTransit,
  type LogTreatment,
  type MaskStrategyName,
  type PolicyScope,
  type UiVisibility,
} from './data-protection.constants';
import { isMaskStrategy } from './mask.strategies';
import type { DataProtectionConfig } from './data-protection.config';

/** One `reward_portal.data_protection_policies` row, already coerced to application types. */
export interface DataProtectionPolicy {
  readonly policyKey: string;
  readonly scope: PolicyScope;
  readonly classification: Classification;
  readonly atRest: AtRest;
  readonly blindIndex: boolean;
  readonly inTransit: InTransit;
  readonly logTreatment: LogTreatment;
  readonly maskStrategy: MaskStrategyName | null;
  readonly uiVisibility: UiVisibility;
  readonly revealRoles: readonly string[] | null;
  readonly keyPurpose: string | null;
  readonly enabled: boolean;
  readonly note: string | null;
}

/** Where a {@link ResolvedPolicy} came from. Carried so a log line can explain itself. */
export type PolicySource =
  'row' | 'classification_default' | 'unclassified' | 'fail_closed' | 'engine_disabled';

/** The effective treatment of one field, after the ladder above has been applied. */
export interface ResolvedPolicy {
  /** The matched row's key, or `null` when the treatment was derived rather than declared. */
  readonly policyKey: string | null;
  readonly source: PolicySource;
  readonly classification: Classification;
  readonly atRest: AtRest;
  readonly blindIndex: boolean;
  readonly inTransit: InTransit;
  readonly logTreatment: LogTreatment;
  readonly maskStrategy: MaskStrategyName | null;
  readonly uiVisibility: UiVisibility;
  readonly revealRoles: readonly string[];
  readonly keyPurpose: string | null;
}

/**
 * Raised while **building** a policy set from rows the database returned.
 *
 * Building is configuration loading, and 07-DATA-PROTECTION.md §6 is explicit that the
 * blind-index restriction is enforced by refusing the configuration rather than by ignoring the
 * offending row. `PolicyCacheService` catches this and keeps the previous snapshot (or none),
 * which fails closed — see that file.
 */
export class PolicyValidationError extends Error {
  constructor(
    message: string,
    readonly policyKey: string,
  ) {
    super(message);
    this.name = 'PolicyValidationError';
    Error.captureStackTrace?.(this, PolicyValidationError);
  }
}

/**
 * The treatment applied when the engine cannot answer — a cache miss, a cache failure, a
 * validation failure. Implementation note 8: *"a cache failure **denies** (masks), never falls
 * back to plain"* (TC-21).
 */
export const FAIL_CLOSED_POLICY: ResolvedPolicy = Object.freeze({
  policyKey: null,
  source: 'fail_closed' as PolicySource,
  classification: 'secret' as Classification,
  atRest: 'none' as AtRest,
  blindIndex: false,
  inTransit: 'tls_only' as InTransit,
  logTreatment: 'omit' as LogTreatment,
  maskStrategy: 'full' as MaskStrategyName,
  uiVisibility: 'masked' as UiVisibility,
  revealRoles: Object.freeze([]) as readonly string[],
  keyPurpose: null,
});

/** The treatment applied to everything when `enabled: false` — T-017's documented rollback. */
export const ENGINE_DISABLED_POLICY: ResolvedPolicy = Object.freeze({
  ...FAIL_CLOSED_POLICY,
  source: 'engine_disabled' as PolicySource,
  classification: 'public' as Classification,
  logTreatment: 'plain' as LogTreatment,
  maskStrategy: null,
  uiVisibility: 'plain' as UiVisibility,
});

const UNCLASSIFIED_POLICY: ResolvedPolicy = Object.freeze({
  ...FAIL_CLOSED_POLICY,
  source: 'unclassified' as PolicySource,
  classification: 'public' as Classification,
  logTreatment: 'plain' as LogTreatment,
  maskStrategy: null,
  uiVisibility: 'plain' as UiVisibility,
});

/** The `dto.` prefix that distinguishes a DTO-field key from a schema-qualified column key. */
export const DTO_KEY_PREFIX = 'dto.';

/**
 * The read side of the engine. Implemented by {@link PolicySet} and by `PolicyCacheService`, so
 * the serialiser and the interceptor can be unit-tested against a two-line fake rather than
 * against a database.
 */
export interface PolicyLookup {
  /** `table` is schema-qualified: `reward_portal.portal_users`. */
  resolveColumn(table: string, column: string): ResolvedPolicy;
  /** `dto` is the DTO class name, without the `dto.` prefix. */
  resolveDtoField(dto: string, field: string): ResolvedPolicy;
  /** By bare field name, for a payload whose container is unknown. `null` when nothing matches. */
  resolveFieldName(name: string): ResolvedPolicy | null;
  /** The exact row for a policy key, or `null`. Used by the reveal endpoint. */
  policyFor(policyKey: string): DataProtectionPolicy | null;
  /** Every enabled column policy for one table. Used to generate the model hooks. */
  columnPoliciesFor(table: string): readonly DataProtectionPolicy[];
  /** Every distinct schema-qualified table that has at least one enabled column policy. */
  protectedTables(): readonly string[];
}

/**
 * An immutable, indexed view over the policy rows.
 *
 * Four indexes, each answering a question a different enforcement point asks:
 *
 *  - `byKey` — the reveal endpoint and the hooks, which know the exact policy key.
 *  - `byContainer` — the hooks, which need "every encrypted column of this table".
 *  - `containerClassification` — the fail-closed ladder.
 *  - `byAlias` — the log serialiser and the response interceptor, which see a bare property name
 *    (`contactEmail`) and no container. Aliases cover the snake_case column name and its
 *    camelCase form, because a column is `contact_email` in the database and `contactEmail` in
 *    the DTO, and one policy row has to govern both.
 */
export class PolicySet implements PolicyLookup {
  private readonly byKey: ReadonlyMap<string, DataProtectionPolicy>;
  private readonly byContainer: ReadonlyMap<string, readonly DataProtectionPolicy[]>;
  private readonly containerClassification: ReadonlyMap<string, Classification>;
  private readonly byAlias: ReadonlyMap<string, ResolvedPolicy>;

  constructor(
    rows: readonly DataProtectionPolicy[],
    private readonly config: DataProtectionConfig,
  ) {
    const byKey = new Map<string, DataProtectionPolicy>();
    const byContainer = new Map<string, DataProtectionPolicy[]>();
    const containerClassification = new Map<string, Classification>();
    const byAlias = new Map<string, ResolvedPolicy>();

    for (const row of rows) {
      validatePolicy(row);

      const { container } = splitPolicyKey(row.policyKey);

      // A *disabled* row still contributes its classification to the container. Disabling the
      // row for `merchants.contact_email` must not quietly downgrade every other unlisted
      // `merchants` column from "pii by default" to "plain by default" — that would make
      // `enabled=false` a far bigger switch than it looks, and in the wrong direction.
      const previous = containerClassification.get(container);
      containerClassification.set(
        container,
        previous === undefined
          ? row.classification
          : maxClassification(previous, row.classification),
      );

      if (!row.enabled) continue;

      if (byKey.has(row.policyKey)) {
        throw new PolicyValidationError(
          `Duplicate policy key '${row.policyKey}'. uq_dpp_key should make this impossible; a ` +
            `duplicate here means the rows were not read from that table.`,
          row.policyKey,
        );
      }
      byKey.set(row.policyKey, row);

      const siblings = byContainer.get(container);
      if (siblings === undefined) byContainer.set(container, [row]);
      else siblings.push(row);

      const resolved = fromRow(row);
      for (const alias of aliasesFor(row.policyKey)) {
        const existing = byAlias.get(alias);
        byAlias.set(alias, existing === undefined ? resolved : strictestOf(existing, resolved));
      }
    }

    this.byKey = byKey;
    this.byContainer = new Map([...byContainer].map(([k, v]) => [k, Object.freeze(v)]));
    this.containerClassification = containerClassification;
    this.byAlias = byAlias;
  }

  resolveColumn(table: string, column: string): ResolvedPolicy {
    return this.resolveIn(table, `${table}.${column}`);
  }

  resolveDtoField(dto: string, field: string): ResolvedPolicy {
    const container = `${DTO_KEY_PREFIX}${dto}`;
    return this.resolveIn(container, `${container}.${field}`);
  }

  resolveFieldName(name: string): ResolvedPolicy | null {
    if (!this.config.enabled) return ENGINE_DISABLED_POLICY;
    return this.byAlias.get(name) ?? this.byAlias.get(toSnakeCase(name)) ?? null;
  }

  policyFor(policyKey: string): DataProtectionPolicy | null {
    return this.byKey.get(policyKey) ?? null;
  }

  columnPoliciesFor(table: string): readonly DataProtectionPolicy[] {
    return (this.byContainer.get(table) ?? []).filter((row) => row.scope === 'column');
  }

  protectedTables(): readonly string[] {
    return [...this.byContainer.keys()].filter((key) => !key.startsWith(DTO_KEY_PREFIX));
  }

  /** The classification a container inherits, or `null` when nothing classifies it. */
  classificationOf(container: string): Classification | null {
    return this.containerClassification.get(container) ?? null;
  }

  /**
   * Every field name whose effective policy says `in_transit = 'payload_encrypt'`, sorted.
   *
   * **Added by T-018**, which this module's header already named as the consumer that "needs
   * `in_transit` per field". The engine's own five enforcement points all resolve one field at a
   * time and never need to enumerate; T-018's `fields` mode does, and only in one direction: the
   * server resolves each field it actually receives, but the **browser** holds no policy table
   * and has to be told which request fields to encrypt before it has seen a response.
   *
   * Returns names, never values and never policy keys — see `TransportPolicyService`.
   */
  payloadEncryptFieldNames(): readonly string[] {
    const names: string[] = [];
    for (const [alias, policy] of this.byAlias) {
      if (policy.inTransit === 'payload_encrypt') names.push(alias);
    }
    return Object.freeze(names.sort());
  }

  /** Number of enabled rows. For the boot log line and for TC-22's idempotency assertion. */
  get size(): number {
    return this.byKey.size;
  }

  /** The exact row, then the container's classification default, then unclassified. */
  private resolveIn(container: string, policyKey: string): ResolvedPolicy {
    if (!this.config.enabled) return ENGINE_DISABLED_POLICY;

    const row = this.byKey.get(policyKey);
    if (row !== undefined) return fromRow(row);

    return this.classificationDefault(this.containerClassification.get(container));
  }

  /** The ladder in the file header, in one place. */
  private classificationDefault(classification: Classification | undefined): ResolvedPolicy {
    if (classification === undefined) return UNCLASSIFIED_POLICY;
    if (!this.config.failClosed) return UNCLASSIFIED_POLICY;

    switch (classification) {
      case 'public':
      case 'internal':
        return UNCLASSIFIED_POLICY;
      case 'confidential':
        return Object.freeze({
          ...FAIL_CLOSED_POLICY,
          source: 'classification_default' as PolicySource,
          classification,
          logTreatment: 'mask' as LogTreatment,
          maskStrategy: 'full' as MaskStrategyName,
          uiVisibility: 'masked' as UiVisibility,
        });
      default:
        // `pii` and `secret` — plus, via `rankClassification`, anything unrecognised, which
        // cannot reach here because `validatePolicy` rejects it at build time.
        return Object.freeze({
          ...FAIL_CLOSED_POLICY,
          source: 'classification_default' as PolicySource,
          classification,
          logTreatment: this.config.logging.defaultTreatment,
          maskStrategy: this.config.logging.defaultTreatment === 'mask' ? 'full' : null,
          uiVisibility: this.config.response.defaultVisibility,
        });
    }
  }
}

/**
 * Splits `a.b.c` into the container (`a.b`) and the leaf (`c`).
 *
 * Split on the **last** dot, not the first: `reward_portal.portal_users.email` has a
 * three-segment container-plus-leaf shape, and `dto.CreateUserResponse.temporaryPassword` has a
 * two-segment one. Taking the last dot handles both without the key needing to declare which it
 * is, and it is why a column name containing a dot is rejected below.
 */
export function splitPolicyKey(policyKey: string): { container: string; leaf: string } {
  const dot = policyKey.lastIndexOf('.');
  return { container: policyKey.slice(0, dot), leaf: policyKey.slice(dot + 1) };
}

/**
 * The property names one policy row governs.
 *
 * The database column is `contact_email`; the response DTO calls it `contactEmail`; a log line
 * may carry either. One row must cover all of them, so both forms are indexed. Deliberately
 * **not** case-insensitive beyond that: matching `Email` to `email` would make an unrelated
 * `EmailTemplate` field inherit a PII policy, and over-masking a template is a support ticket
 * whereas the ambiguity it introduces is permanent.
 */
export function aliasesFor(policyKey: string): readonly string[] {
  const { leaf } = splitPolicyKey(policyKey);
  const camel = toCamelCase(leaf);
  return camel === leaf ? [leaf] : [leaf, camel];
}

/** `contact_email` → `contactEmail`. */
export function toCamelCase(value: string): string {
  return value.replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase());
}

/** `contactEmail` → `contact_email`. */
export function toSnakeCase(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/** The stricter of two candidate treatments, field by field. Used when one alias matches many. */
export function strictestOf(a: ResolvedPolicy, b: ResolvedPolicy): ResolvedPolicy {
  const logTreatment = strictestLogTreatment(a.logTreatment, b.logTreatment);
  const uiVisibility = strictestUiVisibility(a.uiVisibility, b.uiVisibility);
  return Object.freeze({
    // Ambiguous by construction — two different rows matched the same bare name — so the key is
    // dropped rather than one of them being picked. A consumer that needs the key (the reveal
    // endpoint) looks up by exact key and never goes through the alias index.
    policyKey: a.policyKey === b.policyKey ? a.policyKey : null,
    source: 'row' as PolicySource,
    classification: maxClassification(a.classification, b.classification),
    atRest: a.atRest === b.atRest ? a.atRest : ('none' as AtRest),
    blindIndex: a.blindIndex && b.blindIndex,
    inTransit:
      a.inTransit === 'payload_encrypt' || b.inTransit === 'payload_encrypt'
        ? ('payload_encrypt' as InTransit)
        : ('tls_only' as InTransit),
    logTreatment,
    // A `mask` treatment with no strategy would silently degrade to plain — the exact failure
    // `ck_dpp_mask_strategy` exists to prevent — so `full` is substituted when the two rows
    // disagree or neither supplies one.
    maskStrategy:
      logTreatment === 'mask'
        ? (a.maskStrategy ?? b.maskStrategy ?? ('full' as MaskStrategyName))
        : null,
    uiVisibility,
    // Intersection: a role may unmask only if **every** matching policy allows it.
    revealRoles: Object.freeze(a.revealRoles.filter((role) => b.revealRoles.includes(role))),
    keyPurpose: a.keyPurpose === b.keyPurpose ? a.keyPurpose : null,
  });
}

/** A row, as an effective treatment. */
function fromRow(row: DataProtectionPolicy): ResolvedPolicy {
  return Object.freeze({
    policyKey: row.policyKey,
    source: 'row' as PolicySource,
    classification: row.classification,
    atRest: row.atRest,
    blindIndex: row.blindIndex,
    inTransit: row.inTransit,
    logTreatment: row.logTreatment,
    maskStrategy: row.maskStrategy,
    uiVisibility: row.uiVisibility,
    revealRoles: Object.freeze([...(row.revealRoles ?? [])]),
    keyPurpose: row.keyPurpose,
  });
}

/**
 * Re-checks in the application everything the table's `CHECK` constraints already enforce.
 *
 * Not redundancy for its own sake. The rows reaching this function have travelled through
 * Sequelize's type coercion and could have been written by an older or newer deployment against
 * the same database; and TC-23's requirement is that a `blind_index=true` on a non-PII field is
 * rejected by *"migration/validation"*, i.e. by both. The database constraint stops it being
 * written; this stops a row that predates the constraint being *used*. `assertBlindIndexAllowed`
 * in `@/common/crypto` is the same rule, owned by T-016 and called from here — 07-DATA-PROTECTION
 * §6 says the check belongs to T-016, and duplicating its message would let the two drift.
 */
export function validatePolicy(row: DataProtectionPolicy): void {
  const fail = (reason: string): never => {
    throw new PolicyValidationError(`Policy '${row.policyKey}': ${reason}`, row.policyKey);
  };

  if (typeof row.policyKey !== 'string' || row.policyKey.length === 0) {
    fail('policy_key is empty.');
  }
  const dot = row.policyKey.lastIndexOf('.');
  if (dot <= 0 || dot === row.policyKey.length - 1) {
    fail(
      "policy_key must be '<schema>.<table>.<column>' or 'dto.<DtoName>.<field>' — see " +
        '07-DATA-PROTECTION.md §2.',
    );
  }
  if (!(CLASSIFICATIONS as readonly string[]).includes(row.classification)) {
    fail(`unknown classification '${row.classification}'.`);
  }
  if (row.logTreatment === 'mask' && !isMaskStrategy(row.maskStrategy)) {
    // The application half of ck_dpp_mask_strategy (TC-24). §2: "A masked presentation without a
    // strategy silently degrades to plain. Forbid it."
    fail("log_treatment='mask' requires a mask_strategy (ck_dpp_mask_strategy).");
  }
  if (row.uiVisibility === 'reveal_on_demand' && (row.revealRoles ?? []).length === 0) {
    // The application half of ck_dpp_reveal_roles. An empty array satisfies the database's
    // `is not null` but means "nobody may reveal", which is `masked` written the confusing way.
    fail("ui_visibility='reveal_on_demand' requires a non-empty reveal_roles array.");
  }
  if (row.blindIndex) {
    // T-016 owns this rule and its wording (07-DATA-PROTECTION.md §6: "checked in T-016"). It is
    // called rather than reimplemented so the two cannot drift; its `BlindIndexError` is
    // re-wrapped so every caller of this function still handles exactly one error type.
    try {
      assertBlindIndexAllowed(row.policyKey, row.classification);
    } catch (error) {
      fail((error as Error).message);
    }
  }
  if (row.blindIndex && row.scope !== 'column') {
    fail('blind_index=true is meaningful only on a column policy; a DTO field is not indexed.');
  }
}
