/**
 * TC-16 — a static, mechanical backstop for AGENT-PROTOCOL R5 / 04-FRONTEND.md §8 ("Never
 * read or write tokens in JS... If any code touches `localStorage` for auth, the task is
 * failed"). `.eslintrc.cjs`'s `no-restricted-globals` rule already blocks this at lint time;
 * this test asserts the same property directly against the shipped source, so it still fails
 * even if that lint rule were ever loosened.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOTS = ['src/auth', 'src/app', 'src/pages'].map((p) => join(__dirname, '..', '..', p));

function collectFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? collectFiles(full) : [full];
  });
}

describe('TC-16: no auth/app/pages source touches localStorage or sessionStorage', () => {
  it('scans every .ts/.tsx file owned by T-020 for the banned storage APIs', () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of collectFiles(root)) {
        if (!/\.(ts|tsx)$/.test(file)) continue;
        const content = readFileSync(file, 'utf8');
        if (/\blocalStorage\b|\bsessionStorage\b/.test(content)) {
          offenders.push(file);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
