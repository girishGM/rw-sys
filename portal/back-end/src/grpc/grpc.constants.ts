/**
 * T-047 — the fixed vocabulary of the internal configuration service.
 *
 * Everything here is transcribed from [09-INTEGRATION.md](../../../project-plan/09-INTEGRATION.md)
 * or from `proto/campaign_config.v1.proto`; nothing is invented at a call site. The `.proto` file
 * is the cross-team contract, so where a name appears in both, **the proto file wins** and
 * `test/grpc/proto-contract.spec.ts` asserts they still agree.
 */

/** The proto package + service name. Forms the `:path` of every RPC: `/<full name>/<Method>`. */
export const GRPC_SERVICE_FULL_NAME = 'rewardportal.config.v1.CampaignConfigService';

/** The six read RPCs. There is no mutating RPC and there must never be one (§7). */
export const GRPC_METHOD = Object.freeze({
  GET_CAMPAIGN_CONFIG: 'GetCampaignConfig',
  LIST_ACTIVE_CAMPAIGNS: 'ListActiveCampaigns',
  WATCH_CAMPAIGN_CONFIG: 'WatchCampaignConfig',
  RESOLVE_RULE_VERSION: 'ResolveRuleVersion',
  RESOLVE_REWARD_VERSION: 'ResolveRewardVersion',
  GET_BUDGET_STATUS: 'GetBudgetStatus',
} as const);

/**
 * `ConfigSection`, mirroring the proto enum **including its numbering** — the numbers cross the
 * wire, so a reordering here is a silent contract break.
 */
export const CONFIG_SECTION = Object.freeze({
  CONFIG_SECTION_UNSPECIFIED: 0,
  BASIC: 1,
  MERCHANTS: 2,
  TRACKERS: 3,
  RULES: 4,
  REWARDS: 5,
  CAPS: 6,
} as const);

export type ConfigSectionName = Exclude<keyof typeof CONFIG_SECTION, 'CONFIG_SECTION_UNSPECIFIED'>;

/** Every grantable section, in enum order. `CONFIG_SECTION_UNSPECIFIED` is not one. */
export const ALL_SECTIONS: readonly ConfigSectionName[] = Object.freeze([
  'BASIC',
  'MERCHANTS',
  'TRACKERS',
  'RULES',
  'REWARDS',
  'CAPS',
] as const);

/**
 * **Always included** (§4c): *"A configuration with no campaign header is not interpretable, and
 * returning one invites a null-dereference in every consumer."* It is therefore implicitly
 * granted to every identity that holds any grant at all, and implicitly requested by every call.
 */
export const ALWAYS_INCLUDED_SECTION: ConfigSectionName = 'BASIC';

/** `ConfigChangeEvent.ChangeType`, again mirroring the proto numbering. */
export const CHANGE_TYPE = Object.freeze({
  CHANGE_TYPE_UNSPECIFIED: 0,
  UPDATED: 1,
  PAUSED: 2,
  ENDED: 3,
} as const);

export type ChangeTypeName = Exclude<keyof typeof CHANGE_TYPE, 'CHANGE_TYPE_UNSPECIFIED'>;

/**
 * The only two campaign statuses that ever cross this boundary (§6).
 *
 * `draft` and `pending_approval` are unapproved configuration and must never reach a runtime that
 * pays real money; `completed` and `archived` are not live. `paused` **is** served, flagged, so
 * the runtime stops accruing rather than erroring on a campaign that vanished from its cache.
 */
export const SERVED_CAMPAIGN_STATUSES: readonly string[] = Object.freeze(['active', 'paused']);

/** The status `ListActiveCampaigns` enumerates — active only, per its own name. */
export const LISTED_CAMPAIGN_STATUS = 'active';

/** The generic `active`/`inactive` marker every link table in `reward_config` uses. */
export const ROW_ACTIVE = 'active';

/** Default listen port (§1). Overridable through `GRPC_PORT`; the default is the documented one. */
export const GRPC_DEFAULT_PORT = 50051;

/**
 * The cache TTL the runtime **must** apply, documented here because it is part of the contract
 * rather than of this process's configuration (§8): *"a design where a dropped gRPC stream
 * silently freezes configuration forever is one dropped connection away from paying rewards on
 * last month's rules."* Served to the client on every response as the `x-config-ttl-seconds`
 * header so an operator can see it without reading a document.
 */
export const CLIENT_CACHE_TTL_SECONDS = 300;

/** Response header carrying {@link CLIENT_CACHE_TTL_SECONDS}. */
export const TTL_HEADER = 'x-config-ttl-seconds';

/**
 * Per-service-identity rate limit (§7: *"generous but bounded — a runaway retry loop in the
 * runtime must not take the portal's database down"*).
 *
 * 3,000 calls/minute is roughly 50/s sustained, which is an order of magnitude above the
 * steady-state rate a correctly-caching runtime produces (a cache miss per campaign per TTL) and
 * five times the shadow-traffic shape TC-45 exercises. Exceeding it is evidence of a retry storm,
 * not of load.
 */
export const RATE_LIMIT_PER_MINUTE = 3_000;
export const RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * Access logging is **sampled**, not one row per call (§7): *"at transaction volume that would
 * dwarf every other table."* One in fifty, plus every denial — a denial is rare and is the line
 * an operator actually needs.
 */
export const ACCESS_LOG_SAMPLE_RATE = 50;

/** How many events one slow `WatchCampaignConfig` subscriber may fall behind before it is cut
 * loose. The stream is an optimisation (§8); a client that cannot keep up must reconnect and
 * re-warm through `ListActiveCampaigns` rather than grow an unbounded server-side buffer. */
export const WATCH_MAX_QUEUE = 256;

/** The internal REST callback (§7a). Not under `/api/v1`, and not on the public listener. */
export const BUDGET_BREACH_PATH_PATTERN = /^\/internal\/v1\/campaigns\/(\d{1,9})\/budget-breach$/;

/** Largest body the internal REST callback will read, in bytes. The documented payload is three
 * short fields; anything larger is a mistake or an attack, and either way is not read. */
export const BREACH_MAX_BODY_BYTES = 4_096;

/** `portal_audit_log.event_type` for a breach-triggered pause (§7a). */
export const BREACH_AUDIT_EVENT = 'budget_breach_paused';

/**
 * `portal_audit_log.actor_role` for the same row (§7a, verbatim).
 *
 * *"A human reading the audit trail must be able to tell a breach-triggered pause from a
 * tenant_admin one."* `actor_id` is `NULL` beside it: the runtime is not a portal user and
 * inventing one would make the trail lie.
 */
export const SYSTEM_ACTOR_ROLE = 'system:transaction-runtime';

/** `portal_audit_log.event_type` values for the `/admin/grpc-grants` surface (§4d). */
export const GRANT_AUDIT_EVENT = Object.freeze({
  CREATED: 'grpc_grant_created',
  UPDATED: 'grpc_grant_updated',
  REVOKED: 'grpc_grant_revoked',
} as const);

/** `grpc_service_grants.status` — `ck_gsg_status`. Revocation is a status flip, never a delete. */
export const GRANT_STATUS = Object.freeze({ ACTIVE: 'active', REVOKED: 'revoked' } as const);

/** `role_entity_permissions.entity` for the admin surface. */
export const GRPC_GRANT_ENTITY = 'grpc_grant';

/** `service_identity` is `varchar(120)`. */
export const SERVICE_IDENTITY_MAX_LENGTH = 120;
