import { describe, expect, it } from 'vitest';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  describeViolation,
  newPasswordSchema,
  passwordHasEnoughCharacterClasses,
  passwordMeetsLengthRequirement,
} from '../../../src/features/auth/passwordPolicy';

describe('passwordMeetsLengthRequirement', () => {
  it('rejects a password shorter than the minimum', () => {
    expect(passwordMeetsLengthRequirement('a'.repeat(PASSWORD_MIN_LENGTH - 1))).toBe(false);
  });

  it('accepts a password at exactly the minimum', () => {
    expect(passwordMeetsLengthRequirement('a'.repeat(PASSWORD_MIN_LENGTH))).toBe(true);
  });

  it('rejects a password longer than the maximum', () => {
    expect(passwordMeetsLengthRequirement('a'.repeat(PASSWORD_MAX_LENGTH + 1))).toBe(false);
  });
});

describe('passwordHasEnoughCharacterClasses', () => {
  it('rejects a password drawing on only two of the four classes', () => {
    expect(passwordHasEnoughCharacterClasses('lowercaseonly')).toBe(false);
    expect(passwordHasEnoughCharacterClasses('lowerUPPER')).toBe(false);
  });

  it('accepts a password drawing on exactly three classes', () => {
    expect(passwordHasEnoughCharacterClasses('LowerUpper1')).toBe(true);
  });

  it('accepts a password drawing on all four classes', () => {
    expect(passwordHasEnoughCharacterClasses('Lower1Upper!')).toBe(true);
  });

  it('is Unicode-aware, not ASCII-only', () => {
    // Cyrillic lower + upper + digit — three classes, none of them ASCII.
    expect(passwordHasEnoughCharacterClasses('пароЛЬ123')).toBe(true);
  });
});

describe('newPasswordSchema', () => {
  it('rejects a too-short password with the length message', () => {
    const result = newPasswordSchema.safeParse('Short1!');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/at least 12 characters/);
    }
  });

  it('rejects a long-enough password with too few character classes', () => {
    const result = newPasswordSchema.safeParse('alllowercaseandlong');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/at least 3 of/);
    }
  });

  it('accepts a password satisfying length and character-class rules', () => {
    const result = newPasswordSchema.safeParse('CorrectHorse1!');
    expect(result.success).toBe(true);
  });
});

describe('describeViolation', () => {
  it('renders every known server-side violation code', () => {
    for (const code of [
      'too_short',
      'too_long',
      'insufficient_character_classes',
      'common_password',
      'contains_email',
      'password_reused',
    ]) {
      expect(describeViolation(code)).toEqual(expect.any(String));
      expect(describeViolation(code).length).toBeGreaterThan(0);
    }
  });

  it('falls back to a generic message for an unrecognised code', () => {
    expect(describeViolation('something_new')).toBe('This password is not allowed.');
  });
});
