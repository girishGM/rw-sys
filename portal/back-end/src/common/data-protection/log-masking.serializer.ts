/**
 * T-017 — enforcement point ③, logging (07-DATA-PROTECTION.md §7, implementation notes 4 and 5).
 *
 * > *"A pino serialiser consults the policy cache before any line is written. Because it runs at
 * > the serialiser level rather than at call sites, a developer logging a whole request object
 * > still cannot leak a protected field."*
 *
 * ---
 *
 * ## Two layers, and why neither is sufficient alone
 *
 * **Layer 1 — the policy walk.** Every property, at every depth, inside arrays, `Map`s and
 * `Set`s, is looked up in the policy cache by name and treated per `log_treatment`
 * (`plain`/`mask`/`hash`/`omit`). This is the layer that is *correct*: it knows that
 * `contact_email` is PII and renders `j••••@example.com` rather than deleting it, so a trace
 * stays readable.
 *
 * **Layer 2 — the final regex sweep** (implementation note 5). Layer 1 is key-based, so it is
 * blind to a secret that arrives under an innocuous name — a JWT logged as `{ note: "eyJ…" }`, a
 * password hash concatenated into a message string. The sweep runs over the *serialised* form
 * and matches on **value shape**: JWTs, `$argon2` hashes, PEM headers, `v1.` ciphertext. A hit is
 * redacted **and raises a `WARN` naming the call site**, because — as note 5 says — a hit means a
 * policy row is missing, and *"it should be loud"*.
 *
 * Layer 1 without layer 2 misses anything mis-named. Layer 2 without layer 1 misses every PII
 * value that does not have a distinctive shape, which is most of them (an email in a `note` field
 * is just a string). Both, or neither works.
 *
 * ## Relationship to T-014's `redact()`
 *
 * `common/logging/redact.ts` masks by a **key pattern** (`/password|token|secret|hash|…/i`) with
 * no database dependency. It is not replaced and not weakened: it runs here as the fallback for
 * every field the policy table does not mention, so removing a policy row can never make a
 * password *less* protected than it was before this task existed. The precedence is:
 *
 * ```
 *   policy row  >  T-014 key pattern  >  container classification default  >  plain
 * ```
 *
 * with the regex sweep over the result of all of it.
 *
 * ## Structural guarantees (inherited from `redact.ts`, restated because they are load-bearing)
 *
 *  - **Total.** No input throws — cycles, `Buffer`s, throwing getters, `Map`/`Set`, `Error`,
 *    `BigInt`, depth. A serialiser that can throw turns a logging call into a 500.
 *  - **Pure.** The input object is never mutated. The application is still using it.
 *  - **Depth-bounded and cycle-guarded** (TC-8, TC-9).
 *  - **Fail-closed.** Every policy lookup goes through the cache's `*Safe` form, so an
 *    unreachable cache omits rather than discloses (TC-21).
 */
import { isSensitiveKey } from '@/common/logging/redact';
import { looksLikeCiphertext } from '@/common/crypto';
import type { LogTreatment } from './data-protection.constants';
import { applyMask, hashForLog } from './mask.strategies';
import { toSnakeCase, type PolicyLookup, type ResolvedPolicy } from './policy.service';

/** How deep the walk goes. Matches `redact.ts`'s bound so the two behave identically on depth. */
export const MAX_LOG_DEPTH = 12;

export const TRUNCATED = '[TRUNCATED]';
export const CIRCULAR = '[CIRCULAR]';
export const BINARY = '[BINARY]';
export const REDACTED = '[REDACTED]';

/** What replaces a value the sweep matched. The suffix names *which* pattern fired. */
export const SWEEP_REPLACEMENT_PREFIX = '[REDACTED:';

/**
 * The value-shape patterns of implementation note 5.
 *
 * Each is anchored on something an ordinary sentence does not contain, so false positives are
 * rare — but a false positive here costs a redacted word in a log line, and a false *negative*
 * costs a credential in a log aggregator, so every pattern is deliberately the broader of the two
 * plausible readings.
 *
 * `g` flags are set, and the patterns are re-created per call rather than shared, because a
 * shared `g`-flagged `RegExp` carries `lastIndex` between calls and would skip the first match of
 * every second line — a bug that only appears under load, which is exactly when it matters.
 */
export function sweepPatterns(): readonly { name: string; pattern: RegExp }[] {
  return [
    {
      // Three base64url segments. The `eyJ` prefix is `{"` base64-encoded, i.e. every JWT header.
      name: 'jwt',
      pattern: /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g,
    },
    {
      // `$argon2id$v=19$m=…,t=…,p=…$salt$hash` — and `$argon2i`/`$argon2d` too.
      //
      // **The comma is inside the match, not a terminator** (defect found by TC-25, 2026-08-18).
      // This class previously excluded `,` as well, so a real PHC string stopped matching at
      // `m=65536` and the sweep replaced only the parameter prefix — leaving
      // `,t=3,p=4$<salt>$<digest>` intact in the line. What it kept is the only part worth
      // protecting, so the pattern looked like it worked while redacting nothing that mattered,
      // and TC-11's assertion (`not.toContain('$argon2')`) stayed green throughout because the
      // prefix genuinely was gone. The spec now asserts the salt and the digest are absent
      // instead, which is the claim that was always meant.
      //
      // `"`, `'`, `}` and `]` still terminate, and none of them can occur inside a PHC string, so
      // a hash embedded in JSON is still bounded by its closing quote. In free prose a trailing
      // comma is swallowed into the redaction; over-redacting one punctuation mark is the right
      // side of this trade.
      name: 'argon2',
      pattern: /\$argon2[a-z]{1,2}\$[^\s"'}\]]+/g,
    },
    {
      // A PEM block, header to footer where both are present, header alone otherwise. Covers
      // `PRIVATE KEY`, `RSA PRIVATE KEY`, `CERTIFICATE`, `OPENSSH PRIVATE KEY`.
      name: 'pem',
      pattern: /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)/g,
    },
    {
      // A `v1.<kid>.<iv>.<tag>.<ct>` field ciphertext (07-DATA-PROTECTION.md §4). Ciphertext in a
      // log is not itself a disclosure, but it is a reliable signal that a column was logged
      // without a policy row — which is precisely the alarm note 5 asks for.
      name: 'ciphertext',
      pattern:
        /\bv1\.[A-Za-z0-9_-]{1,40}\.[A-Za-z0-9+/]{16}={0,2}\.[A-Za-z0-9+/]{22}={0,2}\.[A-Za-z0-9+/]*={0,2}/g,
    },
  ];
}

/** One sweep hit, handed to the alarm callback. */
export interface SweepHit {
  /** Which pattern fired: `jwt`, `argon2`, `pem`, `ciphertext`. */
  readonly pattern: string;
  /** How many occurrences were replaced. */
  readonly count: number;
  /**
   * The application frame that produced the line, as `file:line:col`, or `null`.
   *
   * Note 5 asks the warning to *"name the call site"*, because the point of the alarm is that
   * somebody can go and add the missing policy row. The stack is captured **only when a hit
   * occurs** — `new Error()` is not free, and this path is meant to be cold.
   */
  readonly callSite: string | null;
}

export interface LogMaskingOptions {
  readonly policies: PolicyLookup;
  /** From `config.logging.finalRegexSweep`. */
  readonly finalRegexSweep?: boolean;
  /**
   * Where the alarm goes. Defaults to `console.warn`.
   *
   * Injected rather than using a `Logger` directly for one reason: the alarm is raised *from
   * inside the serialiser*, so a handler that logs through the same logger would re-enter this
   * function. {@link createLogMaskingSerialiser} guards against that re-entry anyway, but a
   * handler the caller controls is the honest design — T-019/T-052, which own the logger, can
   * route it to a channel that is not the one being serialised.
   */
  readonly onSweepHit?: (hit: SweepHit) => void;
}

/**
 * The serialiser a logging library installs.
 *
 * winston: `winston.format(createLogMaskingSerialiser({ policies }))()`.
 * pino: `{ formatters: { log: createLogMaskingSerialiser({ policies }) } }`.
 *
 * **T-019/T-052 own the logger itself and must install this**, exactly as `redact.ts` says of
 * `redactSerialiser`. This task owns the function, not the transport it plugs into.
 */
export function createLogMaskingSerialiser(
  options: LogMaskingOptions,
): <T extends object>(info: T) => T {
  return <T extends object>(info: T): T => maskForLog(info, options) as T;
}

/**
 * Masks one log payload: the policy walk, then the sweep.
 *
 * Returns a **new** object; the input is untouched.
 */
export function maskForLog(value: unknown, options: LogMaskingOptions): unknown {
  const walked = walk(value, 0, new WeakSet<object>(), options.policies);
  if (options.finalRegexSweep === false) return walked;
  return sweep(walked, options.onSweepHit ?? defaultSweepAlarm);
}

/**
 * The final regex sweep over an already-walked structure.
 *
 * Applied to **string leaves**, not to a single `JSON.stringify` of the whole payload, for two
 * reasons. Stringifying would have to cope with cycles and `BigInt` all over again (the walk has
 * already replaced both, but a caller could invoke this directly). More importantly, redacting
 * inside a JSON *string* and handing that back would change the payload's type from object to
 * string, and a logging library that then serialises it produces a double-encoded line that no
 * log query can search. Matching per leaf keeps the structure intact and the redaction precise.
 */
export function sweep(value: unknown, onHit: (hit: SweepHit) => void): unknown {
  const patterns = sweepPatterns();
  const counts = new Map<string, number>();

  const scan = (input: unknown): unknown => {
    if (typeof input === 'string') {
      let out = input;
      for (const { name, pattern } of patterns) {
        out = out.replace(pattern, () => {
          counts.set(name, (counts.get(name) ?? 0) + 1);
          return `${SWEEP_REPLACEMENT_PREFIX}${name}]`;
        });
      }
      return out;
    }
    if (Array.isArray(input)) return input.map(scan);
    // **Plain objects only.** Rebuilding an arbitrary object from `Object.entries` would turn a
    // `Date` into `{}` — it has no own enumerable properties — and with it every timestamp in
    // every log line. The walk deliberately preserves `Date`s, so the sweep must not undo that.
    // Anything the walk emits that is not a plain object is either a primitive, a `Date`, or a
    // marker string, and none of those can hide a credential inside a property.
    if (isPlainObject(input)) {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(input)) out[key] = scan(item);
      return out;
    }
    return input;
  };

  const scanned = scan(value);

  if (counts.size > 0) {
    const callSite = captureCallSite();
    for (const [name, count] of counts) onHit({ pattern: name, count, callSite });
  }
  return scanned;
}

/**
 * The default alarm: a `console.warn` naming the pattern and the call site.
 *
 * `console` rather than Nest's `Logger` deliberately — see {@link LogMaskingOptions.onSweepHit}.
 * The wording states the remedy, because the person who sees this line is usually not the person
 * who knows what `v1.` means.
 */
export function defaultSweepAlarm(hit: SweepHit): void {
  // eslint-disable-next-line no-console -- T-017: this IS the alarm; routing it through the
  // logger would re-enter the serialiser that raised it. See LogMaskingOptions.onSweepHit.
  console.warn(
    `[data-protection] final log sweep redacted ${String(hit.count)} ${hit.pattern} value(s) at ` +
      `${hit.callSite ?? 'an unknown call site'}. This means a field reached the logger with no ` +
      `data_protection_policies row — add one (07-DATA-PROTECTION.md §7) rather than relying on ` +
      `this sweep, which matches shape and will not catch the same value in another form.`,
  );
}

/** `{}` or `Object.create(null)`, and nothing else. See {@link sweep}. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * First stack frame outside this file — the application code that logged the line.
 *
 * Best-effort by construction: it depends on V8's stack format and returns `null` rather than
 * guessing when the shape is unfamiliar. The warning is still useful without it.
 *
 * The argument is resolved rather than defaulted, so that `captureCallSite(null)` genuinely means
 * "there is no stack". A default parameter would substitute `new Error().stack` for an explicit
 * `undefined` too, which makes the no-stack branch — the one that runs on a platform with stack
 * capture disabled — unreachable from a test.
 */
export function captureCallSite(stack?: string | null): string | null {
  const resolved = stack === undefined ? new Error().stack : stack;
  if (resolved === null || resolved === undefined) return null;
  for (const line of resolved.split('\n').slice(1)) {
    if (line.includes('log-masking.serializer')) continue;
    const match = /\(?([^()\s]+:\d+:\d+)\)?\s*$/.exec(line.trim());
    if (match !== null) return match[1];
  }
  return null;
}

// --- the policy walk ---------------------------------------------------------------------------

/**
 * Applies one resolved treatment to one value.
 *
 * `omit` is signalled by {@link OMIT}, a module-private sentinel object, rather than by
 * `undefined`: `undefined` is a value a payload can legitimately hold, and conflating the two
 * would make `{ a: undefined }` and an omitted `a` indistinguishable — which matters because one
 * of them means "the engine decided to hide this".
 */
const OMIT = Symbol('OMIT');

export function treatValue(
  value: unknown,
  treatment: LogTreatment,
  policy: ResolvedPolicy,
): unknown {
  switch (treatment) {
    case 'omit':
      return OMIT;
    case 'mask':
      return applyMask(value, policy.maskStrategy);
    case 'hash':
      // A non-string is hashed via its JSON form rather than `String(value)`: `String({})` is
      // `"[object Object]"`, so every object would share one digest and the treatment's whole
      // purpose — correlation — would be lost.
      return hashForLog(typeof value === 'string' ? value : stableString(value));
    default:
      return value;
  }
}

function walk(
  value: unknown,
  depth: number,
  ancestors: WeakSet<object>,
  policies: PolicyLookup,
): unknown {
  if (depth > MAX_LOG_DEPTH) return TRUNCATED;
  if (value === null || value === undefined) return value;

  // A stray ciphertext as a *leaf* — not under a policy-governed key — is replaced here rather
  // than left for the sweep, so the structure shows what happened even if the sweep is off.
  if (looksLikeCiphertext(value)) return `${SWEEP_REPLACEMENT_PREFIX}ciphertext]`;

  if (typeof value === 'bigint') return `${String(value)}n`;
  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
  if (typeof value === 'symbol') return value.toString();
  if (typeof value !== 'object') return value;

  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return BINARY;
  }
  if (value instanceof Date) return value;
  if (value instanceof RegExp) return value.toString();

  if (ancestors.has(value)) return CIRCULAR;
  ancestors.add(value);
  try {
    if (Array.isArray(value))
      return value.map((item) => walk(item, depth + 1, ancestors, policies));
    if (value instanceof Set) {
      return [...value].map((item) => walk(item, depth + 1, ancestors, policies));
    }
    if (value instanceof Map) return entries(mapToRecord(value), depth, ancestors, policies, null);
    if (value instanceof Error) return errorEntries(value, depth, ancestors, policies);
    return entries(recordOf(value), depth, ancestors, policies, containerOf(value));
  } finally {
    ancestors.delete(value);
  }
}

/**
 * The precedence chain in the file header, per property.
 *
 * The order of the first two is the important part. A policy row wins over T-014's key pattern
 * **even when the policy is more permissive**, because a policy row is an explicit decision by
 * someone who looked at the field, whereas the pattern is a heuristic — that is the entire reason
 * the policy table exists. The pattern then covers everything the table does not mention, so the
 * floor never drops below what T-014 already guaranteed.
 */
function entries(
  source: Record<string, unknown>,
  depth: number,
  ancestors: WeakSet<object>,
  policies: PolicyLookup,
  container: string | null,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [key, raw] of Object.entries(source)) {
    const policy = resolvePolicyFor(key, policies, container);

    if (policy !== null) {
      const treated = treatValue(raw, policy.logTreatment, policy);
      if (treated === OMIT) continue;
      // A `plain` policy still walks into the value: `plain` says "this property name is not
      // sensitive", not "nothing beneath it is".
      out[key] =
        policy.logTreatment === 'plain' ? walk(raw, depth + 1, ancestors, policies) : treated;
      continue;
    }

    if (isSensitiveKey(key)) {
      out[key] = REDACTED;
      continue;
    }

    out[key] = walk(raw, depth + 1, ancestors, policies);
  }

  return out;
}

/**
 * Looks one property name up, fail-closed.
 *
 * ### The container is what makes TC-12 real
 *
 * When the walk is inside a **Sequelize model instance** it knows which table the properties came
 * from, so it resolves by column (`resolveColumn(table, column)`), which applies the fail-closed
 * classification ladder in `policy.service.ts`: an unlisted column of a `pii`- or
 * `secret`-classified table is treated as `secret` and omitted, rather than being logged in full
 * because nobody wrote a row for it. That is TC-12 — *"field with no policy row in a `pii` table
 * ⇒ treated as secret"* — and without the container it would be untestable, because a bare
 * property name carries no table.
 *
 * Outside a model instance (a plain log payload, a DTO, a `Map`) there is no container, and the
 * lookup is by name alone; an unmatched name returns `null` and the caller falls through to
 * T-014's key pattern. Defaulting *those* to `omit` would empty every log line in the process —
 * see the ladder discussion in `policy.service.ts`.
 *
 * A lookup that throws — the cache is unavailable — is always `omit` (TC-21), container or not.
 */
function resolvePolicyFor(
  key: string,
  policies: PolicyLookup,
  container: string | null,
): ResolvedPolicy | null {
  try {
    if (container !== null) return policies.resolveColumn(container, toSnakeCase(key));
    return policies.resolveFieldName(key);
  } catch {
    return FAIL_CLOSED_LOG_POLICY;
  }
}

/**
 * The schema-qualified table a value's properties belong to, or `null`.
 *
 * Duck-typed rather than `instanceof Model`, for the reason `@/common/crypto`'s barrel gives about
 * `CryptoModule`: importing `sequelize-typescript` here would drag the ORM into every unit test of
 * a pure string function. The two markers checked are the ones only a Sequelize model instance
 * has together — a `getDataValue` method on the instance and a `getTableName` static on its
 * constructor — and a value that merely *looks* like one is a value whose properties are, for
 * masking purposes, exactly what the duck test says they are.
 */
export function containerOf(value: object): string | null {
  const instance = value as { getDataValue?: unknown; constructor?: { getTableName?: unknown } };
  if (typeof instance.getDataValue !== 'function') return null;

  const getTableName = instance.constructor?.getTableName;
  if (typeof getTableName !== 'function') return null;

  try {
    const raw: unknown = (getTableName as () => unknown).call(instance.constructor);
    if (typeof raw === 'string') return raw;
    const parts = raw as { tableName?: string; schema?: string };
    if (typeof parts?.tableName !== 'string') return null;
    return parts.schema === undefined ? parts.tableName : `${parts.schema}.${parts.tableName}`;
  } catch {
    // A model whose table name cannot be read is treated as an ordinary object. It still gets the
    // name-based lookup and T-014's key pattern; it just loses the classification ladder.
    return null;
  }
}

/** The treatment applied when the policy cache cannot answer. Omit — never plain (TC-21). */
const FAIL_CLOSED_LOG_POLICY: ResolvedPolicy = Object.freeze({
  policyKey: null,
  source: 'fail_closed',
  classification: 'secret',
  atRest: 'none',
  blindIndex: false,
  inTransit: 'tls_only',
  logTreatment: 'omit',
  maskStrategy: 'full',
  uiVisibility: 'masked',
  revealRoles: Object.freeze([]),
  keyPurpose: null,
});

/**
 * An `Error` renders as name/message/stack plus its own properties, matching `redact.ts`.
 *
 * The stack stays: this goes to the server log, where the stack is the point. Keeping stacks out
 * of *responses* is `ErrorNormalizationFilter`'s job. The message is swept like any other string,
 * so an exception whose text quotes a token is still caught.
 */
function errorEntries(
  value: Error,
  depth: number,
  ancestors: WeakSet<object>,
  policies: PolicyLookup,
): Record<string, unknown> {
  return {
    name: value.name,
    message: value.message,
    stack: value.stack,
    ...entries(recordOf(value), depth, ancestors, policies, null),
  };
}

function mapToRecord(value: Map<unknown, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, item] of value.entries()) out[String(key)] = item;
  return out;
}

/**
 * Own enumerable properties, with a getter that throws rendered as `[UNREADABLE]`.
 *
 * Sequelize model instances, proxies and lazily-decrypted fields all expose accessors that can
 * throw, and a serialiser that propagates that turns "log this row" into a 500 — `redact.ts`
 * makes the same point about the same objects.
 */
function recordOf(value: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    try {
      out[key] = (value as Record<string, unknown>)[key];
    } catch {
      out[key] = '[UNREADABLE]';
    }
  }
  return out;
}

/** JSON, or a marker. Never throws — a cycle or a throwing `toJSON` must not fail a log line. */
function stableString(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return '[UNSERIALISABLE]';
  }
}

/**
 * Nothing is re-exported from this file.
 *
 * `redact`, `maskFull` and `UNDECRYPTABLE_SENTINEL` all belong to other modules and are already
 * reachable through `@/common/data-protection`'s barrel; forwarding them here as well would give
 * every one of them two import paths, and two import paths for one symbol is how a codebase ends
 * up with two subtly different ideas of what it means.
 */
