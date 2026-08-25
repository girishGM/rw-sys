/**
 * T-012 — CORS, built from an exact origin allowlist (02-SECURITY.md §7, implementation note 2).
 *
 * ### The two things this file must never do
 *
 * **Never `origin: true`, and never `'*'`.** Both are banned by name in §7 and by T-012's
 * implementation note 2, and the reason is worth restating because `origin: true` looks
 * innocuous: it echoes whatever `Origin` the caller sent, which — combined with
 * `credentials: true` — means *every* site on the internet is a permitted origin for
 * credentialed requests. A literal `*` with credentials is rejected outright by browsers, which
 * at least fails loudly; `origin: true` fails silently and permissively, which is worse. TC-6
 * greps this file's own source for both forms, so the ban is enforced by a test rather than by
 * this comment.
 *
 * **Never widen on a parse failure.** A malformed allowlist entry throws at boot rather than
 * being skipped. A skipped entry cannot widen the policy, but it can silently narrow it in a
 * way that looks like an application bug at 3am; and an operator who typed one entry wrongly
 * has probably typed others wrongly too. Fail loudly, once, at boot — the same posture
 * `env.schema.ts` takes for a missing secret.
 *
 * ### Unknown origins get no headers, not an error
 *
 * `callback(null, false)` omits `Access-Control-Allow-Origin` entirely (TC-5). The alternative,
 * `callback(new Error(...))`, produces a 500 — which is both a worse experience for a
 * misconfigured legitimate client and a free oracle for an attacker enumerating the allowlist,
 * since a 500 and a 204 are trivially distinguishable. Absent headers are the correct answer:
 * the browser then refuses to expose the response, which is exactly what CORS is for.
 *
 * A request with **no** `Origin` header at all — same-origin XHR, `curl`, a health probe — also
 * takes the `false` branch. That is not a rejection: CORS response headers are meaningless to a
 * non-CORS request, and the request proceeds normally through the rest of the chain.
 */
import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';
import {
  CORS_ALLOWED_HEADERS,
  CORS_ALLOWED_METHODS,
  CORS_MAX_AGE_SECONDS,
} from './security.constants';

/**
 * An absolute origin and nothing more: scheme, host, optional port. No path (not even `/`), no
 * query, no fragment, no userinfo, no wildcard. Anything else is a configuration error.
 */
const ORIGIN_PATTERN = /^https?:\/\/[a-z0-9.-]+(:[0-9]{1,5})?$/;

/** Raised at boot for an unusable `CORS_ALLOWED_ORIGINS`. Never reachable from a request. */
export class CorsConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CorsConfigurationError';
    Error.captureStackTrace?.(this, CorsConfigurationError);
  }
}

/**
 * Parses `CORS_ALLOWED_ORIGINS` (comma-separated) into a normalised, frozen allowlist.
 *
 * Empty input yields an empty allowlist, which permits no cross-origin request at all. That is
 * the fail-closed default and is deliberately what an unconfigured deployment gets: same-origin
 * traffic is unaffected, and a cross-origin SPA fails visibly in the browser console rather
 * than a wildcard quietly letting everyone in.
 */
export function parseAllowedOrigins(raw: string | undefined): readonly string[] {
  if (raw === undefined) return Object.freeze([]);

  const entries = raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);

  for (const entry of entries) {
    if (entry === '*') {
      throw new CorsConfigurationError(
        'CORS_ALLOWED_ORIGINS may not contain "*": a wildcard origin with credentials is ' +
          'invalid and, where browsers tolerate variants of it, a leak (02-SECURITY.md §7).',
      );
    }
    if (!ORIGIN_PATTERN.test(entry)) {
      throw new CorsConfigurationError(
        `CORS_ALLOWED_ORIGINS entry "${entry}" is not an absolute origin ` +
          '(expected scheme://host[:port], with no trailing slash or path).',
      );
    }
  }

  return Object.freeze([...new Set(entries)]);
}

/**
 * Builds the `CorsOptions` handed to `app.enableCors()`.
 *
 * `credentials: true` is required — the whole session design is cookie-borne, and a
 * credential-less CORS policy would make the SPA unable to authenticate at all. It is also
 * precisely why the origin check has to be an exact-match allowlist and nothing looser.
 */
export function buildCorsOptions(allowedOrigins: readonly string[]): CorsOptions {
  const allowlist = new Set(allowedOrigins);

  return {
    origin: (requestOrigin, callback) => {
      // `requestOrigin` is `undefined` for a same-origin or non-browser request.
      if (requestOrigin === undefined) {
        callback(null, false);
        return;
      }
      // Echo the exact origin back, never a wildcard, and only if it is on the list.
      callback(null, allowlist.has(requestOrigin.toLowerCase()));
    },
    credentials: true,
    methods: [...CORS_ALLOWED_METHODS],
    allowedHeaders: [...CORS_ALLOWED_HEADERS],
    // Nothing is exposed to script: the SPA reads response *bodies*, never response headers.
    exposedHeaders: [],
    maxAge: CORS_MAX_AGE_SECONDS,
    // 204, so a preflight never carries a body a proxy might cache or a client might parse.
    optionsSuccessStatus: 204,
  };
}
