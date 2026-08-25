/**
 * T-014 — the masking serialiser (implementation note 6, 02-SECURITY.md §9).
 *
 * > *"`redact()` runs at the logger serialiser level (not at call sites) over keys matching
 * > `/password|token|secret|hash|authorization|cookie|key_hash|mfa/i` at any depth."*
 *
 * ### Why the key list is a pattern and not an allow-list of exact names
 *
 * The alternative design — "redact the fields we know about" — fails the moment somebody adds
 * `refreshTokenHash`, `mfa_secret_enc` or `newPassword` to a payload, which is exactly the
 * moment it matters. A substring pattern is deliberately over-broad: it will mask
 * `hashAlgorithm` and `mfaEnabled`, neither of which is a secret, and that is the correct
 * trade. A log line that says `[REDACTED]` where it could have said `argon2id` costs an
 * operator ten seconds; a log line that prints a refresh-token hash costs a session.
 *
 * ### Why it is applied at the serialiser, not at the call site
 *
 * 02-SECURITY.md §9 states the reason in six words: call sites *"get forgotten"*. The rule this
 * file supports is that **no caller decides** whether its payload is sensitive — the writer
 * does, uniformly, for every line. `redactSerialiser` is the function a logger transport
 * installs once; T-019/T-052 own the winston wiring and must install it there (see that
 * function's own comment). Until they do, the two components this task ships — `AuditService`
 * and `ErrorNormalizationFilter` — route everything they log through {@link redactForLog}
 * themselves, so nothing this task writes is unredacted in the meantime.
 *
 * ### Structural guarantees
 *
 *  - **Pure.** The input object is never mutated; a redacted copy is returned. Redaction that
 *    mutated its argument would corrupt the very object the application is still using — the
 *    audit `detail` that follows a log line, for instance.
 *  - **Total.** No input throws. A serialiser that can throw turns a logging call into a 500,
 *    which is a strictly worse failure than a badly-rendered log line. Cycles, `Buffer`s,
 *    getters that throw, `Map`/`Set`, class instances and depth are all handled explicitly.
 *  - **Depth-bounded.** A deeply nested or self-referential structure renders as
 *    `[TRUNCATED]`/`[CIRCULAR]` rather than exhausting the stack.
 */

/** The replacement for every value under a sensitive key. A constant so tests assert one thing. */
export const REDACTED = '[REDACTED]';

/** Rendered in place of a value nested deeper than {@link MAX_REDACTION_DEPTH}. */
export const TRUNCATED = '[TRUNCATED]';

/** Rendered in place of a value that references one of its own ancestors. */
export const CIRCULAR = '[CIRCULAR]';

/** Rendered in place of any binary blob — key material and ciphertext both live in `Buffer`s. */
export const BINARY = '[BINARY]';

/**
 * The key pattern, verbatim from T-014 implementation note 6.
 *
 * `key_hash` is redundant with `hash` and is kept because the note names it: the design docs
 * are what a reviewer diffs this against, and a pattern that is a superset of the specified one
 * is harder to check than one that contains it literally.
 */
export const SENSITIVE_KEY_PATTERN =
  /password|token|secret|hash|authorization|cookie|key_hash|mfa/i;

/**
 * How deep the walk goes before it stops describing and starts truncating.
 *
 * 12 is far beyond any payload this application produces (the deepest is a campaign wizard
 * draft at ~6) and is a bound on work per log line, not a feature.
 */
export const MAX_REDACTION_DEPTH = 12;

/** Whether a property name matches the sensitive-key pattern. Exported for tests and for T-017. */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

/**
 * A redacted deep copy of `value`.
 *
 * Every property whose **name** matches {@link SENSITIVE_KEY_PATTERN}, at any depth and inside
 * arrays, is replaced by {@link REDACTED} — regardless of the value's type, so masking an object
 * does not leak its children (`{ mfa: { secret: 'x' } }` becomes `{ mfa: '[REDACTED]' }`).
 *
 * Values are **not** inspected. A password that arrives under the key `note` is not detected and
 * is not redacted; that is a property of key-based masking, not a bug in this function, and it
 * is why the audit path additionally never reads a request body (see `audit.service.ts`).
 */
export function redact(value: unknown): unknown {
  return walk(value, 0, new WeakSet<object>());
}

/**
 * {@link redact}, typed for the common case of an object-shaped log payload.
 *
 * The cast is the one place this file asserts something the type system cannot check: the walk
 * preserves the shape of a plain object, so the redacted copy is assignable to the input type
 * even though individual leaf types may have become `string`. Callers get ergonomics; the check
 * is confined to one line, with this comment on it, rather than repeated at every call site
 * (R8 — no `any`, and none is used: `unknown` is narrowed by the cast).
 */
export function redactForLog<T extends object>(value: T): T {
  return redact(value) as T;
}

/**
 * The serialiser form, shaped for a logging library's format pipeline.
 *
 * winston: `winston.format(redactSerialiser)()`. pino: `{ formatters: { log: redactSerialiser } }`.
 * **T-019/T-052 own the logger itself and must install this** — 02-SECURITY.md §9 requires
 * redaction "at the logger-serialiser level", and this task owns only the function, not the
 * transport it plugs into (`common/logging/redact.ts` is T-014's single file in that folder).
 */
export function redactSerialiser<T extends object>(info: T): T {
  return redactForLog(info);
}

// --- the walk ------------------------------------------------------------------------------

function walk(value: unknown, depth: number, ancestors: WeakSet<object>): unknown {
  if (depth > MAX_REDACTION_DEPTH) return TRUNCATED;
  if (value === null || typeof value !== 'object') return value;

  // `Buffer` before anything else: it is an object, it is iterable, and rendering its bytes
  // would print key material one integer at a time (`crypto.errors.ts` makes the same point).
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return BINARY;
  }

  // Dates carry no secret and lose their meaning if walked as an object (`{}`).
  if (value instanceof Date) return value;
  if (value instanceof RegExp) return value.toString();

  if (ancestors.has(value)) return CIRCULAR;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1, ancestors));
    if (value instanceof Set) return [...value].map((item) => walk(item, depth + 1, ancestors));
    if (value instanceof Map) return mapEntries(value, depth, ancestors);
    if (value instanceof Error) return redactError(value, depth, ancestors);
    return plainEntries(value, depth, ancestors);
  } finally {
    // Removed on the way back up so that a value referenced twice in *sibling* positions is
    // rendered twice, and only a genuine ancestor cycle reports `[CIRCULAR]`.
    ancestors.delete(value);
  }
}

function mapEntries(value: Map<unknown, unknown>, depth: number, ancestors: WeakSet<object>) {
  const out: Record<string, unknown> = {};
  for (const [key, item] of value.entries()) {
    const name = String(key);
    out[name] = isSensitiveKey(name) ? REDACTED : walk(item, depth + 1, ancestors);
  }
  return out;
}

/**
 * An `Error` renders as its name, message and stack — the three fields an operator needs — with
 * any custom properties (a Sequelize error's `sql`, `parameters`, `fields`) walked like anything
 * else, so a bind parameter called `password_hash` is masked there too.
 *
 * The stack stays. This function's output goes to the **server log**, where the stack is the
 * whole point; keeping stacks out of *responses* is `ErrorNormalizationFilter`'s job, and doing
 * it here as well would leave the operator with nothing (TC-8).
 */
function redactError(value: Error, depth: number, ancestors: WeakSet<object>) {
  const out: Record<string, unknown> = {
    name: value.name,
    message: value.message,
    stack: value.stack,
  };
  for (const [key, item] of Object.entries(value)) {
    out[key] = isSensitiveKey(key) ? REDACTED : walk(item, depth + 1, ancestors);
  }
  return out;
}

function plainEntries(value: object, depth: number, ancestors: WeakSet<object>) {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (isSensitiveKey(key)) {
      out[key] = REDACTED;
      continue;
    }
    out[key] = walk(readProperty(value, key), depth + 1, ancestors);
  }
  return out;
}

/**
 * Reads one property, tolerating a getter that throws.
 *
 * Sequelize model instances, proxies and lazily-decrypted fields (T-017) all expose accessors
 * that can throw — and a serialiser that propagates that turns "log this row" into a 500.
 */
function readProperty(value: object, key: string): unknown {
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return '[UNREADABLE]';
  }
}
