/**
 * T-047 — `config_hash` and `etag`.
 *
 * ### The bug this design is most likely to ship with
 *
 * 09-INTEGRATION.md §4c names it outright, and implementation note 10 repeats it:
 *
 * > **`etag = hash(config_hash + sorted(sections_returned))`.** Omitting the section set from the
 * > ETag lets a client that cached `BASIC` receive a 304 when asking for everything.
 *
 * That is TC-34, and it is the reason `etag` is computed here rather than being an alias for
 * `config_hash`. A client holding the etag of a `BASIC`-only response and then asking for every
 * section must get a full payload, because the two responses are different documents even though
 * the campaign did not change.
 *
 * ### Why the hash is canonical rather than "JSON.stringify of whatever we built"
 *
 * §11's shadow-traffic rollout depends on `config_hash` being *"stable and comparable so the
 * runtime team can log divergence"*: the runtime queries its current source and this service in
 * parallel and compares. A hash that changed with key insertion order — which is what plain
 * `JSON.stringify` gives, since object key order follows construction — would report divergence on
 * every call and make the whole exercise useless. So keys are sorted recursively, arrays keep their
 * order (their order is meaningful: `sequence_order`, binding id), and `undefined` is dropped so
 * that an absent optional and an explicitly-undefined one hash identically.
 *
 * Volatile fields never reach here: `served_at` is the wall clock, and `etag`/`config_hash`/
 * `not_modified` are derived. Including any of them would make the hash change on every call, or
 * depend on itself.
 */
import { createHash } from 'node:crypto';
import type { ConfigSectionName } from './grpc.constants';

/** Recursively key-sorted JSON. See the header for why this is not `JSON.stringify`. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalise(value));
}

function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value === null || typeof value !== 'object') return value === undefined ? null : value;
  if (value instanceof Date) return value.toISOString();

  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    if (source[key] === undefined) continue;
    result[key] = canonicalise(source[key]);
  }
  return result;
}

/** `sha256` of the canonical payload — the value the runtime compares across sources (§11). */
export function configHashOf(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
}

/**
 * `hash(config_hash + sorted(sections_returned))` — §4c, verbatim.
 *
 * The sections are sorted so that `[BASIC, REWARDS]` and `[REWARDS, BASIC]` produce one etag: the
 * response they describe is the same document, and a client that varied its request order would
 * otherwise never get a 304.
 */
export function etagOf(configHash: string, sections: readonly ConfigSectionName[]): string {
  const ordered = [...sections].sort().join(',');
  return createHash('sha256').update(`${configHash}|${ordered}`, 'utf8').digest('hex');
}
