/**
 * T-016 — `FieldCryptoService`: AES-256-GCM with a fresh IV and the record identity bound in
 * as AAD.
 *
 * Covers TC-1…TC-10 and TC-23. The two that matter most are here:
 *
 *  - **TC-6** (`decrypt` with row B's AAD must fail) is the ciphertext-swap control. Without
 *    it, anyone with UPDATE on an encrypted column can move one user's encrypted email onto
 *    another user's row and the portal will happily decrypt it. It is asserted several ways
 *    below — a different row id, a different table, a near-miss id, and a rewritten `kid`
 *    header — because "the AAD is bound" and "the AAD is bound to *everything that matters*"
 *    are different claims.
 *  - **TC-2/TC-10** (IV uniqueness) is the control that keeps GCM from degrading into a
 *    two-time pad. A test asserting deterministic ciphertext would look tidier and would be
 *    asserting a catastrophic bug, so the assertion runs the other way on purpose.
 *
 * Bit-flip helpers below rewrite the *decoded* bytes and re-encode, rather than poking at the
 * base64 text: flipping a base64 character can produce a string that is no longer valid
 * base64, which would fail in the parser and never reach the tag check the test is about.
 */
import {
  AUTH_TAG_BYTES,
  DecryptionError,
  EncryptionError,
  FieldCryptoService,
  formatCiphertext,
  IV_BYTES,
  parseCiphertext,
} from '@/common/crypto';
import {
  blindKeyRow,
  buildDefaultRegistry,
  buildRegistry,
  FIELD_ENV_V2,
  FIELD_KID,
  FIELD_KID_V2,
  fieldKeyRow,
} from './support/keys';

const AAD_A = FieldCryptoService.aadFor('reward_portal.portal_users', 1);
const AAD_B = FieldCryptoService.aadFor('reward_portal.portal_users', 2);

/**
 * Built rather than typed as a literal on purpose. A raw U+0000 in the source makes the whole
 * file look like a binary to `grep`, which would silently exclude this spec from the
 * repository-wide greps that T-051's security review and `scan:secrets` rely on. A test file
 * that quietly opts out of the security sweeps is a bad trade for one keystroke.
 */
const NUL = String.fromCharCode(0);

let crypto: FieldCryptoService;

beforeAll(async () => {
  crypto = new FieldCryptoService(await buildDefaultRegistry());
});

/** Returns a copy of `buffer` with the lowest bit of byte `index` flipped. */
function flipBit(buffer: Buffer, index = 0): Buffer {
  const copy = Buffer.from(buffer);
  copy[index] ^= 0x01;
  return copy;
}

/** Rebuilds a ciphertext with one component replaced. */
function rebuild(
  ciphertext: string,
  patch: Partial<{ kid: string; iv: Buffer; tag: Buffer; ct: Buffer }>,
): string {
  const p = parseCiphertext(ciphertext);
  return formatCiphertext(
    patch.kid ?? p.kid,
    patch.iv ?? p.iv,
    patch.tag ?? p.tag,
    patch.ct ?? p.ct,
  );
}

/**
 * Asserts a `DecryptionError` with `reason` **and** that nothing at all was returned.
 *
 * The second half is the point: `expect(fn).toThrow()` alone would also pass if the service
 * returned partial plaintext and then threw. The result is captured outside the `try` so a
 * failed assertion cannot be swallowed by the same `catch` that is inspecting the error.
 */
function expectDecryptionFailure(fn: () => unknown, reason: string): void {
  let result: unknown;
  let error: unknown;
  try {
    result = fn();
  } catch (err) {
    error = err;
  }
  expect(result).toBeUndefined();
  expect(error).toBeInstanceOf(DecryptionError);
  expect((error as DecryptionError).reason).toBe(reason);
}

describe('FieldCryptoService', () => {
  describe('TC-1 — encrypt then decrypt round-trips exactly', () => {
    it.each([
      ['ascii', 'hello world'],
      ['an email', 'John.Doe+tag@example.com'],
      ['accented latin', 'Zoë Müller — Ångström'],
      ['CJK', '奖励系统门户'],
      ['emoji', '🎉🎁💰 reward! 👨‍👩‍👧‍👦'],
      ['RTL', 'مرحبا بالعالم'],
      ['an embedded NUL byte', `before${NUL}after`],
      ['a surrogate pair', '\u{1F600}'],
      ['whitespace only', '   \t\n  '],
      ['a value that looks like a ciphertext', 'v1.fld_2026_01.AAAA.BBBB.CCCC'],
    ])('round-trips %s', (_label, plaintext) => {
      const ciphertext = crypto.encrypt(plaintext, { aad: AAD_A });
      expect(crypto.decrypt(ciphertext, { aad: AAD_A })).toBe(plaintext);
    });

    it('documents the one input class that cannot round-trip: a lone surrogate', () => {
      // '\uD800' is half of a surrogate pair and has no UTF-8 representation, so Node
      // substitutes U+FFFD on the way in. Nothing in the crypto is at fault and nothing here
      // can fix it — the value was already unrepresentable before it reached us. Asserted so
      // the behaviour is known rather than discovered via a corrupted column, and so T-017's
      // model hooks reject lone surrogates at validation time instead of trusting the cipher
      // to preserve them.
      const lone = 'a\uD800b';
      const roundTripped = crypto.decrypt(crypto.encrypt(lone, { aad: AAD_A }), { aad: AAD_A });
      expect(roundTripped).not.toBe(lone);
      // The substitution happens in Buffer conversion, not in the cipher:
      expect(roundTripped).toBe(Buffer.from(lone, 'utf8').toString('utf8'));
    });

    it('does not leak the plaintext into the ciphertext', () => {
      const plaintext = 'super-secret-value';
      expect(crypto.encrypt(plaintext, { aad: AAD_A })).not.toContain(plaintext);
    });
  });

  describe('TC-2 — the same plaintext encrypts to different ciphertext each time', () => {
    it('produces a different envelope and a different IV', () => {
      const a = crypto.encrypt('same', { aad: AAD_A });
      const b = crypto.encrypt('same', { aad: AAD_A });
      expect(a).not.toBe(b);
      expect(parseCiphertext(a).iv.equals(parseCiphertext(b).iv)).toBe(false);
      // Both still decrypt — "different" is not the same as "broken".
      expect(crypto.decrypt(a, { aad: AAD_A })).toBe('same');
      expect(crypto.decrypt(b, { aad: AAD_A })).toBe('same');
    });
  });

  describe('TC-3 — the ciphertext format is v1.<kid>.<iv>.<tag>.<ct>', () => {
    it('has five parts with the documented sizes and kid', () => {
      const ciphertext = crypto.encrypt('value', { aad: AAD_A });
      const [version, kid, iv, tag, ct] = ciphertext.split('.');

      expect(ciphertext.split('.')).toHaveLength(5);
      expect(version).toBe('v1');
      expect(kid).toBe(FIELD_KID);
      expect(Buffer.from(iv, 'base64')).toHaveLength(IV_BYTES);
      expect(Buffer.from(tag, 'base64')).toHaveLength(AUTH_TAG_BYTES);
      // GCM is a stream mode: the body is exactly the plaintext's byte length, no padding.
      expect(Buffer.from(ct, 'base64')).toHaveLength(Buffer.byteLength('value', 'utf8'));
    });
  });

  describe('TC-4 — a flipped ciphertext bit fails, and returns no plaintext', () => {
    it('rejects a body whose first byte changed', () => {
      const ciphertext = crypto.encrypt('the quick brown fox', { aad: AAD_A });
      const tampered = rebuild(ciphertext, { ct: flipBit(parseCiphertext(ciphertext).ct) });
      expectDecryptionFailure(() => crypto.decrypt(tampered, { aad: AAD_A }), 'auth_failed');
    });

    it('rejects a flip in the last byte too — the tag covers the whole body', () => {
      const ciphertext = crypto.encrypt('a'.repeat(64), { aad: AAD_A });
      const ct = parseCiphertext(ciphertext).ct;
      const tampered = rebuild(ciphertext, { ct: flipBit(ct, ct.length - 1) });
      expectDecryptionFailure(() => crypto.decrypt(tampered, { aad: AAD_A }), 'auth_failed');
    });

    it('rejects a flipped IV', () => {
      const ciphertext = crypto.encrypt('value', { aad: AAD_A });
      const tampered = rebuild(ciphertext, { iv: flipBit(parseCiphertext(ciphertext).iv) });
      expectDecryptionFailure(() => crypto.decrypt(tampered, { aad: AAD_A }), 'auth_failed');
    });

    it('rejects a truncated body', () => {
      const ciphertext = crypto.encrypt('a reasonably long value to truncate', { aad: AAD_A });
      const ct = parseCiphertext(ciphertext).ct;
      const tampered = rebuild(ciphertext, { ct: ct.subarray(0, ct.length - 4) });
      expectDecryptionFailure(() => crypto.decrypt(tampered, { aad: AAD_A }), 'auth_failed');
    });
  });

  describe('TC-5 — a flipped auth-tag bit fails', () => {
    it('rejects a tampered tag', () => {
      const ciphertext = crypto.encrypt('value', { aad: AAD_A });
      const tampered = rebuild(ciphertext, { tag: flipBit(parseCiphertext(ciphertext).tag) });
      expectDecryptionFailure(() => crypto.decrypt(tampered, { aad: AAD_A }), 'auth_failed');
    });

    it('rejects a zeroed tag', () => {
      const ciphertext = crypto.encrypt('value', { aad: AAD_A });
      const tampered = rebuild(ciphertext, { tag: Buffer.alloc(AUTH_TAG_BYTES, 0) });
      expectDecryptionFailure(() => crypto.decrypt(tampered, { aad: AAD_A }), 'auth_failed');
    });
  });

  describe('TC-6 — a ciphertext lifted onto another row does not decrypt', () => {
    it('fails when row B presents row A’s ciphertext', () => {
      const ciphertext = crypto.encrypt('alice@example.com', { aad: AAD_A });
      // Exactly the attack: an UPDATE copying the column value from row 1 onto row 2.
      expectDecryptionFailure(() => crypto.decrypt(ciphertext, { aad: AAD_B }), 'auth_failed');
      // ...and the legitimate owner is unaffected.
      expect(crypto.decrypt(ciphertext, { aad: AAD_A })).toBe('alice@example.com');
    });

    it('fails across tables, not just across rows', () => {
      const ciphertext = crypto.encrypt('value', {
        aad: FieldCryptoService.aadFor('reward_portal.portal_users', 7),
      });
      expectDecryptionFailure(
        () =>
          crypto.decrypt(ciphertext, {
            aad: FieldCryptoService.aadFor('reward_config.merchants', 7),
          }),
        'auth_failed',
      );
    });

    it('rejects near-miss ids — 1 vs 10, not just 1 vs 2', () => {
      const ciphertext = crypto.encrypt('value', {
        aad: FieldCryptoService.aadFor('reward_portal.portal_users', 1),
      });
      expectDecryptionFailure(
        () =>
          crypto.decrypt(ciphertext, {
            aad: FieldCryptoService.aadFor('reward_portal.portal_users', 10),
          }),
        'auth_failed',
      );
    });

    it('fails when the envelope header itself is rewritten', () => {
      // Version and kid are inside the AAD, so an attacker cannot relabel a ciphertext as
      // belonging to another key and have it decrypt under that key's rules.
      const ciphertext = crypto.encrypt('value', { aad: AAD_A });
      const relabelled = rebuild(ciphertext, { kid: 'fld_2026_02' });
      expectDecryptionFailure(() => crypto.decrypt(relabelled, { aad: AAD_A }), 'unknown_key');
    });

    it('requires an AAD at all, on both operations', () => {
      const missing = [
        { aad: '' },
        { aad: undefined as unknown as string },
        undefined as unknown as { aad: string },
      ];
      for (const options of missing) {
        expect(() => crypto.encrypt('value', options)).toThrow(EncryptionError);
        expect(() => crypto.decrypt('v1.x.y.z.w', options)).toThrow(EncryptionError);
      }
    });

    it('builds AADs that cannot collide, and refuses empty components', () => {
      expect(FieldCryptoService.aadFor('reward_portal.portal_users', 1)).toBe(
        'reward_portal.portal_users:1',
      );
      expect(FieldCryptoService.aadFor('t', '1')).toBe(FieldCryptoService.aadFor('t', 1));
      expect(() => FieldCryptoService.aadFor('', 1)).toThrow(EncryptionError);
      expect(() => FieldCryptoService.aadFor('t', '')).toThrow(EncryptionError);
    });
  });

  describe('TC-7 — malformed input raises a typed error and produces nothing', () => {
    it.each([
      ['garbage', 'malformed'],
      ['', 'malformed'],
      ['v1.fld_2026_01', 'malformed'],
      ['v9.fld_2026_01.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA==.', 'unsupported_version'],
      ['v1.no_such_kid.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA==.', 'unknown_key'],
    ])('rejects %p as %p', (value, reason) => {
      expectDecryptionFailure(() => crypto.decrypt(value, { aad: AAD_A }), reason);
    });

    it('does not crash on a very long garbage string', () => {
      expectDecryptionFailure(
        () => crypto.decrypt('x'.repeat(100_000), { aad: AAD_A }),
        'malformed',
      );
    });
  });

  describe('TC-8 — empty string and null are handled explicitly', () => {
    it('encrypts the empty string to a real envelope that round-trips', () => {
      const ciphertext = crypto.encrypt('', { aad: AAD_A });
      expect(ciphertext).not.toBeNull();
      expect(ciphertext.split('.')).toHaveLength(5);
      expect(parseCiphertext(ciphertext).ct).toHaveLength(0);
      expect(crypto.decrypt(ciphertext, { aad: AAD_A })).toBe('');
    });

    it('passes null and undefined straight through, both ways', () => {
      expect(crypto.encrypt(null, { aad: AAD_A })).toBeNull();
      expect(crypto.encrypt(undefined, { aad: AAD_A })).toBeNull();
      expect(crypto.decrypt(null, { aad: AAD_A })).toBeNull();
      expect(crypto.decrypt(undefined, { aad: AAD_A })).toBeNull();
    });

    it('keeps null and the empty string distinguishable after a round trip', () => {
      // The property a NOT NULL column depends on: '' must not collapse into NULL.
      expect(crypto.encrypt(null, { aad: AAD_A })).toBeNull();
      expect(crypto.decrypt(crypto.encrypt('', { aad: AAD_A }), { aad: AAD_A })).toBe('');
    });

    it('rejects the empty string on decrypt rather than inventing a value', () => {
      expectDecryptionFailure(() => crypto.decrypt('', { aad: AAD_A }), 'malformed');
    });

    it('refuses a non-string plaintext instead of stringifying it', () => {
      const notAString = { toString: () => 'nope' } as unknown as string;
      expect(() => crypto.encrypt(notAString, { aad: AAD_A })).toThrow(EncryptionError);
      expect(() => crypto.encrypt(42 as unknown as string, { aad: AAD_A })).toThrow(
        /accepts a string/,
      );
    });
  });

  describe('TC-9 — a 1 MB plaintext round-trips', () => {
    it('handles 1 MiB of ascii', () => {
      const plaintext = 'A'.repeat(1024 * 1024);
      const ciphertext = crypto.encrypt(plaintext, { aad: AAD_A });
      expect(crypto.decrypt(ciphertext, { aad: AAD_A })).toBe(plaintext);
    });

    it('handles 1 MiB of multi-byte characters', () => {
      const plaintext = '🎁'.repeat(256 * 1024);
      expect(crypto.decrypt(crypto.encrypt(plaintext, { aad: AAD_A }), { aad: AAD_A })).toBe(
        plaintext,
      );
    });
  });

  describe('TC-10 — 10,000 encryptions produce 10,000 distinct IVs', () => {
    it('never repeats an IV, and never repeats a whole ciphertext', () => {
      const ivs = new Set<string>();
      const ciphertexts = new Set<string>();
      for (let i = 0; i < 10_000; i += 1) {
        const ciphertext = crypto.encrypt('constant plaintext', { aad: AAD_A });
        ivs.add(parseCiphertext(ciphertext).iv.toString('base64'));
        ciphertexts.add(ciphertext);
      }
      expect(ivs.size).toBe(10_000);
      expect(ciphertexts.size).toBe(10_000);
    });
  });

  describe('TC-23 — throughput', () => {
    /**
     * TC-23's budget is "> 50,000 ops/sec **single-threaded**" (T-016 task file). Under `jest`'s
     * default parallelism this process is not alone on the machine — 278 suites compete for 10
     * cores — so a single timed loop reports whatever the load happened to be, not this service's
     * cost. Measured on an unchanged tree, three consecutive full-suite runs: 42,751 / 58,551 /
     * 101,652 encrypt ops/sec. A 2.4x spread with no code change, straddling the budget in both
     * directions; the first of those three failed the suite (T-086).
     *
     * The fix rests on one property of contention: it is strictly *additive* to elapsed time.
     * Another process stealing a core can only ever make a loop take longer, never shorter. So
     * the fastest of several trials is the closest available estimate of the uncontended,
     * single-threaded rate the budget actually names — taking it measures the code instead of
     * the machine.
     *
     * This does not weaken the budget, and that claim is asserted rather than asserted-by-comment:
     * a genuine regression is slow in *every* trial, because there is no clean trial for `bestOf`
     * to find. Both directions are pinned on fixed data by the two tests below this one.
     */
    const bestOf = (trials: number[]): number => Math.max(...trials);

    it('exceeds 50,000 ops/sec single-threaded, encrypting and decrypting', () => {
      const plaintext = 'a-typical-field-value@example.com';
      const iterations = 20_000;
      const trials = 5;

      // Warm the JIT and the OpenSSL cipher context before timing anything.
      for (let i = 0; i < 2_000; i += 1) {
        crypto.decrypt(crypto.encrypt(plaintext, { aad: AAD_A }), { aad: AAD_A });
      }

      const ciphertext = crypto.encrypt(plaintext, { aad: AAD_A });
      const encryptTrials: number[] = [];
      const decryptTrials: number[] = [];

      for (let trial = 0; trial < trials; trial += 1) {
        const encryptStart = process.hrtime.bigint();
        for (let i = 0; i < iterations; i += 1) crypto.encrypt(plaintext, { aad: AAD_A });
        const encryptNs = Number(process.hrtime.bigint() - encryptStart);

        const decryptStart = process.hrtime.bigint();
        for (let i = 0; i < iterations; i += 1) crypto.decrypt(ciphertext, { aad: AAD_A });
        const decryptNs = Number(process.hrtime.bigint() - decryptStart);

        encryptTrials.push((iterations / encryptNs) * 1e9);
        decryptTrials.push((iterations / decryptNs) * 1e9);
      }

      const encryptOpsPerSec = bestOf(encryptTrials);
      const decryptOpsPerSec = bestOf(decryptTrials);

      // Printed so a regression shows a number, not just a red test. Every trial is printed and
      // not only the winner, so that reading CI output distinguishes the two cases this budget
      // can fail for: a wide spread means contention, a uniformly low set means a real regression.
      const rates = (trialRates: number[]): string =>
        trialRates.map((rate) => Math.round(rate).toLocaleString()).join(', ');
      // eslint-disable-next-line no-console -- T-016 TC-23 requires the measured rate on record.
      console.log(
        `TC-23: encrypt ${Math.round(encryptOpsPerSec).toLocaleString()} ops/sec ` +
          `(best of ${trials}: ${rates(encryptTrials)}), ` +
          `decrypt ${Math.round(decryptOpsPerSec).toLocaleString()} ops/sec ` +
          `(best of ${trials}: ${rates(decryptTrials)})`,
      );

      expect(encryptOpsPerSec).toBeGreaterThan(50_000);
      expect(decryptOpsPerSec).toBeGreaterThan(50_000);
    });

    /**
     * T-086 TC-3 — the estimator itself, on fixed data, so the two claims the comment above makes
     * are tested rather than trusted. These are deterministic: no clock is read.
     */
    it('reads through contention: one clean trial among depressed ones still meets the budget', () => {
      // The three encrypt rates actually observed across three consecutive full-suite runs on an
      // unchanged tree, plus two more draws from the same contended distribution.
      const contended = [42_751, 58_551, 101_652, 30_112, 47_009];

      expect(bestOf(contended)).toBeGreaterThan(50_000);
      // ...and the single-trial reading this replaced fails the budget on the very same data,
      // which is precisely the spurious red T-086 exists to remove.
      expect(contended[0]).toBeLessThan(50_000);
    });

    it('still fails a genuine regression, because contention cannot make a loop faster', () => {
      // Every trial slow, none clean: no amount of re-measuring rescues code that really did
      // get slower. If `bestOf` ever let this through, the budget would be decorative.
      const regressed = [41_900, 38_400, 44_700, 30_050, 43_880];

      expect(bestOf(regressed)).toBeLessThan(50_000);
    });
  });

  describe('reencrypt', () => {
    it('is a no-op when the value is already on the active kid', () => {
      const ciphertext = crypto.encrypt('value', { aad: AAD_A });
      expect(crypto.reencrypt(ciphertext, { aad: AAD_A })).toBe(ciphertext);
    });

    it('refuses a malformed input rather than re-encrypting garbage', () => {
      expectDecryptionFailure(() => crypto.reencrypt('garbage', { aad: AAD_A }), 'malformed');
    });

    /**
     * The path `RotateKeysCommand` actually drives, exercised here without the rotation
     * machinery so a failure points at `reencrypt` rather than at a batch loop.
     *
     * Both halves are asserted deliberately: that the value moves onto the new kid, *and*
     * that it still decrypts to the original plaintext. A `reencrypt` that produced a
     * well-formed envelope under the new kid but garbled the payload would satisfy the first
     * assertion alone, and the damage would only surface the next time someone tried to log
     * in — long after the rotation was declared successful.
     */
    it('re-encrypts onto the new active kid, preserving the plaintext, after a rotation', async () => {
      const before = new FieldCryptoService(await buildRegistry([fieldKeyRow(), blindKeyRow()]));
      const ciphertext = before.encrypt('someone@example.com', { aad: AAD_A });
      expect(parseCiphertext(ciphertext).kid).toBe(FIELD_KID);

      // The registry as it looks after `activateKey(FIELD_KID_V2)`: the old key still
      // decrypts (`rotating`), the new one encrypts (`active`).
      const after = new FieldCryptoService(
        await buildRegistry([
          fieldKeyRow({ status: 'rotating' }),
          fieldKeyRow({ kid: FIELD_KID_V2, key_ref: `env:${FIELD_ENV_V2}`, status: 'active' }),
          blindKeyRow(),
        ]),
      );

      const rotated = after.reencrypt(ciphertext, { aad: AAD_A });
      expect(rotated).not.toBe(ciphertext);
      expect(parseCiphertext(rotated).kid).toBe(FIELD_KID_V2);
      expect(after.decrypt(rotated, { aad: AAD_A })).toBe('someone@example.com');

      // Still bound to the row it came from — rotation must not loosen the AAD binding.
      expectDecryptionFailure(() => after.decrypt(rotated, { aad: AAD_B }), 'auth_failed');
    });
  });
});
