/**
 * T-121 — shared constants for the two field value-source registries.
 *
 * The entity names must match the `role_entity_permissions.entity` values seeded by `T121_002`
 * exactly — `@RequirePermission` looks the row up by this string, and a typo here fails open in
 * the worst possible way (no matching row, so no permission, so an endpoint nobody can reach) or
 * silently binds to the wrong entity's row. Declared once, imported by both the controller and
 * the migration's test, so the two cannot drift.
 */
export const FIELD_CONTEXT_PROVIDER_ENTITY = 'field_context_provider';
export const FIELD_API_LOOKUP_PROVIDER_ENTITY = 'field_api_lookup_provider';

/** Mirrors `varchar` widths in `T121_001` — a DTO must never accept what the column cannot hold. */
export const PROVIDER_CODE_MAX_LENGTH = 50;
export const PROVIDER_NAME_MAX_LENGTH = 200;
export const PROVIDER_DESCRIPTION_MAX_LENGTH = 500;
export const PROVIDER_ENDPOINT_URL_MAX_LENGTH = 500;
export const PROVIDER_RESPONSE_KEY_MAX_LENGTH = 100;

/** `ck_fcp_status`, `ck_falp_status`, `ck_falp_http_method`, `ck_falp_auth_type` (T121_001). */
export const FIELD_CONTEXT_PROVIDER_STATUSES = ['active', 'inactive'] as const;
export const FIELD_API_LOOKUP_PROVIDER_STATUSES = ['active', 'planned', 'inactive'] as const;
export const FIELD_API_LOOKUP_HTTP_METHODS = ['GET', 'POST'] as const;
export const FIELD_API_LOOKUP_AUTH_TYPES = ['none', 'api_key', 'bearer', 'mtls'] as const;

/**
 * Upper snake case, matching `providerCodeSchema` in
 * `@reward-portal/shared`'s `field-value-source.schema.ts`. A provider code is an immutable
 * machine identifier that T-122 stores on a rule field and T-123 dispatches on.
 */
export const PROVIDER_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;
