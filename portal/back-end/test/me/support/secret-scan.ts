/**
 * T-015 TC-15 — *"Response scanned for sensitive keys: no hash, no token, no other user's data."*
 *
 * ### Why this walks keys instead of grepping the JSON
 *
 * The obvious form — `expect(JSON.stringify(body)).not.toMatch(/hash|secret|token|password/i)` —
 * is what T-011's suite uses and is right for `/auth/*`, whose responses carry three fields. It is
 * wrong here in both directions:
 *
 *  - **false negatives are impossible to distinguish from passes.** `/me/bootstrap` ships the whole
 *    `system_messages` catalogue, whose *values* are English sentences a Super Admin edits. The
 *    day someone writes "Your password has expired." into a message row, a string grep fails a
 *    test about leaked columns for a reason that has nothing to do with leaked columns — and the
 *    likely fix is to weaken the assertion.
 *  - **false passes are possible.** A grep over the serialised body cannot tell a *key* from a
 *    *value*, so it also cannot be tightened to allow one specific key without allowing that
 *    string anywhere.
 *
 * So the walk below inspects **property names** at every depth, using the application's own
 * `isSensitiveKey` (T-014) so the two definitions of "sensitive" cannot drift apart.
 *
 * ### The one allowed key, and why it is not a hole
 *
 * `mustChangePassword` matches the pattern and is required by 03-API-CONTRACT.md §3's profile.
 * T-011 recorded the identical exemption for its login response and resolved it the same way: the
 * pattern's intent is *secret material*, and a boolean flag about the caller's own account is not
 * secret material — it tells the SPA which screen to render and is already knowable to the user it
 * describes. The exemption is by exact name **and** asserts the value is a boolean, so a future
 * refactor cannot smuggle a string through it.
 */
import { isSensitiveKey } from '@/common/logging/redact';
import { SAFE_ERROR_CODE_PATTERN } from '@/common/errors/app-error';

/** Keys allowed to match {@link isSensitiveKey}, with the type each must have. */
const ALLOWED: Readonly<Record<string, 'boolean'>> = Object.freeze({
  mustChangePassword: 'boolean',
});

/**
 * Fails if any property name at any depth of `value` looks like credential material.
 *
 * `path` is threaded through so a failure names the offending field (`data.user.mfaSecretEnc`)
 * rather than merely asserting that one exists.
 */
export function expectNoSecretMaterial(value: unknown, path = 'response'): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => expectNoSecretMaterial(entry, `${path}[${index}]`));
    return;
  }

  if (value === null || typeof value !== 'object') return;

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const here = `${path}.${key}`;

    if (isSensitiveKey(key)) {
      const allowedType = ALLOWED[key];
      // Two assertions, both named, so a failure says which rule was broken.
      expect({ field: here, allowed: allowedType !== undefined }).toEqual({
        field: here,
        allowed: true,
      });
      expect({ field: here, type: typeof child }).toEqual({ field: here, type: allowedType });
    }

    expectNoSecretMaterial(child, here);
  }
}

/**
 * `{ MESSAGE_KEY: 'text' }` — every key a `system_messages` code, every value a string.
 *
 * The catalogue is the one part of the bootstrap payload whose **keys are data**, not field names,
 * and one of the seeded codes really is `PASSWORD_CHANGE_REQUIRED` — which the key walk above
 * correctly flags and which is correctly not a leak. Rather than exempting the subtree (and with
 * it any *genuine* leak hiding inside), the catalogue gets a shape assertion of its own that is
 * strictly stronger than "no key matches the pattern": a key that is not an `UPPER_SNAKE_CASE`
 * code, or a value that is not a string, fails. A column name, a row, or a nested object could not
 * satisfy either.
 */
export function expectMessageCatalogue(messages: unknown): void {
  expect(typeof messages).toBe('object');

  for (const [key, value] of Object.entries(messages as Record<string, unknown>)) {
    expect({ key, wellFormed: SAFE_ERROR_CODE_PATTERN.test(key) }).toEqual({
      key,
      wellFormed: true,
    });
    expect({ key, type: typeof value }).toEqual({ key, type: 'string' });
  }
}

/**
 * `{ entity: ['view', …] }` — every key a lower-snake entity noun, every value an array of
 * lower-snake action names.
 *
 * Same reasoning as {@link expectMessageCatalogue}: these keys come from
 * `role_entity_permissions.entity` and are data. None of the fifteen seeded entities matches the
 * sensitive-key pattern today, so the walk would pass over them — but that is luck rather than
 * design, and an entity legitimately named `api_key` would turn a disclosure test red for no
 * reason. Asserting the shape instead makes the guarantee independent of the vocabulary.
 */
export function expectPermissionMap(permissions: unknown): void {
  expect(typeof permissions).toBe('object');

  for (const [entity, actions] of Object.entries(permissions as Record<string, unknown>)) {
    expect({ entity, wellFormed: /^[a-z][a-z0-9_]{1,59}$/.test(entity) }).toEqual({
      entity,
      wellFormed: true,
    });
    expect(Array.isArray(actions)).toBe(true);
    for (const action of actions as unknown[]) {
      expect({ entity, action, wellFormed: /^[a-z][a-z0-9_]{1,39}$/.test(String(action)) }).toEqual(
        { entity, action, wellFormed: true },
      );
    }
  }
}

/**
 * The whole TC-15 assertion for one `GET /me/bootstrap` body.
 *
 * The two catalogue members are asserted by shape and then **excluded from the key walk**, which
 * runs over everything else — `user`, `scope`, `nav`, `widgets` and the envelope itself — where a
 * property name genuinely is a field name and a sensitive one would genuinely be a leak.
 */
export function expectBootstrapDisclosure(body: unknown, path = 'response'): void {
  const data = (body as { data?: Record<string, unknown> }).data ?? {};

  expectMessageCatalogue(data.messages);
  expectPermissionMap(data.permissions);

  const withoutCatalogues = {
    ...(body as Record<string, unknown>),
    data: { ...data, messages: undefined, permissions: undefined },
  };

  expectNoSecretMaterial(withoutCatalogues, path);
}
