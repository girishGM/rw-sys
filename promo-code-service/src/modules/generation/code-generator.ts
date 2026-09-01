import { Injectable } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { AMBIGUOUS_CHARS, CHARSET_BY_NAME } from './charset.constants';
import type { CodeGenerationConfig, RandomSource } from './code-generator.types';
import { UnknownCharacterSetError } from './code-generator.types';

/**
 * T-PC-020 implementation note 2 — cryptographically secure default randomness source
 * (`node:crypto`'s `randomInt`), never the non-cryptographic global RNG. A promo code is a
 * bearer credential
 * that pays out real value on redemption (`01-DATABASE.md` §1's `reward_value`/`reward_unit`)
 * — a predictable PRNG would let an attacker guess unissued-but-generatable codes ahead of a
 * legitimate customer. `randomInt(exclusiveMax)` already returns a uniformly distributed
 * integer in `[0, exclusiveMax)`, exactly the `RandomSource` contract.
 */
export const cryptoRandomSource: RandomSource = (exclusiveMax: number): number =>
  randomInt(exclusiveMax);

/**
 * T-PC-020 — the collision-safe *candidate* code generator. Pure, transport-agnostic, no I/O:
 * takes a config-shaped recipe and a random source, returns one plausible code string. Has no
 * opinion on whether the result collides with an existing `promo_code.code` row — that is a
 * DB-level concern T-PC-021 owns via its own retry loop, calling `generate` fresh on every
 * attempt (implementation note 6: no internal memoization, no "avoid repeating within a call"
 * logic here).
 */
@Injectable()
export class CodeGenerator {
  /**
   * @param config Already-resolved recipe fields (task Scope "Out": never reads
   *   `promo_code_config` itself — T-PC-021 passes these in).
   * @param randomSource Defaults to `cryptoRandomSource`; injectable for deterministic tests
   *   (TC-1…TC-11, TC-13) without ever touching production randomness.
   * @throws {UnknownCharacterSetError} if `config.characterSet` is not one of the three named
   *   sets — a defensive check even though T-PC-010's DTO validation should prevent this
   *   upstream (TC-14).
   */
  generate(config: CodeGenerationConfig, randomSource: RandomSource = cryptoRandomSource): string {
    const pool = this.buildCharacterPool(config);
    const randomSegment = this.generateRandomSegment(pool, config.codeLength, randomSource);
    return `${config.codePrefix ?? ''}${randomSegment}${config.codePostfix ?? ''}`;
  }

  /**
   * Builds the working character pool for sampling. When `excludeAmbiguousChars` is `true`,
   * ambiguous characters are removed from the pool *before* sampling (implementation note 3)
   * — never sample-then-reject.
   */
  private buildCharacterPool(config: CodeGenerationConfig): string {
    const baseCharset = CHARSET_BY_NAME[config.characterSet];
    if (!baseCharset) {
      throw new UnknownCharacterSetError(config.characterSet);
    }
    if (!config.excludeAmbiguousChars) {
      return baseCharset;
    }
    let pool = '';
    for (const char of baseCharset) {
      if (!AMBIGUOUS_CHARS.has(char)) {
        pool += char;
      }
    }
    return pool;
  }

  private generateRandomSegment(pool: string, length: number, randomSource: RandomSource): string {
    let segment = '';
    for (let i = 0; i < length; i += 1) {
      segment += pool[randomSource(pool.length)];
    }
    return segment;
  }
}
