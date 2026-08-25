/**
 * T-022 TC-14 / AGENT-PROTOCOL R5 — "Auth code scanned for storage APIs: `localStorage`/
 * `sessionStorage` never used for auth."
 *
 * `.eslintrc.cjs`'s `no-restricted-globals` rule already fails the lint gate on any use of
 * either identifier anywhere in `src`; this is a second, independent check scoped to
 * exactly the files this task owns, so the property is asserted by a test — not only by a
 * lint rule someone could in principle disable — mirroring `test/auth/noAuthStorage.spec.ts`
 * (T-020)'s equivalent guard over `src/auth`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));

const FILES = [
  'apiClient.ts',
  'apiError.ts',
  'csrf.ts',
  'queryClient.ts',
  'refreshQueue.ts',
] as const;

describe('no localStorage/sessionStorage in the API client', () => {
  it.each(FILES)('%s never references localStorage or sessionStorage', (file) => {
    const source = readFileSync(join(__dirname, '..', '..', 'src', 'lib', file), 'utf8');
    expect(source).not.toMatch(/\blocalStorage\b/);
    expect(source).not.toMatch(/\bsessionStorage\b/);
  });
});
