/**
 * T-003 — helper for `reward_config` columns that store JSON inside a `text`/`varchar`
 * column rather than a genuine `jsonb` column (01-DATABASE.md §6, implementation note 3:
 * "these tables predate the portal"). Every model with such a column exposes it as a typed
 * getter/setter pair built on these two functions, never a raw string, and **never throws**
 * on malformed content — one bad legacy row must not break a whole list endpoint (T-003
 * TC-8). `role_entity_permissions.actions` is the `varchar(500)`-holding-a-JSON-array
 * variant called out separately in implementation note 4; it uses the same helpers.
 */

/**
 * Parses `raw` as JSON, returning `fallback` for `null`/`undefined`/empty string, malformed
 * JSON, or a value whose shape doesn't survive a defensive `??` (e.g. `JSON.parse('null')`).
 * Deliberately swallows the parse error rather than rethrowing — see the file doc comment.
 */
export function parseJsonColumn<T>(raw: unknown, fallback: T): T {
  if (raw === null || raw === undefined || raw === '') {
    return fallback;
  }
  if (typeof raw !== 'string') {
    // Already-parsed (e.g. a genuine jsonb column reusing this helper) — pass through.
    return raw as T;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed === null || parsed === undefined ? fallback : (parsed as T);
  } catch {
    return fallback;
  }
}

/** Inverse of {@link parseJsonColumn}. `null`/`undefined` round-trip to SQL `NULL` rather
 * than the strings `"null"`/`"undefined"`. */
export function stringifyJsonColumn(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return JSON.stringify(value);
}
