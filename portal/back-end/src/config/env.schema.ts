import { z } from 'zod';

/**
 * The single source of truth for required environment variables. Boot fails, loudly and
 * immediately, if anything here is missing or malformed — 02-SECURITY.md §9: "No silent
 * defaults for security values." Every task that introduces a new required secret or
 * connection string extends this schema rather than reading `process.env` directly
 * elsewhere; a config value not represented here is invisible to this guarantee.
 *
 * T-001 owns NODE_ENV/PORT and the JWT key pair placeholders (JWT signing itself lands in
 * T-011; the schema exists now so the fail-fast behaviour is provable from Wave 0, per this
 * task's own TC-5). Later tasks append their own required keys — do not weaken an existing
 * field's validation to accommodate a new one.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  // RS256 asymmetric signing (02-SECURITY.md §1.1). Consumed by T-011's token service;
  // required from T-001 onward so a portal can never boot without them configured.
  JWT_PRIVATE_KEY: z.string().min(1, 'JWT_PRIVATE_KEY is required'),
  JWT_PUBLIC_KEY: z.string().min(1, 'JWT_PUBLIC_KEY is required'),

  // --- T-002: database connections -------------------------------------------------------
  // Two distinct roles, deliberately never merged into one (01-DATABASE.md §3, T-002 note 6):
  //   DB_APP_*        the runtime role the application itself connects as — reward_app.
  //                    Least privilege: ALL on reward_portal, narrow grants on reward_config,
  //                    no CREATE, no DELETE anywhere. This is what T-003's models use.
  //   DB_MIGRATION_*   a privileged role used ONLY by the migration runner (schema creation,
  //                    the GRANT statements that set up DB_APP_*'s own privileges, and the
  //                    two authorised reward_config ALTERs). Never imported into app runtime
  //                    code — importing this connection outside src/database/migrations or
  //                    src/database/cli is a bug, not a shortcut.
  DB_HOST: z.string().min(1, 'DB_HOST is required'),
  DB_PORT: z.coerce.number().int().positive().default(5432),
  DB_NAME: z.string().min(1, 'DB_NAME is required'),
  DB_SSL: z
    .string()
    .optional()
    .transform((v) => v === 'true'),

  DB_APP_USERNAME: z.string().min(1, 'DB_APP_USERNAME is required'),
  DB_APP_PASSWORD: z.string().min(1, 'DB_APP_PASSWORD is required'),

  DB_MIGRATION_USERNAME: z.string().min(1, 'DB_MIGRATION_USERNAME is required'),
  DB_MIGRATION_PASSWORD: z.string().min(1, 'DB_MIGRATION_PASSWORD is required'),

  // --- T-012: HTTP hardening (02-SECURITY.md §7, §8) --------------------------------------
  // Every key below is **optional, with a fail-closed default**, which is a deliberate
  // departure from the pattern above and worth the sentence it takes to explain. The required
  // keys are secrets: absent, the application cannot work at all, so refusing to boot is the
  // only honest answer. These are policy inputs whose absence has a safe, meaningful reading —
  // no cross-origin caller is allowed, no proxy is trusted, one instance, no shared counter
  // store. Making them required would fail the boot of every existing deployment and every
  // developer's machine the moment this task landed, to express a default that is already the
  // safest one available.
  //
  // The direction of each default is the point: an unset value can only ever *narrow* what is
  // permitted. None of them can be omitted into a weaker configuration.

  /**
   * The API's own public origin (`https://api.example.com`), added to the CSP `connect-src`
   * so the SPA may call it from its own origin. Unset → `connect-src 'self'`, the tighter form.
   */
  API_ORIGIN: z.string().optional(),

  /**
   * Comma-separated exact origin allowlist for CORS. Unset → **no** cross-origin request is
   * permitted. Never `*` and never a pattern — `cors.config.ts` rejects both at boot.
   */
  CORS_ALLOWED_ORIGINS: z.string().optional(),

  /**
   * Express `trust proxy`. A hop count, an address/CIDR list, or `loopback`. Unset → `false`,
   * i.e. `request.ip` is the unforgeable socket address. The literal `true` is **rejected**:
   * it would make the per-IP rate limits meaningless (see `resolveTrustProxy`).
   */
  TRUST_PROXY: z.string().optional(),

  /**
   * Shared rate-limit counter store. Unset → in-memory, correct for a single instance. Set but
   * unusable → the auth routes fail closed rather than silently reverting to per-process
   * counters (02-SECURITY.md §8, AR-11; see `throttle.store.ts`).
   */
  REDIS_URL: z.string().optional(),

  /**
   * How many instances of this process are deployed. Only used to decide whether running
   * without `REDIS_URL` deserves a boot warning — "an in-memory limiter across N pods is an
   * N-times weaker limiter".
   */
  APP_INSTANCE_COUNT: z.coerce.number().int().positive().default(1),

  // --- T-066: the login-ceiling test override (02-SECURITY.md §8) ---------------------------
  /**
   * Multiplier applied to the two `POST /auth/login` ceilings (5 per email+IP, 20 per IP, both
   * per 15 minutes) so an automated test environment can drive more logins than a human ever
   * would. **Ignored entirely when `NODE_ENV=production`**, and clamped to
   * `MAX_LOGIN_THROTTLE_RELAX_FACTOR` so it can never express "unlimited". Unset, or set to
   * anything that is not a whole number ≥ 2, yields the production numbers unchanged.
   *
   * Declared here — rather than read from `process.env` in `security.constants.ts` — for the
   * reason this file's header gives, and for a concrete one: `@nestjs/config` assigns only the
   * *validated* object back to `process.env`, and zod strips unknown keys, so a variable missing
   * from this schema is silently dropped when it comes from a `.env` file (T-057's D-3). The
   * resolution and every rejection rule live in `security.constants.ts`; deliberately kept a
   * plain optional string here so that a typo degrades to the production default rather than
   * stopping the boot, exactly as `LOG_LEVEL` below documents.
   */
  LOGIN_THROTTLE_RELAX_FACTOR: z.string().optional(),

  // --- T-019: observability (08-OBSERVABILITY.md §3, §4) ----------------------------------
  // All three are optional with a safe default, for the reason T-012's block above gives: none
  // is a secret, and each has a meaningful reading when unset. They are declared here rather
  // than read from `process.env` in `logger.module.ts` so that this file stays what its own
  // header claims — "the single source of truth for required environment variables ... a config
  // value not represented here is invisible to this guarantee".

  /**
   * One of `error`/`warn`/`info`/`debug` (08-OBSERVABILITY.md §4). Unset, or set to anything
   * else, → `debug` in development and `info` elsewhere. Validation is deliberately **not** an
   * enum here: a typo in an operator's environment must degrade to the default rather than stop
   * the process booting, which is the opposite trade to the secrets above. See `resolveLogLevel`.
   */
  LOG_LEVEL: z.string().optional(),

  /** `service.version` of the §3 envelope. Unset → `0.0.0-dev`, which sorts below every release. */
  SERVICE_VERSION: z.string().optional(),

  /** `service.instance` of the §3 envelope — which pod wrote the line. Unset → the hostname. */
  INSTANCE_ID: z.string().optional(),

  // --- T-045: the trace-retrieval endpoint's pluggable log-store adapter -------------------
  // (08-OBSERVABILITY.md §6, `modules/trace/adapters/log-store.adapter.ts`). Same optional/
  // safe-default shape as the T-012 and T-019 blocks above, for the same reason: none of these
  // is a secret, and the unset default — no adapter, `sources.logStore: 'not_configured'` — is
  // implementation note 3's graceful degradation working as designed, not a broken deployment.

  /** Which `LogStoreAdapter` `trace.module.ts` builds. Unset, or anything else, → `'none'`. */
  TRACE_LOG_STORE: z.enum(['file', 'http', 'none']).optional().default('none'),

  /** JSONL file `FileLogStoreAdapter` reads. Required when `TRACE_LOG_STORE=file`. */
  TRACE_LOG_FILE_PATH: z.string().optional(),

  /** Query endpoint `HttpLogStoreAdapter` calls. Required when `TRACE_LOG_STORE=http`. */
  TRACE_LOG_HTTP_URL: z.string().optional(),

  /** Bearer token for the HTTP log backend, if it needs one. Unset → no `Authorization` header. */
  TRACE_LOG_HTTP_TOKEN: z.string().optional(),

  /** Milliseconds before `HttpLogStoreAdapter` gives up and reports the source unavailable. */
  TRACE_LOG_HTTP_TIMEOUT_MS: z.coerce.number().int().positive().optional(),

  // --- T-047: the internal gRPC configuration service (09-INTEGRATION.md §7) ----------------
  // Same optional/safe-default shape as the T-012 and T-019 blocks above, with one difference
  // that matters: the *default is off*, and when it is switched on the three certificate paths
  // become **required** — `grpc.module.ts` fails the boot if any is missing. An mTLS listener
  // that came up without a CA to validate clients against would accept anyone, which is worse
  // than not coming up (02-SECURITY.md §9: no silent defaults for security values).
  //
  // None of these is a secret. The private key is a *path* to a key, never key material: R4
  // forbids a committed secret, and a path in an environment file is how every other deployment
  // artefact reaches this process.

  /** Whether to open the internal listener at all. Unset → **disabled**, which is also the
   * task's documented rollback: the REST portal is unaffected and the runtime falls back to its
   * cache and then fails closed. */
  GRPC_ENABLED: z
    .string()
    .optional()
    .transform((value) => value === 'true'),

  /** Listen port. Unset → 50051, the port 09-INTEGRATION.md §1 documents. */
  GRPC_PORT: z.coerce.number().int().positive().optional(),

  /** Listen address. Unset → `127.0.0.1`. §7: *"bound to the internal network only, never
   * internet-facing"* — a deployment must choose to widen this, never inherit it. */
  GRPC_HOST: z.string().optional(),

  /** PEM path: this server's own certificate, presented to the runtime. */
  GRPC_TLS_CERT_PATH: z.string().optional(),

  /** PEM path: the matching private key. */
  GRPC_TLS_KEY_PATH: z.string().optional(),

  /** PEM path: the CA every accepted **client** certificate must chain to. This is the file that
   * makes the transport mutual; without it there is no allowlist to be in. */
  GRPC_TLS_CA_PATH: z.string().optional(),

  // --- T-048: the AI campaign agent (10-AI-CAMPAIGN-AGENT.md §8) ----------------------------
  // Same optional/safe-default shape as the T-012, T-019 and T-047 blocks above. Nothing here is
  // a secret: the default model is **local Ollama**, which needs no API key precisely because
  // campaign configuration carries budgets and commercial terms and §8 keeps it on-network.
  //
  // There is deliberately no `AGENT_API_KEY`. Adding a hosted provider is the change that would
  // need one, and §8 makes that change conditional on an explicit redaction decision — so the
  // absence of the key here is part of the control, not an oversight to be tidied up later.

  // There is deliberately **no** `AGENT_ENABLED` flag. It was drafted and removed: nothing would
  // have read it, because the agent needs no listener, no port and no outbound network by default
  // — it reaches a loopback model and degrades to a 503 with a wizard link when that is not running
  // (§9). The task's rollback is "remove the module's line from `app.module.ts` and its nav entry",
  // which is one line and leaves no half-configured state. A flag nothing reads is worse than no
  // flag: it reads as a control and is not one.

  /** Switch point only — `ollama` is the one implementation (§8). An unknown value fails the
   * boot rather than silently falling back, per 02-SECURITY.md §9. */
  AGENT_LLM_PROVIDER: z.enum(['ollama']).optional(),

  /** Where the local model listens. Unset → `http://127.0.0.1:11434`. A loopback default, not a
   * LAN one: a model endpoint reachable from the network is a prompt-injection surface. */
  AGENT_LLM_BASE_URL: z.string().optional(),

  /** Unset → `llama3.1:8b`, the model `agents/create-campaign-v2` runs. */
  AGENT_LLM_MODEL: z.string().optional(),

  /** Milliseconds before a completion is abandoned and the wizard is offered instead (§9). */
  AGENT_LLM_TIMEOUT_MS: z.coerce.number().int().positive().optional(),

  // --- T-052: metrics, on a separate, non-public port (08-OBSERVABILITY.md §8) ---------------
  // Same optional/safe-default shape as every block above: nothing here is a secret, and every
  // default is the value already documented for local/dev use. What makes this port safe is not
  // in this schema at all — it is that `docker-compose.yml` never publishes it to the host and
  // no reverse proxy routes to it (`docs/DEPLOYMENT.md`). Set `METRICS_ENABLED=false` only for a
  // process that genuinely has nothing worth scraping (a one-off CLI), never as a way to avoid
  // deciding the network exposure question above.

  /** Whether the second listener opens at all. Unset → **enabled** — unlike `GRPC_ENABLED`,
   * metrics are not a new trust boundary (nothing here accepts client input), so the safe
   * default is "on", the opposite direction from a listener that accepts external connections. */
  METRICS_ENABLED: z
    .string()
    .optional()
    .transform((value) => value !== 'false'),

  /** Listen port for `GET /metrics`, entirely separate from `PORT`. Unset → `9464`, the
   * Prometheus/OpenTelemetry ecosystem's own conventional exporter port. */
  METRICS_PORT: z.coerce.number().int().positive().optional(),

  /** Listen address for the metrics port. Unset → all interfaces, matching how `PORT` itself
   * binds — the boundary this task relies on is "never published/routed", not "never bound",
   * because a container-network scraper (Prometheus, in the same compose network) must still
   * reach it by service name. */
  METRICS_HOST: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const result = envSchema.safeParse(config);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    console.error(`\nInvalid environment configuration:\n${issues}\n`);
    process.exit(1);
  }
  return result.data;
}
