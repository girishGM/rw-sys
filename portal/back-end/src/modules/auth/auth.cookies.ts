/**
 * T-011 — cookie construction and parsing, in one file so the exact attribute string that
 * reaches the browser is reviewable in isolation (02-SECURITY.md §1, T-011 TC-1…TC-4).
 *
 * ### Why the `Set-Cookie` header is built by hand
 *
 * Express's `res.cookie()` would do this too, but the attributes here *are* the security
 * control, and a helper that silently normalises them is a helper that can silently drop one.
 * Building the string means the header a reviewer reads in this file is byte-for-byte the
 * header the browser receives, and it means `clearCookie` can be guaranteed to emit the same
 * attributes as `setCookie` — a cookie cleared with different `Path`/`Secure`/`SameSite`
 * attributes is **not cleared**, it is shadowed, and the original stays in the jar (T-011
 * implementation note 9). That is a real, frequently-shipped logout bug.
 *
 * ### Why the cookies are parsed by hand
 *
 * The alternative is the `cookie-parser` middleware, which would have to be registered in
 * `main.ts` — a file this task only appends a single registration line to — and which would
 * put every request's cookies on `req.cookies` for every consumer, including ones that have no
 * business reading a session cookie. {@link readCookie} reads exactly one named cookie from
 * the raw header, at the two call sites that need one, and nothing else in the process ever
 * sees the rest. It is about twenty lines and removes a dependency from the auth hot path.
 *
 * **`Secure` is unconditional.** Not "in production", not "unless NODE_ENV is development" —
 * always. T-011 implementation note 1 is explicit: browsers accept `Secure` on `localhost`, so
 * developing over HTTPS locally costs nothing, while a `Secure`-less dev path means the
 * production cookie behaviour is never actually exercised until production.
 */
import {
  ACCESS_COOKIE_NAME,
  ACCESS_TOKEN_TTL_SECONDS,
  CSRF_COOKIE_NAME,
  REFRESH_COOKIE_NAME,
  REFRESH_TOKEN_TTL_SECONDS,
  ROOT_COOKIE_PATH,
} from './session.constants';

/** The attributes of one cookie. Every field is required — there are no implicit defaults. */
export interface CookieDefinition {
  readonly name: string;
  readonly path: string;
  readonly httpOnly: boolean;
  readonly maxAgeSeconds: number;
}

/**
 * The three cookies, exactly as 02-SECURITY.md §1 specifies them.
 *
 * `secure` and `sameSite` are not fields because they are not choices: every cookie this
 * module emits is `Secure; SameSite=Strict`, and making them configurable would invite exactly
 * the per-environment weakening note 1 forbids.
 */
export const ACCESS_COOKIE: CookieDefinition = Object.freeze({
  name: ACCESS_COOKIE_NAME,
  path: ROOT_COOKIE_PATH,
  httpOnly: true,
  maxAgeSeconds: ACCESS_TOKEN_TTL_SECONDS,
});

export const REFRESH_COOKIE: CookieDefinition = Object.freeze({
  name: REFRESH_COOKIE_NAME,
  // `/`, and it cannot be anything else: this cookie is `__Host-`-prefixed, and a `__Host-`
  // cookie with a narrower path is rejected by the browser rather than stored (T-058). See
  // ROOT_COOKIE_PATH in session.constants.ts for the full reasoning before changing this.
  path: ROOT_COOKIE_PATH,
  httpOnly: true,
  maxAgeSeconds: REFRESH_TOKEN_TTL_SECONDS,
});

export const CSRF_COOKIE: CookieDefinition = Object.freeze({
  name: CSRF_COOKIE_NAME,
  path: ROOT_COOKIE_PATH,
  // Deliberately readable by JavaScript — the SPA mirrors it into `X-CSRF-Token`.
  httpOnly: false,
  maxAgeSeconds: REFRESH_TOKEN_TTL_SECONDS,
});

/** All three, for the paths that set or clear the whole set at once. */
export const ALL_AUTH_COOKIES: readonly CookieDefinition[] = Object.freeze([
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  CSRF_COOKIE,
]);

/**
 * Builds one `Set-Cookie` header value.
 *
 * The attribute order matches the order 02-SECURITY.md §1 lists them in, which is also the
 * order the task file's TC-2/TC-3/TC-4 quote. Attribute order carries no meaning to a browser;
 * it carries a lot of meaning to the person diffing this against the spec.
 */
export function buildSetCookie(cookie: CookieDefinition, value: string): string {
  const parts = [`${cookie.name}=${encodeURIComponent(value)}`];
  if (cookie.httpOnly) parts.push('HttpOnly');
  parts.push('Secure');
  parts.push('SameSite=Strict');
  parts.push(`Path=${cookie.path}`);
  parts.push(`Max-Age=${cookie.maxAgeSeconds}`);
  // No `Domain` attribute, ever: `__Host-` cookies are rejected by the browser if one is
  // present, and a `Domain` on the CSRF cookie would widen it to every sibling subdomain.
  return parts.join('; ');
}

/**
 * Builds the `Set-Cookie` header that removes a cookie.
 *
 * Identical attributes to {@link buildSetCookie}, an empty value, `Max-Age=0` **and** an
 * `Expires` in the past — the pair covers both the modern and the legacy expiry mechanism, and
 * costs nothing. Because this reuses the same {@link CookieDefinition}, the "cleared with
 * different attributes" bug is structurally impossible: there is only one place the `Path` of
 * the refresh cookie is written down.
 */
export function buildClearCookie(cookie: CookieDefinition): string {
  const parts = [`${cookie.name}=`];
  if (cookie.httpOnly) parts.push('HttpOnly');
  parts.push('Secure');
  parts.push('SameSite=Strict');
  parts.push(`Path=${cookie.path}`);
  parts.push('Max-Age=0');
  parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  return parts.join('; ');
}

/**
 * Reads one named cookie out of a raw `Cookie` request header.
 *
 * Returns `null` for absent, empty or malformed entries rather than throwing — a caller that
 * gets `null` treats the request as unauthenticated, which is the correct handling of a
 * garbled header and is what an attacker sending one deserves. The **first** occurrence wins:
 * duplicate cookie names are legal on the wire (a `__Host-` cookie and a same-named
 * `Domain`-scoped one from a subdomain, for instance), and taking the first is the same rule
 * browsers apply, so a request-splitting attempt cannot shadow a legitimate value by appending.
 */
export function readCookie(header: string | undefined, name: string): string | null {
  if (header === undefined || header.length === 0) return null;

  for (const segment of header.split(';')) {
    const separator = segment.indexOf('=');
    if (separator === -1) continue;

    const key = segment.slice(0, separator).trim();
    if (key !== name) continue;

    const raw = segment.slice(separator + 1).trim();
    if (raw.length === 0) return null;

    try {
      return decodeURIComponent(raw);
    } catch {
      // A `%` that is not a valid escape sequence. Malformed input, not a cookie.
      return null;
    }
  }

  return null;
}
