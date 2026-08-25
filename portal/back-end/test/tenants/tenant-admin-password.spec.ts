/**
 * T-034 — `generateTemporaryPassword`: server-generated, CSPRNG, unambiguous alphabet
 * (BACKLOG.md B-01, implementation note 5). Mirrors `country-admin-password.spec.ts` (T-030) —
 * this module's own near-identical copy of the same generator, see the file's own header for why.
 */
import { generateTemporaryPassword } from '@/modules/tenants/tenant-admin-password';

const AMBIGUOUS = /[O0lI1]/;

describe('generateTemporaryPassword', () => {
  it('defaults to 24 characters', () => {
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

  it('is drawn from a CSPRNG — 500 samples are all unique', () => {
    const samples = new Set(Array.from({ length: 500 }, () => generateTemporaryPassword()));
    expect(samples.size).toBe(500);
  });

  it('refuses a length too short to guarantee one character per class', () => {
    expect(() => generateTemporaryPassword(3)).toThrow(/at least 4/);
  });
});
