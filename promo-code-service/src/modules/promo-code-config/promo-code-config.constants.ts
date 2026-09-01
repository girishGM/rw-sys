/**
 * T-PC-010. DI token for this module's own runtime Postgres connection (the least-privilege
 * `promo_code_app` role — AGENT-PROTOCOL.md R1, `01-DATABASE.md` — never the migration role
 * from `src/database/migration-connection.ts`, which is reserved for the migration CLI only).
 *
 * No shared `DatabaseModule` exists yet anywhere in `src/` for application runtime code — only
 * `src/database/migration-connection.ts` (migration CLI, out of this task's file scope) and
 * `src/health/health.controller.ts` (a raw TCP probe, not an authenticated connection). This
 * module owns constructing its own connection (`promo-code-config.module.ts`) and exports this
 * token so a sibling module in this same file scope — `campaign-binding` (T-PC-012), which also
 * needs to read `promo_code_config` — can import `PromoCodeConfigModule` and reuse the same
 * pool instead of opening a second one.
 */
export const PROMO_CODE_SEQUELIZE = Symbol('PROMO_CODE_SEQUELIZE');
