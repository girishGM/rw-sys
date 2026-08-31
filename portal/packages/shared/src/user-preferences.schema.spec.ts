/**
 * T-128 — the `/users/me/preferences` wire contract, tested in the package that declares it.
 * Same rationale every other `*.schema.spec.ts` in this package states: the front end has no
 * access to a back-end contract suite, so every rejection case that proves `.strict()`/the enum
 * is doing its job lives here instead.
 */
import {
  UI_THEMES,
  uiThemeSchema,
  updateUserPreferencesRequestSchema,
  userPreferencesEnvelopeSchema,
  userPreferencesSchema,
} from './user-preferences.schema';

describe('UI_THEMES', () => {
  it('is the three values ck_portal_users_ui_theme (T128_001) enforces, verbatim', () => {
    expect(UI_THEMES).toEqual(['light-blue', 'yellow-black', 'red-white']);
  });
});

describe('uiThemeSchema', () => {
  it.each(UI_THEMES)('accepts %s', (value) => {
    expect(uiThemeSchema.safeParse(value).success).toBe(true);
  });

  it('rejects a value outside the enum', () => {
    expect(uiThemeSchema.safeParse('dark-mode').success).toBe(false);
  });

  it('rejects the default column value spelled with different casing', () => {
    expect(uiThemeSchema.safeParse('Light-Blue').success).toBe(false);
  });
});

describe('userPreferencesSchema', () => {
  it('accepts { uiTheme }', () => {
    expect(userPreferencesSchema.safeParse({ uiTheme: 'yellow-black' }).success).toBe(true);
  });

  it('rejects a missing uiTheme', () => {
    expect(userPreferencesSchema.safeParse({}).success).toBe(false);
  });

  it('rejects an extra key (strict)', () => {
    expect(
      userPreferencesSchema.safeParse({ uiTheme: 'light-blue', role: 'super_admin' }).success,
    ).toBe(false);
  });
});

describe('updateUserPreferencesRequestSchema', () => {
  it('accepts the same shape as userPreferencesSchema', () => {
    expect(updateUserPreferencesRequestSchema.safeParse({ uiTheme: 'red-white' }).success).toBe(
      true,
    );
  });
});

describe('userPreferencesEnvelopeSchema', () => {
  it('wraps the response in the { data } envelope (03-API-CONTRACT.md §1)', () => {
    expect(
      userPreferencesEnvelopeSchema.safeParse({ data: { uiTheme: 'light-blue' } }).success,
    ).toBe(true);
  });

  it('rejects an unwrapped body', () => {
    expect(userPreferencesEnvelopeSchema.safeParse({ uiTheme: 'light-blue' }).success).toBe(false);
  });
});
