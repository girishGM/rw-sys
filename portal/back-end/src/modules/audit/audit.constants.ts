/**
 * T-040 — the audit viewer's own vocabulary and limits. `CAMPAIGN_AUDIT_ACTION`/
 * `CAMPAIGN_AUDIT_ENTITY_TYPE` are **not** redeclared here: they are imported straight from
 * `common/audit/audit.constants.ts` (T-014), which already transcribes `campaign_audit_trail`'s
 * two live `CHECK` constraints. Duplicating them would risk exactly the drift that file's own
 * header explains duplicating the *error-code* literals avoids — except here there is no
 * cross-module-dependency reason to duplicate, so importing is strictly better.
 */

/** 03-API-CONTRACT.md §1: pagination is capped, not rejected, at 100 per page. */
export const AUDIT_MAX_PAGE_SIZE = 100;
export const AUDIT_DEFAULT_PAGE_SIZE = 20;

/** Implementation note 6: CSV export is capped at 10,000 rows. */
export const AUDIT_CSV_ROW_CAP = 10_000;

/** How many rows a single export query page fetches at a time — genuine streaming, not one
 * `SELECT` of 10,000 rows held in memory before the first byte is written. */
export const AUDIT_CSV_BATCH_SIZE = 500;

/**
 * `event_type`/`target_type` on `portal_audit_log` have no `CHECK` constraint (they are written
 * from a dozen different constants files across Wave 1/3 — `PORTAL_AUDIT_EVENT`,
 * `AUTH_AUDIT_EVENT`, MFA and gRPC-grant events among them) so there is no single enum to import.
 * This pattern is the whitelist instead: lower-case letters, digits and underscores only — the
 * exact shape every event/target-type literal in this codebase already uses. It rejects the
 * SQL-metacharacter payloads TC-16 cares about without maintaining a second copy of a vocabulary
 * that lives in five other files.
 */
export const AUDIT_TOKEN_PATTERN = /^[a-z0-9_]{1,60}$/;
