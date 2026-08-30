/**
 * T-128 — the wire contract of `GET`/`PATCH /users/me/preferences` (13-REWARD-MASTER-VALUE-
 * SOURCES.md §6), shared by the back end that reads/writes `reward_portal.portal_users.ui_theme`
 * and the SPA that renders the theme switcher (T-129).
 *
 * Deliberately its own file, not folded into `user.schema.ts`'s `/users` block: this is a
 * **self-service** contract (every role, no `users:update` permission, the caller's own row
 * only — see `UsersController`'s own header) and a different route family (`/users/me/…`, not
 * `/users/:id`), so it earns the same "own file, own barrel export line" treatment
 * `bootstrap.schema.ts` gets for `/me` rather than living inside `tenant.schema.ts`'s or
 * `country.schema.ts`'s files.
 *
 * Same discipline every other `*.schema.ts` in this package states: bytes on the wire only, no
 * defaults the server never sent, no coercion, `.strict()` so an unexpected key fails the
 * contract test rather than shipping silently.
 */
import { z } from 'zod';

/** `ck_portal_users_ui_theme` (`T128_001`), verbatim. */
export const UI_THEMES = ['light-blue', 'yellow-black', 'red-white'] as const;
export const uiThemeSchema = z.enum(UI_THEMES);
export type UiTheme = z.infer<typeof uiThemeSchema>;

/** `GET /users/me/preferences`'s response body, and `PATCH /users/me/preferences`'s request
 * body — the same one-field shape both directions, the same precedent `emptyRequestSchema` in
 * `user.schema.ts` sets for a route whose request and response need no separate declaration. */
export const userPreferencesSchema = z.object({ uiTheme: uiThemeSchema }).strict();
export type UserPreferences = z.infer<typeof userPreferencesSchema>;

/** `PATCH /users/me/preferences`'s request body — identical shape to {@link userPreferencesSchema}
 * today, named separately so the two can diverge without a breaking rename if this route ever
 * grows a second preference field only one direction should carry. */
export const updateUserPreferencesRequestSchema = userPreferencesSchema;
export type UpdateUserPreferencesRequest = z.infer<typeof updateUserPreferencesRequestSchema>;

export const userPreferencesEnvelopeSchema = z.object({ data: userPreferencesSchema }).strict();
