/**
 * T-PC-020 — plain data types for the pure code-generation algorithm. Nothing in this file
 * (or the module it belongs to) may import a database or transport type: `CodeGenerator`
 * takes a config-shaped input and a random source in, and returns a plain string out, so
 * T-PC-021 can call it repeatedly in a tight collision-retry loop without threading a
 * transaction or any I/O concern through it (ARCHITECTURE.md §6, task implementation note 1).
 */

/**
 * The three named character sets this schema's `character_set` CHECK constraint allows
 * (`01-DATABASE.md` §1). Do not add a fourth value here without a matching schema/contract
 * change — see task implementation note 4.
 */
export type CharacterSet = 'NUMERIC' | 'ALPHA' | 'ALPHANUMERIC';

/**
 * The already-resolved recipe fields `CodeGenerator.generate` needs. This is deliberately
 * narrower than the full `promo_code_config` row — T-PC-021 reads the config and passes only
 * these fields in (task Scope "Out": this module never reads `promo_code_config` itself).
 *
 * `codeLength` is the length of the randomly-generated segment only, never the final string
 * including `codePrefix`/`codePostfix` (implementation note 5).
 */
export interface CodeGenerationConfig {
  characterSet: CharacterSet;
  codeLength: number;
  codePrefix?: string | null;
  codePostfix?: string | null;
  excludeAmbiguousChars: boolean;
}

/**
 * A source of random, uniformly-distributed integers in `[0, exclusiveMax)`. Injected so the
 * algorithm is trivially unit-testable (a deterministic stub) while defaulting, in production,
 * to a cryptographically secure implementation (`cryptoRandomSource` in `code-generator.ts`) —
 * never the non-cryptographic global RNG (implementation note 2).
 */
export type RandomSource = (exclusiveMax: number) => number;

/**
 * Thrown by the pure function itself when handed a `characterSet` outside the three named
 * values — a defensive check that holds even if a caller bypasses T-PC-010's DTO validation
 * and calls this function directly (TC-14).
 */
export class UnknownCharacterSetError extends Error {
  constructor(public readonly characterSet: string) {
    super(`Unknown characterSet: ${characterSet}`);
    this.name = 'UnknownCharacterSetError';
  }
}
