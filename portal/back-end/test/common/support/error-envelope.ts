/**
 * T-014 shared e2e support — asserting the error envelope 03-API-CONTRACT.md §1 defines.
 *
 * ### Why this exists, and why it edits three other tasks' suites
 *
 * T-011, T-012 and T-013 each shipped `HttpException`s that build `{ error: { code } }`
 * themselves, because `ErrorNormalizationFilter` did not exist yet. All three said, in their own
 * file headers, what would happen when it arrived — `auth.exceptions.ts` puts it plainest:
 *
 * > *"When T-014's filter arrives it will recognise these as `HttpException`s carrying a
 * > well-formed body and pass the code through; the `message` and `traceId` fields it adds are
 * > **additive**."*
 *
 * That is exactly what happened, and it is what 03-API-CONTRACT.md §1 requires: every error body
 * carries `code`, `message` and `traceId`. The three e2e suites asserted with `toEqual`, which is
 * strict, so each of them now fails on the two *added* fields — a test that was correct when it
 * was written and describes a body the contract no longer permits. This helper replaces those
 * assertions with ones that check the **whole documented envelope** rather than merely a subset:
 * the code, the presence and type of `message` and `traceId`, and that there is no fifth field.
 *
 * That last clause matters. Replacing `toEqual` with `toMatchObject` would have been a one-word
 * change and would have quietly stopped checking the thing those tests were really for — that a
 * 403 body carries *nothing else*. `expectErrorEnvelope` keeps that guarantee.
 */

/** The only keys an error body may contain (03-API-CONTRACT.md §1). */
const ALLOWED_KEYS = ['code', 'message', 'details', 'traceId'];

interface ErrorEnvelopeBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
    traceId: string;
  };
}

/**
 * Asserts `body` is exactly the documented error envelope for `code`.
 *
 * Checks, in order: the top level has one key, `error`; the code is the expected one; `message`
 * is a non-empty string (the `system_messages` text, or the key itself when unseeded); `traceId`
 * is a well-formed correlation id; and no key outside {@link ALLOWED_KEYS} is present.
 */
export function expectErrorEnvelope(body: unknown, code: string): void {
  expect(Object.keys(body as object)).toEqual(['error']);

  const { error } = body as ErrorEnvelopeBody;
  expect(error.code).toBe(code);
  expect(typeof error.message).toBe('string');
  expect(error.message.length).toBeGreaterThan(0);
  expect(error.traceId).toMatch(/^[A-Za-z0-9_-]{8,64}$/);

  for (const key of Object.keys(error)) {
    expect(ALLOWED_KEYS).toContain(key);
  }
}

/**
 * The body with its `traceId` removed, for comparing two responses to each other.
 *
 * `traceId` is per-request by construction — two *identical* requests get different values — so
 * it carries no information about the resource being probed and cannot be the thing that makes
 * "not found" distinguishable from "out of scope" (02-SECURITY.md §5.1). Comparing without it is
 * the honest form of that assertion; comparing with it would fail for two requests to the same
 * missing id.
 */
export function withoutTraceId(body: unknown): unknown {
  const { error } = body as ErrorEnvelopeBody;
  if (error === undefined) return body;
  const rest: Record<string, unknown> = { ...error };
  delete rest.traceId;
  return { error: rest };
}
