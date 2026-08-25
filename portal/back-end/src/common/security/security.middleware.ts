/**
 * T-012 — the transport-level hardening that runs before any Nest routing: response headers,
 * HTTPS enforcement, proxy trust, body limits (02-SECURITY.md §6, §7).
 *
 * ---
 *
 * ### Why these headers are set by hand rather than by `helmet`
 *
 * A deliberate decision, and the first thing a reviewer should weigh.
 *
 * 02-SECURITY.md §7 specifies the policy as a `helmet({...})` call, and helmet is the right
 * default. It is not a workspace dependency, and this environment has no network access to add
 * one — the same constraint T-011 hit with JWT and T-016 with AES-GCM, resolved the same way
 * and flagged the same way. What helmet does for the five options §7 configures is set five
 * static response headers; there is no cryptography, no parsing and no request-dependent logic
 * in that path. {@link buildSecurityHeaders} is that mapping, written out, with the §7 config
 * block quoted directly above the constants it produces (`security.constants.ts`).
 *
 * Two properties make this a safe substitution rather than a shortcut:
 *
 *  - **The output is asserted, not assumed.** `security.middleware.spec.ts` checks every header
 *    §7 names, checks the exact CSP directive set, and checks that neither unsafe-* source
 *    expression appears anywhere in it (they are spelled out in `test/security/support/
 *    csp-tokens.ts`, deliberately not in `src`). Those tests are equally valid against helmet,
 *    so swapping helmet in later is a one-function change the existing suite already verifies.
 *  - **It is smaller than its configuration.** Every header here is a constant. Nothing is
 *    conditional except `connect-src`, which can only narrow.
 *
 * What is *not* reproduced is helmet's other defaults (`Origin-Agent-Cluster`,
 * `Cross-Origin-*`, `X-DNS-Prefetch-Control`, …). §7 enumerates the policy this system wants
 * and those are not in it; adding headers the design does not call for — particularly the
 * `Cross-Origin-Resource-Policy` family, which interacts with the CORS configuration next door
 * — would be a design change smuggled in as an implementation detail. Noted in the completion
 * report so the architect can ask for them explicitly if they are wanted.
 *
 * ---
 *
 * ### Order, and why it is this order
 *
 * `configureHttpSecurity` registers, in sequence: proxy trust → security headers → HTTPS
 * redirect → CORS → body parsers → parser error shaping. Everything here precedes Nest's
 * router, and therefore precedes every guard, which is what makes TC-17's "redirected to HTTPS
 * *before any auth logic*" structurally true rather than a matter of guard ordering.
 *
 * Headers are set before the redirect so that even a 307 to HTTPS carries the full header set.
 * CORS comes after the redirect so a plaintext preflight is answered with a redirect rather
 * than with permission.
 */
import { Logger, type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import { buildCorsOptions, parseAllowedOrigins } from './cors.config';
import {
  BODY_LIMIT,
  CONTENT_TYPE_OPTIONS,
  CSP_DIRECTIVES,
  FRAME_OPTIONS,
  HSTS_HEADER_VALUE,
  REFERRER_POLICY,
  SECURITY_ERROR_CODE,
} from './security.constants';
import { securityErrorBody } from './security.exceptions';

const logger = new Logger('HttpSecurity');

/** Everything `configureHttpSecurity` needs, resolved from the environment by the caller. */
export interface HttpSecurityOptions {
  /** The API's own public origin, added to `connect-src`. Empty string when unconfigured. */
  readonly apiOrigin: string;
  /** Raw `CORS_ALLOWED_ORIGINS`, parsed here so a malformed value fails at boot. */
  readonly corsAllowedOrigins: string | undefined;
  /** Raw `TRUST_PROXY`. See {@link resolveTrustProxy} for the accepted forms. */
  readonly trustProxy: string | undefined;
  /** Whether plaintext HTTP is redirected. True only in production (see below). */
  readonly enforceHttps: boolean;
}

/**
 * A host that could plausibly be one of ours: letters, digits, dots, hyphens, an optional port,
 * or a bracketed IPv6 literal. Deliberately strict — this value is interpolated into a
 * `Location` header, and a header containing CR or LF is a response-splitting vulnerability.
 */
const SAFE_HOST = /^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::[0-9]{1,5})?$/;

/**
 * Builds the response header set from 02-SECURITY.md §7.
 *
 * Pure and exported so the policy can be asserted as data, without a server (TC-1, TC-3).
 */
export function buildSecurityHeaders(apiOrigin: string): Record<string, string> {
  return {
    'Content-Security-Policy': buildCspHeader(apiOrigin),
    'Strict-Transport-Security': HSTS_HEADER_VALUE,
    'X-Frame-Options': FRAME_OPTIONS,
    'X-Content-Type-Options': CONTENT_TYPE_OPTIONS,
    'Referrer-Policy': REFERRER_POLICY,
  };
}

/**
 * Serialises {@link CSP_DIRECTIVES}, adding the API origin to `connect-src` when one is
 * configured.
 *
 * The origin is validated before it is used: an unvalidated value here would let a malformed
 * env var inject a directive (a `;` in the string) and silently rewrite the whole policy. An
 * invalid value is dropped with a warning rather than throwing, because the result of dropping
 * it is a *stricter* policy — the opposite of the usual "fail closed means fail loudly" case,
 * where the risk is under-restriction. It is still logged, because a dropped API origin means
 * the SPA cannot call the API and somebody needs to know why.
 */
export function buildCspHeader(apiOrigin: string): string {
  const extraConnectSrc = isUsableCspSource(apiOrigin) ? [apiOrigin] : [];
  if (apiOrigin.length > 0 && extraConnectSrc.length === 0) {
    logger.warn(
      `API_ORIGIN "${apiOrigin}" is not a usable CSP source and was omitted from connect-src.`,
    );
  }

  return Object.entries(CSP_DIRECTIVES)
    .map(([directive, sources]) => {
      const values = directive === 'connect-src' ? [...sources, ...extraConnectSrc] : sources;
      return values.length === 0 ? directive : `${directive} ${values.join(' ')}`;
    })
    .join('; ');
}

/** An absolute `scheme://host[:port]` and nothing else — no `;`, no whitespace, no path. */
function isUsableCspSource(value: string): boolean {
  return /^https?:\/\/[a-z0-9.-]+(:[0-9]{1,5})?$/i.test(value);
}

/**
 * Sets the §7 header set on every response, including error responses and redirects.
 *
 * Exported for direct unit testing; registered by {@link configureHttpSecurity}.
 */
export function securityHeadersMiddleware(apiOrigin: string) {
  const headers = buildSecurityHeaders(apiOrigin);

  return (_request: Request, response: Response, next: NextFunction): void => {
    for (const [name, value] of Object.entries(headers)) {
      response.setHeader(name, value);
    }
    // Belt and braces with `app.disable('x-powered-by')` in `configureHttpSecurity`: if a
    // future middleware or proxy re-adds it, this removes it again on the way out (TC-2).
    response.removeHeader('X-Powered-By');
    next();
  };
}

/**
 * Redirects plaintext requests to HTTPS before anything else runs (TC-17).
 *
 * ### 307, not 301
 *
 * A permanent redirect is cacheable by any intermediary, and the target is derived in part from
 * the request's own `Host` header. A poisoned cache entry pointing at an attacker's host would
 * outlive the request that created it. 307 is temporary and method-preserving: a POST stays a
 * POST, so a client that follows it does not silently downgrade to GET and lose its body.
 *
 * ### Where the target host comes from
 *
 * `API_ORIGIN` when it is configured, and only then the request's `Host` header. `Host` is
 * client-controlled, so it is validated against {@link SAFE_HOST} before being interpolated —
 * a `Host` containing CR/LF is a response-splitting attempt and is answered 400, not redirected.
 * Note that a forged host only ever misdirects the forger's own request; there is no victim.
 * It is validated anyway, because "the only person harmed is the attacker" is an argument that
 * stops being true the moment a proxy caches the response.
 */
export function httpsRedirectMiddleware(apiOrigin: string) {
  const configuredHost = isUsableCspSource(apiOrigin) ? new URL(apiOrigin).host : null;

  return (request: Request, response: Response, next: NextFunction): void => {
    // `req.protocol` honours `X-Forwarded-Proto` only when `trust proxy` says the hop is
    // trusted — which is why proxy trust is configured from an allowlist, never `true`.
    if (request.protocol === 'https') {
      next();
      return;
    }

    const host = configuredHost ?? request.headers.host;
    if (host === undefined || !SAFE_HOST.test(host)) {
      response.status(400).json(securityErrorBody(SECURITY_ERROR_CODE.MALFORMED_BODY));
      return;
    }

    response.redirect(307, `https://${host}${request.originalUrl}`);
  };
}

/**
 * Shapes body-parser failures into the documented error envelope.
 *
 * Without this, a 2 MB body (TC-16) is answered by Express's default error handler, which
 * outside production includes a **stack trace** in the response body. That is an information
 * leak on a route reachable without authentication, and it would also be the one error in the
 * system not matching 03-API-CONTRACT.md §1's envelope.
 *
 * Registered immediately after the parsers, so it sees their errors. Errors raised later, in a
 * controller, never reach here — Nest's own exception layer handles those, and T-014's
 * `ErrorNormalisationFilter` will own their shape.
 */
export function bodyParserErrorMiddleware() {
  return (
    error: NodeJS.ErrnoException & { status?: number; type?: string },
    _request: Request,
    response: Response,
    next: NextFunction,
  ): void => {
    if (response.headersSent) {
      next(error);
      return;
    }

    if (error.type === 'entity.too.large') {
      response.status(413).json(securityErrorBody(SECURITY_ERROR_CODE.PAYLOAD_TOO_LARGE));
      return;
    }

    if (typeof error.status === 'number' && error.status >= 400 && error.status < 500) {
      // Malformed JSON, unsupported charset, bad content-encoding — all client errors, none of
      // which may echo the parser's message (it can quote a fragment of the body).
      response.status(400).json(securityErrorBody(SECURITY_ERROR_CODE.MALFORMED_BODY));
      return;
    }

    next(error);
  };
}

/**
 * Turns `TRUST_PROXY` into the value handed to Express's `trust proxy` setting.
 *
 * **`true` is rejected outright.** Express's `trust proxy: true` trusts the `X-Forwarded-For`
 * of *any* client, which makes `request.ip` — the key half of two rate limits and the value
 * written to `portal_login_attempts` — trivially forgeable, and would let one attacker present
 * as an unlimited number of source addresses. An operator who wants "trust everything" has to
 * be told no; an operator who genuinely has a proxy names it, or says `loopback`.
 *
 * Absent or empty means `false`: the socket address is used, which cannot be forged at all.
 * That is the correct default for a process reachable directly, and the safe default for one
 * behind an unconfigured proxy — where the cost is over-counting several users as one IP
 * (limits bite too early, a nuisance) rather than under-counting an attacker as many (limits
 * never bite, a vulnerability).
 */
export function resolveTrustProxy(raw: string | undefined): string | number | boolean {
  const value = raw?.trim() ?? '';
  if (value.length === 0 || value.toLowerCase() === 'false') return false;

  if (value.toLowerCase() === 'true') {
    throw new Error(
      'TRUST_PROXY=true would trust the X-Forwarded-For of every client, making request.ip ' +
        'forgeable and the per-IP rate limits meaningless. Name the proxy addresses, a CIDR ' +
        'range, "loopback", or a hop count instead (02-SECURITY.md §8).',
    );
  }

  // A hop count — "trust the Nth-from-last proxy" — is the form a load balancer usually wants.
  if (/^\d+$/.test(value)) return Number(value);

  // Otherwise an address list/CIDR/named subnet, passed through to Express verbatim.
  return value;
}

/**
 * Registers the whole transport layer on the application. Called once, from `main.ts`.
 *
 * Idempotent it is not, and it is not meant to be: `main.ts` calls it exactly once, and the
 * tests build a fresh application per case.
 */
export function configureHttpSecurity(
  app: NestExpressApplication,
  options: HttpSecurityOptions,
): void {
  // Parsed first so a malformed allowlist stops the boot before a port is opened.
  const allowedOrigins = parseAllowedOrigins(options.corsAllowedOrigins);

  app.set('trust proxy', resolveTrustProxy(options.trustProxy));
  app.disable('x-powered-by');

  app.use(securityHeadersMiddleware(options.apiOrigin));
  if (options.enforceHttps) {
    app.use(httpsRedirectMiddleware(options.apiOrigin));
  }

  app.enableCors(buildCorsOptions(allowedOrigins));

  // Registered before Nest's own parsers, which then skip: `body-parser` marks a parsed request
  // and returns early on a second pass, and Nest's adapter additionally detects that a parser
  // of the same name is already on the stack. Either way, 1 MB is the effective limit, not the
  // framework default of 100 kB.
  app.useBodyParser('json', { limit: BODY_LIMIT });
  app.useBodyParser('urlencoded', { limit: BODY_LIMIT, extended: false });
  app.use(bodyParserErrorMiddleware());

  logger.log(
    `HTTP security configured (cors=${allowedOrigins.length} origin(s), ` +
      `https=${options.enforceHttps ? 'enforced' : 'not enforced'}, ` +
      `trustProxy=${String(resolveTrustProxy(options.trustProxy))})`,
  );
}

/**
 * Narrowing helper for callers holding a plain {@link INestApplication}.
 *
 * `configureHttpSecurity` needs the Express-specific surface (`set`, `useBodyParser`). Rather
 * than casting at each call site — which would hide a genuine platform mismatch until runtime —
 * this checks for the methods it is about to use and fails immediately if the application is
 * not Express-backed.
 */
export function asExpressApplication(app: INestApplication): NestExpressApplication {
  const candidate = app as NestExpressApplication;
  if (typeof candidate.useBodyParser !== 'function' || typeof candidate.set !== 'function') {
    throw new Error('configureHttpSecurity requires an Express-backed Nest application.');
  }
  return candidate;
}
