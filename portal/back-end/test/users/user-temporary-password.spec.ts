/**
 * T-035 — `generateTemporaryPassword`: server-generated, CSPRNG, unambiguous alphabet
 * (BACKLOG.md B-01). Mirrors `tenant-admin-password.spec.ts` (T-034) — this module's own
 * near-identical copy of the same generator, see the file's own header for why.
 */
import { generateTemporaryPassword } from '@/modules/users/user-temporary-password';

const AMBIGUOUS = /[O0lI1]/;

describe('generateTemporaryPassword', () => {
  it('defaults to 24 characters (T-035 TC-4/T-046 TC-4)', () => {
    expect(generateTemporaryPassword()).toHaveLength(24);
  });

  it('honours an explicit length', () => {
    expect(generateTemporaryPassword(12)).toHaveLength(12);
  });

  it('never contains an ambiguous character (no O/0, l/1/I)', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(generateTemporaryPassword()).not.toMatch(AMBIGUOUS);
    }
  });

  it('always contains at least one lowercase, one uppercase, one digit and one symbol', () => {
    for (let i = 0; i < 200; i += 1) {
      const password = generateTemporaryPassword();
      expect(password).toMatch(/[a-km-z]/);
      expect(password).toMatch(/[A-HJ-NP-Z]/);
      expect(password).toMatch(/[2-9]/);
      expect(password).toMatch(/[!@#$%^&*\-_=+]/);
    }
  });

  it('is drawn from a CSPRNG — 1,000 samples are all unique (T-046 TC-5)', () => {
    const samples = new Set(Array.from({ length: 1000 }, () => generateTemporaryPassword()));
    expect(samples.size).toBe(1000);
  });

  it('refuses a length too short to guarantee one character per class', () => {
    expect(() => generateTemporaryPassword(3)).toThrow(/at least 4/);
  });
});
