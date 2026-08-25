/**
 * T-016 — `key_ref` pointer handling.
 *
 * The centrepiece is TC-12: a `key_ref` that is itself key material must stop the boot.
 * 07-DATA-PROTECTION.md §3 calls storing key bytes here "the same as not encrypting at all",
 * and the task file names TC-12 as one of "the two that catch the mistakes that look fine in
 * review". Every plausible way of pasting a key into this column is enumerated below.
 */
import {
  base64ByteLength,
  decodeKeyMaterial,
  EnvKeyMaterialResolver,
  hexByteLength,
  KEY_MATERIAL_BYTE_THRESHOLD,
  KeyRegistryError,
  looksLikeKeyMaterial,
  parseKeyRef,
  UnconfiguredKmsResolver,
} from '@/common/crypto';
import { randomBytes } from 'node:crypto';

describe('key_ref resolution', () => {
  describe('TC-12 — a key_ref holding actual key material is refused', () => {
    const key = randomBytes(32);

    it.each([
      ['bare base64', key.toString('base64')],
      ['bare base64url', key.toString('base64url')],
      ['bare hex', key.toString('hex')],
      ['base64 behind env:', `env:${key.toString('base64')}`],
      ['base64url behind env:', `env:${key.toString('base64url')}`],
      ['hex behind env:', `env:${key.toString('hex')}`],
      ['base64 behind kms:', `kms:${key.toString('base64')}`],
      ['unpadded base64', key.toString('base64').replace(/=+$/, '')],
    ])('refuses %s', (_label, keyRef) => {
      expect(() => parseKeyRef(keyRef, 'fld_2026_01')).toThrow(KeyRegistryError);
      expect(() => parseKeyRef(keyRef, 'fld_2026_01')).toThrow(/key material|not a pointer/i);
    });

    it('refuses anything decoding to the threshold or more, and permits less', () => {
      expect(KEY_MATERIAL_BYTE_THRESHOLD).toBe(32);
      expect(looksLikeKeyMaterial(randomBytes(32).toString('base64'))).toBe(true);
      expect(looksLikeKeyMaterial(randomBytes(64).toString('base64'))).toBe(true);
      expect(looksLikeKeyMaterial(randomBytes(16).toString('base64'))).toBe(false);
    });

    it('does not mistake a realistic environment variable name for a key', () => {
      for (const name of [
        'FIELD_KEY_2026_01',
        'BLIND_INDEX_KEY_2026_01',
        'PORTAL_TRANSPORT_KEY',
        'K',
      ]) {
        expect(looksLikeKeyMaterial(name)).toBe(false);
        expect(parseKeyRef(`env:${name}`, 'kid')).toEqual({ scheme: 'env', locator: name });
      }
    });

    it('errs towards refusing: a long alphanumeric env name is treated as key material', () => {
      // Documented false positive. The fix is "rename the variable"; the alternative is a
      // heuristic loose enough to let a real pasted key through, which is not a trade worth
      // making. Asserted so the behaviour is deliberate rather than discovered later.
      const longName = 'A'.repeat(44);
      expect(looksLikeKeyMaterial(longName)).toBe(true);
      expect(() => parseKeyRef(`env:${longName}`, 'kid')).toThrow(KeyRegistryError);
    });
  });

  describe('byte-length probes', () => {
    it.each([
      ['', null],
      ['!!!!', null],
      ['QUJD', 3],
      ['QUI=', 2],
      ['QQ==', 1],
      ['QQQQQ', null], // length % 4 === 1 is impossible for base64
    ])('base64ByteLength(%p) === %p', (value, expected) => {
      expect(base64ByteLength(value as string)).toBe(expected);
    });

    it.each([
      ['', null],
      ['abc', null], // odd length
      ['zz', null], // not hex
      ['00ff', 2],
    ])('hexByteLength(%p) === %p', (value, expected) => {
      expect(hexByteLength(value as string)).toBe(expected);
    });
  });

  describe('scheme validation', () => {
    it('accepts a well-formed KMS ARN', () => {
      const arn = 'arn:aws:kms:ap-southeast-1:123456789012:key/abcd-ef';
      expect(parseKeyRef(`kms:${arn}`, 'kid')).toEqual({ scheme: 'kms', locator: arn });
    });

    it.each([
      ['no scheme at all', 'FIELD_KEY'],
      ['an unknown scheme', 'vault:secret/data/field-key'],
      ['an env name starting with a digit', 'env:1KEY'],
      ['an env name with a hyphen', 'env:FIELD-KEY'],
      ['a malformed ARN', 'kms:not-an-arn'],
      ['an empty locator', 'env:'],
    ])('rejects %s', (_label, keyRef) => {
      expect(() => parseKeyRef(keyRef, 'kid')).toThrow(KeyRegistryError);
    });

    it('names the offending kid so an operator can find the row', () => {
      expect(() => parseKeyRef('nope', 'fld_2026_07')).toThrow(/fld_2026_07/);
    });
  });

  describe('EnvKeyMaterialResolver', () => {
    const KEY = randomBytes(32);

    it('reads base64 by default', async () => {
      const resolver = new EnvKeyMaterialResolver({ K: KEY.toString('base64') });
      const material = await resolver.resolve({ scheme: 'env', locator: 'K' }, 'kid');
      expect(material.equals(KEY)).toBe(true);
    });

    it('reads an explicit base64: prefix', async () => {
      const resolver = new EnvKeyMaterialResolver({ K: `base64:${KEY.toString('base64')}` });
      expect((await resolver.resolve({ scheme: 'env', locator: 'K' }, 'kid')).equals(KEY)).toBe(
        true,
      );
    });

    it('reads an explicit hex: prefix', async () => {
      const resolver = new EnvKeyMaterialResolver({ K: `hex:${KEY.toString('hex')}` });
      expect((await resolver.resolve({ scheme: 'env', locator: 'K' }, 'kid')).equals(KEY)).toBe(
        true,
      );
    });

    it('TC-11 — a missing variable stops the boot with a message naming it', async () => {
      const resolver = new EnvKeyMaterialResolver({});
      await expect(
        resolver.resolve({ scheme: 'env', locator: 'MISSING' }, 'fld_1'),
      ).rejects.toThrow(/Environment variable 'MISSING'.*is not set/s);
    });

    it('treats an empty variable as missing rather than as a zero-length key', async () => {
      const resolver = new EnvKeyMaterialResolver({ K: '' });
      await expect(resolver.resolve({ scheme: 'env', locator: 'K' }, 'kid')).rejects.toThrow(
        KeyRegistryError,
      );
    });

    it('defaults to the real process environment', async () => {
      const resolver = new EnvKeyMaterialResolver();
      process.env.T016_TMP_KEY = KEY.toString('base64');
      try {
        const material = await resolver.resolve({ scheme: 'env', locator: 'T016_TMP_KEY' }, 'kid');
        expect(material.equals(KEY)).toBe(true);
      } finally {
        delete process.env.T016_TMP_KEY;
      }
    });
  });

  describe('decodeKeyMaterial', () => {
    it.each([
      ['not base64', '!!!!'],
      ['bad hex behind hex:', 'hex:zzzz'],
      ['odd-length hex behind hex:', 'hex:abc'],
    ])('rejects %s', (_label, raw) => {
      expect(() => decodeKeyMaterial(raw, 'K', 'kid')).toThrow(KeyRegistryError);
    });

    it('never echoes the value back in the error message', () => {
      const secretish = '!!!!SUPER_SECRET_VALUE!!!!';
      try {
        decodeKeyMaterial(secretish, 'K', 'kid');
        throw new Error('expected a throw');
      } catch (err) {
        expect((err as Error).message).not.toContain('SUPER_SECRET_VALUE');
        expect((err as Error).message).toContain("'K'");
      }
    });

    it('accepts base64url input and decodes it to the same bytes', () => {
      const raw = Buffer.from(Array.from({ length: 32 }, (_, i) => i * 7));
      expect(decodeKeyMaterial(raw.toString('base64url'), 'K', 'kid').equals(raw)).toBe(true);
    });

    /**
     * Non-canonical base64: `QR` and `QQ` both decode to the single byte 0x41, because the
     * trailing bits of `R` fall off the end. Every decoder accepts both silently, so without
     * this check two different spellings of the same environment variable are the same key —
     * and "did the key actually change?" stops being answerable by comparing the values.
     */
    it('rejects non-canonical base64 rather than silently normalising it', () => {
      expect(Buffer.from('QR', 'base64').equals(Buffer.from('QQ', 'base64'))).toBe(true);
      expect(() => decodeKeyMaterial('QR', 'K', 'kid')).toThrow(KeyRegistryError);
      expect(() => decodeKeyMaterial('QR', 'K', 'kid')).toThrow(/not canonical base64/);
      expect(decodeKeyMaterial('QQ', 'K', 'kid').equals(Buffer.of(0x41))).toBe(true);
    });

    it('accepts every spelling a key-generating command actually emits', () => {
      const raw = randomBytes(32);
      for (const spelling of [
        raw.toString('base64'), // openssl rand -base64 32  (padded, standard alphabet)
        raw.toString('base64').replace(/=+$/, ''), // the same, unpadded
        raw.toString('base64url'), // URL-safe
        `base64:${raw.toString('base64')}`,
        `hex:${raw.toString('hex')}`, // openssl rand -hex 32
      ]) {
        expect(decodeKeyMaterial(spelling, 'K', 'kid').equals(raw)).toBe(true);
      }
    });
  });

  describe('UnconfiguredKmsResolver', () => {
    it('refuses to resolve and says why, with no env fallback', async () => {
      const resolver = new UnconfiguredKmsResolver();
      expect(resolver.scheme).toBe('kms');
      await expect(
        resolver.resolve({ scheme: 'kms', locator: 'arn:aws:kms:x:1:key/y' }, 'kid'),
      ).rejects.toThrow(/no KMS resolver is configured/);
      await expect(
        resolver.resolve({ scheme: 'kms', locator: 'arn:aws:kms:x:1:key/y' }, 'kid'),
      ).rejects.toThrow(/no environment-variable fallback/);
    });
  });
});
