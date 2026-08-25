/**
 * T-016 — the envelope codec, tested on its own without any key.
 *
 * This is the code that reads attacker-controlled bytes, so the tests below are mostly
 * "what happens when the input is wrong" rather than "what happens when it is right".
 * Covers TC-3 (format) and TC-7 (malformed input) at the parser level; the same cases are
 * re-run end-to-end through `FieldCryptoService` in `field-crypto.service.spec.ts`.
 */
import {
  AUTH_TAG_BYTES,
  CIPHERTEXT_VERSION,
  ciphertextPrefixFor,
  decodeBase64Strict,
  DecryptionError,
  formatCiphertext,
  IV_BYTES,
  KID_PATTERN,
  KID_PATTERN_ALLOWS_UNDERSCORE,
  looksLikeCiphertext,
  parseCiphertext,
} from '@/common/crypto';

const IV = Buffer.alloc(IV_BYTES, 1);
const TAG = Buffer.alloc(AUTH_TAG_BYTES, 2);
const CT = Buffer.from('ciphertext-bytes');
const KID = 'fld_2026_01';

const VALID = formatCiphertext(KID, IV, TAG, CT);

/** Asserts the call throws a `DecryptionError` carrying `reason` — and nothing else. */
function expectDecryptionError(fn: () => unknown, reason: string): void {
  expect(fn).toThrow(DecryptionError);
  try {
    fn();
    throw new Error('expected a throw');
  } catch (err) {
    expect(err).toBeInstanceOf(DecryptionError);
    expect((err as DecryptionError).reason).toBe(reason);
  }
}

describe('ciphertext envelope', () => {
  describe('TC-3 — format', () => {
    it('is exactly v1.<kid>.<iv>.<tag>.<ct>', () => {
      expect(VALID).toBe(
        `v1.${KID}.${IV.toString('base64')}.${TAG.toString('base64')}.${CT.toString('base64')}`,
      );
      expect(VALID.split('.')).toHaveLength(5);
    });

    it('round-trips through the parser', () => {
      const parsed = parseCiphertext(VALID);
      expect(parsed.version).toBe(CIPHERTEXT_VERSION);
      expect(parsed.kid).toBe(KID);
      expect(parsed.iv.equals(IV)).toBe(true);
      expect(parsed.tag.equals(TAG)).toBe(true);
      expect(parsed.ct.equals(CT)).toBe(true);
    });

    it('uses a 96-bit IV and a 128-bit tag, per 07-DATA-PROTECTION.md §4', () => {
      expect(IV_BYTES).toBe(12);
      expect(AUTH_TAG_BYTES).toBe(16);
    });

    it('accepts a zero-length body — the empty string is a real value', () => {
      const empty = formatCiphertext(KID, IV, TAG, Buffer.alloc(0));
      expect(parseCiphertext(empty).ct).toHaveLength(0);
    });
  });

  describe('TC-7 — malformed input raises a typed error and returns nothing', () => {
    it.each([
      ['garbage', 'malformed'],
      ['', 'malformed'],
      ['v1', 'malformed'],
      ['v1.kid.iv.tag', 'malformed'],
      [`${VALID}.extra`, 'malformed'],
      [`v2.${KID}.${IV.toString('base64')}.${TAG.toString('base64')}.`, 'unsupported_version'],
      [`vX.${KID}.${IV.toString('base64')}.${TAG.toString('base64')}.`, 'malformed'],
    ])('rejects %p with reason %p', (value, reason) => {
      expectDecryptionError(() => parseCiphertext(value), reason);
    });

    it.each([null, undefined, 42, {}, [], Buffer.from('x')])(
      'rejects the non-string %p',
      (value) => {
        expectDecryptionError(() => parseCiphertext(value), 'malformed');
      },
    );

    it('rejects a kid outside the permitted alphabet', () => {
      const bad = `v1.has space.${IV.toString('base64')}.${TAG.toString('base64')}.`;
      expectDecryptionError(() => parseCiphertext(bad), 'malformed');
    });

    it('rejects a kid longer than encryption_keys.kid can hold', () => {
      const bad = `v1.${'k'.repeat(41)}.${IV.toString('base64')}.${TAG.toString('base64')}.`;
      expectDecryptionError(() => parseCiphertext(bad), 'malformed');
    });

    it('rejects an IV of the wrong length', () => {
      const shortIv = Buffer.alloc(IV_BYTES - 1, 1).toString('base64');
      expectDecryptionError(
        () => parseCiphertext(`v1.${KID}.${shortIv}.${TAG.toString('base64')}.`),
        'malformed',
      );
    });

    it('rejects a tag of the wrong length', () => {
      const shortTag = Buffer.alloc(AUTH_TAG_BYTES - 1, 2).toString('base64');
      expectDecryptionError(
        () => parseCiphertext(`v1.${KID}.${IV.toString('base64')}.${shortTag}.`),
        'malformed',
      );
    });

    it.each(['iv', 'tag', 'ct'])('rejects non-base64 in the %s field', (field) => {
      const parts = VALID.split('.');
      parts[{ iv: 2, tag: 3, ct: 4 }[field] as number] = '!!!!not-base64!!!!';
      expectDecryptionError(() => parseCiphertext(parts.join('.')), 'malformed');
    });

    it('carries the kid on failures that got far enough to read one', () => {
      try {
        parseCiphertext(`v1.${KID}.AAAA.${TAG.toString('base64')}.`);
        throw new Error('expected a throw');
      } catch (err) {
        expect((err as DecryptionError).kid).toBe(KID);
      }
    });
  });

  describe('strict base64 decoding', () => {
    it('accepts the empty string as zero bytes', () => {
      expect(decodeBase64Strict('')).toHaveLength(0);
    });

    it.each(['QUJD', 'QUI=', 'QQ=='])('accepts correctly padded %p', (value) => {
      expect(decodeBase64Strict(value)).not.toBeNull();
    });

    it.each(['QQ', 'QUI', 'QQ=', '****', 'AB.CD', 'QQ==='])('rejects %p', (value) => {
      expect(decodeBase64Strict(value)).toBeNull();
    });

    it('rejects input Buffer.from would silently accept', () => {
      // The behaviour this guard exists for: Node drops out-of-alphabet characters instead
      // of failing, so `!!!!` decodes to an empty buffer rather than raising.
      expect(Buffer.from('!!!!', 'base64')).toHaveLength(0);
      expect(decodeBase64Strict('!!!!')).toBeNull();
    });
  });

  describe('helpers', () => {
    it('recognises a ciphertext by its version prefix', () => {
      expect(looksLikeCiphertext(VALID)).toBe(true);
      expect(looksLikeCiphertext('v1.')).toBe(true);
      expect(looksLikeCiphertext('plaintext')).toBe(false);
      expect(looksLikeCiphertext(null)).toBe(false);
      expect(looksLikeCiphertext(12)).toBe(false);
    });

    it('builds the rotation prefix a kid is matched by', () => {
      expect(ciphertextPrefixFor(KID)).toBe(`v1.${KID}.`);
      expect(VALID.startsWith(ciphertextPrefixFor(KID))).toBe(true);
    });

    it('permits underscores in a kid — which is why rotation cannot use LIKE', () => {
      expect(KID_PATTERN_ALLOWS_UNDERSCORE).toBe(true);
      expect(KID_PATTERN.test('fld_2026_01')).toBe(true);
      // The exact over-match a LIKE pattern would produce, spelled out.
      const likePattern = ciphertextPrefixFor('fld_2026_01').replace(/\./g, '\\.');
      expect(new RegExp(`^${likePattern.replace(/_/g, '.')}`).test('v1.fldX2026Y01.')).toBe(true);
    });
  });
});
