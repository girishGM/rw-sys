/**
 * T-017 — loading and validating `config/data-protection.json` (07-DATA-PROTECTION.md §10).
 *
 * ### The one rule this file exists to enforce
 *
 * **A broken configuration must not produce a permissive engine.** Every failure mode here —
 * file missing, file unreadable, invalid JSON, an unknown enum value, a negative rate limit —
 * resolves to {@link DEFAULT_DATA_PROTECTION_CONFIG}, whose values are the restrictive ones §10
 * specifies (`logging.defaultTreatment: "omit"`, `response.defaultVisibility: "masked"`,
 * `failClosed: true`). The alternative designs are both worse:
 *
 *  - *Throw and refuse to boot.* Tempting, and wrong for this particular file: it is declared
 *    hot-reloadable, so a bad edit at 3am would take the portal down rather than degrade it,
 *    and the degraded mode here is **more** protective than the intended one, not less.
 *  - *Merge whatever parsed and ignore the rest.* That is how `defaultTreatment: "plian"`
 *    becomes `plain` in someone's head and `undefined` at runtime.
 *
 * Every rejection is reported through the `onProblem` callback so it is loud, not silent — the
 * module logs each one at `warn` on boot and on every reload.
 *
 * ### Why this is not `@nestjs/config` / `env.schema.ts`
 *
 * `ConfigModule` covers *environment* variables, which are per-deployment and validated
 * fail-fast at boot (`validateEnv` calls `process.exit(1)`). This is a *policy* document that
 * ships with the repo, is edited by security reviewers rather than operators, and is reloadable
 * at runtime. Mixing the two would either make the policy file un-reloadable or make an
 * environment typo survivable, and both of those are the wrong trade in the wrong direction.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  LOG_TREATMENTS,
  UI_VISIBILITIES,
  type LogTreatment,
  type UiVisibility,
} from './data-protection.constants';

/**
 * DI token for the loaded {@link DataProtectionConfig}.
 *
 * A token rather than a class so the config is a *value* in the container: `DataProtectionModule`
 * loads it once with `useFactory`, and a test injects a literal object without touching the file
 * system. The same pattern as `THROTTLE_STORE` and `POLICY_STORE`.
 */
export const DATA_PROTECTION_CONFIG = Symbol('DATA_PROTECTION_CONFIG');

/** `transport.mode` and the values of `transport.routeOverrides` — §5. */
export const TRANSPORT_MODES = ['off', 'fields', 'full'] as const;
export type TransportMode = (typeof TRANSPORT_MODES)[number];

export interface DataProtectionConfig {
  /** Master switch. `false` is T-017's documented rollback: hooks, masking and reveal all stop. */
  readonly enabled: boolean;
  /** §10 — "no policy row for a sensitive-class table ⇒ treat as secret". */
  readonly failClosed: boolean;
  readonly transport: {
    readonly mode: TransportMode;
    /** Keyed `"<METHOD> <route>"`, normalised to single-spaced upper-case method — see below. */
    readonly routeOverrides: Readonly<Record<string, TransportMode>>;
  };
  readonly atRest: {
    readonly defaultAlgorithm: string;
    /** 07-DATA-PROTECTION.md §4. Turning this off is a security decision, not a tuning knob. */
    readonly bindRecordIdAsAAD: boolean;
  };
  readonly logging: {
    readonly defaultTreatment: LogTreatment;
    readonly finalRegexSweep: boolean;
  };
  readonly response: {
    readonly defaultVisibility: UiVisibility;
  };
  readonly reveal: {
    readonly enabled: boolean;
    readonly rateLimitPerHour: number;
    readonly requireReason: boolean;
  };
  readonly keys: {
    readonly rotationWarningDays: number;
  };
  readonly cache: {
    /** Policy-cache TTL (implementation note 8). `0` means "never expire; invalidate only". */
    readonly ttlSeconds: number;
  };
}

/**
 * The values used when the file is absent or a field is unusable.
 *
 * These are §10's own defaults verbatim, and they are the restrictive ones on purpose. Read the
 * file header before changing any value here: this object is what a misconfigured deployment
 * runs on, so it is the *floor* of the system's behaviour, not a convenience.
 */
export const DEFAULT_DATA_PROTECTION_CONFIG: DataProtectionConfig = Object.freeze({
  enabled: true,
  failClosed: true,
  transport: Object.freeze({ mode: 'fields' as TransportMode, routeOverrides: Object.freeze({}) }),
  atRest: Object.freeze({ defaultAlgorithm: 'aes_256_gcm', bindRecordIdAsAAD: true }),
  logging: Object.freeze({ defaultTreatment: 'omit' as LogTreatment, finalRegexSweep: true }),
  response: Object.freeze({ defaultVisibility: 'masked' as UiVisibility }),
  reveal: Object.freeze({ enabled: true, rateLimitPerHour: 30, requireReason: false }),
  keys: Object.freeze({ rotationWarningDays: 30 }),
  cache: Object.freeze({ ttlSeconds: 300 }),
});

/** Overrides the search below. Used by tests and by a deployment that keeps config elsewhere. */
export const CONFIG_PATH_ENV_VAR = 'DATA_PROTECTION_CONFIG';

/** Repo-relative location, from the workspace root (`portal/`). */
export const CONFIG_RELATIVE_PATH = join('config', 'data-protection.json');

/** How a caller is told about a rejected value. */
export interface ConfigProblem {
  readonly path: string;
  readonly reason: string;
}

export interface LoadConfigOptions {
  /** Explicit file path. Overrides {@link CONFIG_PATH_ENV_VAR} and the upward search. */
  readonly path?: string;
  /** Where the upward search starts. Defaults to this file's directory. */
  readonly from?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly onProblem?: (problem: ConfigProblem) => void;
}

export interface LoadedDataProtectionConfig {
  readonly config: DataProtectionConfig;
  /** `null` when no file was found and the built-in defaults are in force. */
  readonly path: string | null;
  readonly problems: readonly ConfigProblem[];
}

/**
 * Finds `config/data-protection.json` by walking up from `from`.
 *
 * The search exists because the file lives at the **workspace** root (`portal/config/…`) while
 * the process's working directory is the *package* root (`portal/back-end`) under `npm run`, the
 * repository root under some CI runners, and `dist/` after a build. Resolving against
 * `process.cwd()` would therefore work in exactly one of those and fail silently — into the
 * defaults — in the others, which is the kind of "it was fine locally" that this file's
 * fail-safe behaviour would otherwise hide.
 */
export function findConfigPath(from: string = __dirname): string | null {
  let dir = resolve(from);
  for (;;) {
    const candidate = join(dir, CONFIG_RELATIVE_PATH);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Reads, parses and validates the config. Never throws. */
export function loadDataProtectionConfig(
  options: LoadConfigOptions = {},
): LoadedDataProtectionConfig {
  const problems: ConfigProblem[] = [];
  const report = (path: string, reason: string): void => {
    const problem = { path, reason };
    problems.push(problem);
    options.onProblem?.(problem);
  };

  const env = options.env ?? process.env;
  const explicit = options.path ?? env[CONFIG_PATH_ENV_VAR];
  const path = explicit !== undefined && explicit !== '' ? explicit : findConfigPath(options.from);

  if (path === null) {
    report(CONFIG_RELATIVE_PATH, 'not found; built-in fail-closed defaults are in force');
    return { config: DEFAULT_DATA_PROTECTION_CONFIG, path: null, problems };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    report(path, `unreadable or not valid JSON (${(error as Error).message})`);
    return { config: DEFAULT_DATA_PROTECTION_CONFIG, path, problems };
  }

  return { config: parseDataProtectionConfig(raw, report), path, problems };
}

/**
 * Validates an already-parsed object. Exported so a test can drive every branch without a file,
 * and so a future hot-reload watcher can revalidate without re-reading from disk.
 */
export function parseDataProtectionConfig(
  raw: unknown,
  report: (path: string, reason: string) => void = () => undefined,
): DataProtectionConfig {
  const d = DEFAULT_DATA_PROTECTION_CONFIG;
  const root = asObject(raw);
  if (root === null) {
    report('$', 'top level is not an object');
    return d;
  }

  const transport = asObject(root.transport) ?? {};
  const atRest = asObject(root.atRest) ?? {};
  const logging = asObject(root.logging) ?? {};
  const response = asObject(root.response) ?? {};
  const reveal = asObject(root.reveal) ?? {};
  const keys = asObject(root.keys) ?? {};
  const cache = asObject(root.cache) ?? {};

  return Object.freeze({
    enabled: bool(root.enabled, d.enabled, 'enabled', report),
    failClosed: bool(root.failClosed, d.failClosed, 'failClosed', report),
    transport: Object.freeze({
      mode: oneOf(transport.mode, TRANSPORT_MODES, d.transport.mode, 'transport.mode', report),
      routeOverrides: routeOverrides(transport.routeOverrides, report),
    }),
    atRest: Object.freeze({
      defaultAlgorithm: str(
        atRest.defaultAlgorithm,
        d.atRest.defaultAlgorithm,
        'atRest.defaultAlgorithm',
        report,
      ),
      bindRecordIdAsAAD: bool(
        atRest.bindRecordIdAsAAD,
        d.atRest.bindRecordIdAsAAD,
        'atRest.bindRecordIdAsAAD',
        report,
      ),
    }),
    logging: Object.freeze({
      defaultTreatment: oneOf(
        logging.defaultTreatment,
        LOG_TREATMENTS,
        d.logging.defaultTreatment,
        'logging.defaultTreatment',
        report,
      ),
      finalRegexSweep: bool(
        logging.finalRegexSweep,
        d.logging.finalRegexSweep,
        'logging.finalRegexSweep',
        report,
      ),
    }),
    response: Object.freeze({
      defaultVisibility: oneOf(
        response.defaultVisibility,
        UI_VISIBILITIES,
        d.response.defaultVisibility,
        'response.defaultVisibility',
        report,
      ),
    }),
    reveal: Object.freeze({
      enabled: bool(reveal.enabled, d.reveal.enabled, 'reveal.enabled', report),
      rateLimitPerHour: positiveInt(
        reveal.rateLimitPerHour,
        d.reveal.rateLimitPerHour,
        'reveal.rateLimitPerHour',
        report,
      ),
      requireReason: bool(
        reveal.requireReason,
        d.reveal.requireReason,
        'reveal.requireReason',
        report,
      ),
    }),
    keys: Object.freeze({
      rotationWarningDays: positiveInt(
        keys.rotationWarningDays,
        d.keys.rotationWarningDays,
        'keys.rotationWarningDays',
        report,
      ),
    }),
    cache: Object.freeze({
      ttlSeconds: nonNegativeInt(cache.ttlSeconds, d.cache.ttlSeconds, 'cache.ttlSeconds', report),
    }),
  });
}

/**
 * The provider factory for {@link DATA_PROTECTION_CONFIG}: load once, report every problem.
 *
 * **It lives here, not in `data-protection.module.ts`, and that is not tidiness.** The module
 * file imports `DatabaseModule` → `ConfigModule`, whose `validate` runs `validateEnv` at *import*
 * time and calls `process.exit(1)` when the environment is incomplete — so anything defined in
 * that file is unreachable from a unit test, and a Jest worker that imports it dies outright
 * (observed, not theorised, while building this task's suite). Keeping the factory in this
 * import-free module is what makes "the operator is warned about a bad config" an assertion
 * rather than a hope. The same reasoning `@/common/crypto`'s barrel gives about `CryptoModule`.
 *
 * Never throws; see this file's header for why a bad policy file degrades rather than failing
 * the boot.
 */
export function dataProtectionConfigFactory(
  logger: { log: (message: string) => void; warn: (message: string) => void } = new ConsoleLogger(),
  options: Omit<LoadConfigOptions, 'onProblem'> = {},
): DataProtectionConfig {
  const loaded = loadDataProtectionConfig({
    ...options,
    onProblem: (problem) =>
      logger.warn(`config/data-protection.json — ${problem.path}: ${problem.reason}`),
  });
  logger.log(
    `Data-protection config loaded from ${loaded.path ?? 'built-in defaults'} ` +
      `(enabled=${String(loaded.config.enabled)}, ` +
      `failClosed=${String(loaded.config.failClosed)}).`,
  );
  return loaded.config;
}

/**
 * The default sink for the factory's two lines.
 *
 * `console`, not Nest's `Logger`: this runs during provider construction, before the application
 * logger is necessarily configured, and — more importantly — importing `@nestjs/common` here
 * would be the first step back down the dependency chain this file exists to stay out of.
 */
class ConsoleLogger {
  log(message: string): void {
    // eslint-disable-next-line no-console -- T-017: see the class comment; `console.warn` is the
    // only stream available this early, and both lines are boot diagnostics an operator needs.
    console.warn(`[data-protection] ${message}`);
  }
  warn(message: string): void {
    // eslint-disable-next-line no-console -- as above.
    console.warn(`[data-protection] ${message}`);
  }
}

/**
 * Normalises a `routeOverrides` key to `"<METHOD> <path>"`.
 *
 * §5's own example writes `"GET  /health"` with two spaces, so whitespace is collapsed rather
 * than trusted; the method is upper-cased and the path lower-cased so a lookup cannot miss on
 * letter case. Exported because `PayloadEncryption` (T-018) must build its lookup key the same
 * way — a normalisation that lives in one place cannot disagree with itself.
 */
export function normaliseRouteOverrideKey(key: string): string {
  const parts = key.trim().split(/\s+/);
  if (parts.length < 2) return key.trim().toLowerCase();
  const [method, ...rest] = parts;
  return `${method.toUpperCase()} ${rest.join(' ').toLowerCase()}`;
}

// --- validators -------------------------------------------------------------------------------

type Reporter = (path: string, reason: string) => void;

function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function bool(value: unknown, fallback: boolean, path: string, report: Reporter): boolean {
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  report(path, `expected a boolean, got ${describe(value)}; using ${String(fallback)}`);
  return fallback;
}

function str(value: unknown, fallback: string, path: string, report: Reporter): string {
  if (value === undefined) return fallback;
  if (typeof value === 'string' && value.length > 0) return value;
  report(path, `expected a non-empty string, got ${describe(value)}; using ${fallback}`);
  return fallback;
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
  path: string,
  report: Reporter,
): T {
  if (value === undefined) return fallback;
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value))
    return value as T;
  report(
    path,
    `expected one of ${allowed.join('|')}, got ${describe(value)}; using ${fallback} (fail-closed)`,
  );
  return fallback;
}

function positiveInt(value: unknown, fallback: number, path: string, report: Reporter): number {
  if (value === undefined) return fallback;
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  report(path, `expected a positive integer, got ${describe(value)}; using ${String(fallback)}`);
  return fallback;
}

function nonNegativeInt(value: unknown, fallback: number, path: string, report: Reporter): number {
  if (value === undefined) return fallback;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  report(
    path,
    `expected a non-negative integer, got ${describe(value)}; using ${String(fallback)}`,
  );
  return fallback;
}

/**
 * `routeOverrides` is validated per entry rather than wholesale: one bad route must not discard
 * the others, because the others are the ones protecting `POST /users`.
 */
function routeOverrides(value: unknown, report: Reporter): Readonly<Record<string, TransportMode>> {
  if (value === undefined) return DEFAULT_DATA_PROTECTION_CONFIG.transport.routeOverrides;

  const source = asObject(value);
  if (source === null) {
    report('transport.routeOverrides', `expected an object, got ${describe(value)}; using {}`);
    return DEFAULT_DATA_PROTECTION_CONFIG.transport.routeOverrides;
  }

  const out: Record<string, TransportMode> = {};
  for (const [key, mode] of Object.entries(source)) {
    if (typeof mode !== 'string' || !(TRANSPORT_MODES as readonly string[]).includes(mode)) {
      // Dropped, not defaulted: an override whose value is unreadable has no safe interpretation
      // ("off" would weaken it, "full" would strengthen a route nobody asked to strengthen), so
      // the route falls back to the global `transport.mode` as if it had never been listed.
      report(
        `transport.routeOverrides["${key}"]`,
        `expected one of ${TRANSPORT_MODES.join('|')}, got ${describe(mode)}; entry ignored`,
      );
      continue;
    }
    out[normaliseRouteOverrideKey(key)] = mode as TransportMode;
  }
  return Object.freeze(out);
}

/** A type name for a diagnostic. Never the value itself — this file's input is not secret, but
 * the habit of echoing config values into logs is how a credential in the wrong file gets
 * printed (R4, 02-SECURITY.md §9). */
function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}
