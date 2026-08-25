/**
 * T-016 — `BlindIndexService`. Covers TC-18…TC-21.
 *
 * A blind index is the one place in this module where a *deterministic* output is correct, so
 * the tests here are the mirror image of `field-crypto.service.spec.ts`'s: they assert that
 * the same input always produces the same digest, and then that the digest still gives nothing
 * away beyond equality.
 *
 * **TC-18 ("across processes") is pinned to a known-answer vector**, not merely to "two calls
 * agree". Two calls in one process would still agree if the implementation had picked up a
 * per-process salt, a locale, or `Math.random()` — and the failure mode that causes is a
 * portal where every login stops matching after a restart, with no error anywhere. The literal
 * hex below was produced by this implementation and is now frozen: any change to the
 * algorithm, the digest encoding, the key handling or the normalisation rule will break it,
 * which is exactly what should happen, because every one of those changes invalidates every
 * stored index in the database.
 */
import { createHmac } from 'node:crypto';
import {
  assertBlindIndexAllowed,
  BLIND_INDEX_ALLOWED_CLASSIFICATIONS,
  BLIND_INDEX_FIELD_NORMALISERS,
  BLIND_INDEX_HEX_LENGTH,
  BLIND_INDEX_NORMALISERS,
  BlindIndexError,
  BlindIndexService,
  FieldCryptoService,
  normaliserForField,
  type BlindIndexNormaliserName,
} from '@/common/crypto';
import { buildDefaultRegistry, BLIND_ENV, FIELD_ENV, keyMaterial, testEnv } from './support/keys';

/**
 * `HMAC-SHA256('john@x.com', <32 bytes of 0x33>)` in hex — see this file's header for why it
 * is a literal rather than a recomputation. `0x33` is the blind-index test key from
 * `support/keys.ts`; it is a test fixture, not a secret.
 */
const KNOWN_ANSWER_EMAIL = '4e9877db4e6671b019dc42cb0e6ec411647462eff8d3555ad3e41bbef4d94e6c';

const EMAIL_FIELD = 'reward_portal.portal_users.email';

let blindIndex: BlindIndexService;

beforeAll(async () => {
  blindIndex = new BlindIndexService(await buildDefaultRegistry());
});

describe('BlindIndexService', () => {
  describe('TC-18 — determinism', () => {
    it('produces the same index for the same input, every time', () => {
      const first = blindIndex.compute('john@x.com', 'email');
      for (let i = 0; i < 100; i += 1) {
        expect(blindIndex.compute('john@x.com', 'email')).toBe(first);
      }
    });

    it('matches a pinned known-answer vector — i.e. survives a restart', async () => {
      // A second, independently constructed service over a freshly resolved key buffer: the
      // closest a single-process test can get to "a different process".
      const other = new BlindIndexService(await buildDefaultRegistry());
      expect(other.compute('john@x.com', 'email')).toBe(KNOWN_ANSWER_EMAIL);
      expect(blindIndex.compute('john@x.com', 'email')).toBe(KNOWN_ANSWER_EMAIL);
    });

    it('is exactly HMAC-SHA256 of the normalised value, as lowercase hex', () => {
      // Pins the *construction*, independently of the pinned vector above: raw key bytes as
      // the HMAC key, the normalised plaintext as the message, utf8 in, hex out. No salt, no
      // prefix, no truncation.
      const expected = createHmac('sha256', Buffer.alloc(32, 0x33))
        .update('john@x.com', 'utf8')
        .digest('hex');
      expect(blindIndex.compute('john@x.com', 'email')).toBe(expected);
    });

    it('emits the full 32-byte digest as 64 hex characters', () => {
      const index = blindIndex.compute('someone@example.com', 'email');
      expect(BLIND_INDEX_HEX_LENGTH).toBe(64);
      expect(index).toHaveLength(BLIND_INDEX_HEX_LENGTH);
      expect(index).toMatch(/^[0-9a-f]{64}$/);
    });

    it('does not depend on the process locale', () => {
      // toLocaleLowerCase() under a Turkish locale maps 'I' to 'ı'; toLowerCase() does not.
      // If the implementation ever switches, this pair stops agreeing.
      expect(blindIndex.normalisedFor('INDEX@X.COM', 'email')).toBe('index@x.com');
      expect('I'.toLowerCase()).toBe('i');
    });
  });

  describe('TC-19 — normalisation', () => {
    it('gives John@X.com and john@x.com the same index', () => {
      expect(blindIndex.compute('John@X.com', 'email')).toBe(
        blindIndex.compute('john@x.com', 'email'),
      );
    });

    it.each([
      ['leading and trailing whitespace', '  john@x.com  '],
      ['mixed case', 'JoHn@X.CoM'],
      ['tabs and newlines around it', '\tjohn@x.com\n'],
      ['full-width characters', 'ｊｏｈｎ@x.com'],
    ])('normalises %s to the same index', (_label, variant) => {
      expect(blindIndex.compute(variant, 'email')).toBe(KNOWN_ANSWER_EMAIL);
    });

    it('collapses composed and decomposed Unicode to one index', () => {
      // 'é' as one code point vs 'e' + combining acute. Different bytes, same person.
      expect(blindIndex.compute('rené@x.com', 'email')).toBe(
        blindIndex.compute('rené@x.com', 'email'),
      );
    });

    it('does NOT merge gmail-style +tags or dots — they are conventions, not RFC rules', () => {
      expect(blindIndex.compute('john+news@x.com', 'email')).not.toBe(KNOWN_ANSWER_EMAIL);
      expect(blindIndex.compute('jo.hn@x.com', 'email')).not.toBe(KNOWN_ANSWER_EMAIL);
    });

    it('gives genuinely different addresses different indexes', () => {
      expect(blindIndex.compute('john@x.com', 'email')).not.toBe(
        blindIndex.compute('john@y.com', 'email'),
      );
    });

    describe('phone', () => {
      it('treats spacing, dashes and brackets as noise', () => {
        const canonical = blindIndex.compute('+60123457788', 'phone');
        for (const variant of ['+60 12-345 7788', '(+60)123457788', ' +60-123-457-788 ']) {
          expect(blindIndex.compute(variant, 'phone')).toBe(canonical);
        }
      });

      it('treats a bracketed country code as international, per the documented examples', () => {
        // Regression guard. The first implementation tested `startsWith('+')`, which put
        // `(+60)123457788` — one of the three forms its own doc comment promised were
        // equivalent — into the *national* bucket. Nothing would have errored: the two forms
        // would simply have had different indexes, and a lookup on one would never find the
        // other. Found by this suite, fixed in `blind-index.service.ts`.
        expect(blindIndex.normalisedFor('(+60)123457788', 'phone')).toBe('+60123457788');
        expect(blindIndex.normalisedFor('  (+60) 12-345 7788 ', 'phone')).toBe('+60123457788');
      });

      it('only counts a + that precedes every digit', () => {
        // '+' after a digit is punctuation, not a country-code marker, and is dropped.
        expect(blindIndex.normalisedFor('60123457788+', 'phone')).toBe('60123457788');
        expect(blindIndex.normalisedFor('601+23457788', 'phone')).toBe('60123457788');
        expect(blindIndex.compute('60123457788+', 'phone')).not.toBe(
          blindIndex.compute('+60123457788', 'phone'),
        );
      });

      it('does not infer a country code — national and international forms differ', () => {
        expect(blindIndex.compute('0123457788', 'phone')).not.toBe(
          blindIndex.compute('+60123457788', 'phone'),
        );
        expect(blindIndex.normalisedFor('0123457788', 'phone')).toBe('0123457788');
        expect(blindIndex.normalisedFor('+60 12 345 7788', 'phone')).toBe('+60123457788');
      });
    });

    describe('exact', () => {
      it('keeps case and whitespace significant', () => {
        expect(blindIndex.compute('Ref-001', 'exact')).not.toBe(
          blindIndex.compute('ref-001', 'exact'),
        );
        expect(blindIndex.compute(' Ref-001', 'exact')).not.toBe(
          blindIndex.compute('Ref-001', 'exact'),
        );
      });

      it('still applies canonical Unicode composition', () => {
        expect(blindIndex.compute('café', 'exact')).toBe(blindIndex.compute('café', 'exact'));
      });
    });

    it('every normaliser carries a version, because changing one invalidates the column', () => {
      for (const [name, rule] of Object.entries(BLIND_INDEX_NORMALISERS)) {
        expect(rule.version).toMatch(new RegExp(`^${name}\\.v\\d+$`));
        expect(rule.description.length).toBeGreaterThan(20);
      }
    });
  });

  describe('TC-20 — the blind-index key is not the field key', () => {
    it('uses the blind_index key ring, not the field one', async () => {
      const registry = await buildDefaultRegistry();
      const fieldKey = registry.getActiveKey('field');
      const blindKey = registry.getActiveKey('blind_index');

      expect(blindKey.kid).not.toBe(fieldKey.kid);
      expect(blindKey.material.equals(fieldKey.material)).toBe(false);
      expect(blindKey.algorithm).toBe('HMAC-SHA256');
      expect(fieldKey.algorithm).toBe('AES-256-GCM');

      // The digest is the one keyed with the blind-index key. Computing it with the field key
      // — the mistake this test exists for — yields something else entirely.
      const withBlindKey = new BlindIndexService(registry).compute('john@x.com', 'email');
      const withFieldKey = createHmac('sha256', fieldKey.material)
        .update('john@x.com', 'utf8')
        .digest('hex');
      expect(withBlindKey).not.toBe(withFieldKey);
    });

    it('refuses to load a registry where the two rings share material', async () => {
      // The registry-level half of the same guarantee, restated here so the property is
      // visible from the blind-index side too (the boot-time assertion lives in
      // key-registry.service.spec.ts).
      const { buildRegistry } = await import('./support/keys');
      const { fieldKeyRow, blindKeyRow } = await import('./support/keys');
      await expect(
        buildRegistry(
          [fieldKeyRow(), blindKeyRow()],
          testEnv({ [BLIND_ENV]: keyMaterial(0x11), [FIELD_ENV]: keyMaterial(0x11) }),
        ),
      ).rejects.toThrow(/resolve to identical key material/);
    });

    it('a value encrypted by FieldCryptoService shares nothing with its blind index', async () => {
      const registry = await buildDefaultRegistry();
      const ciphertext = new FieldCryptoService(registry).encrypt('john@x.com', {
        aad: FieldCryptoService.aadFor('reward_portal.portal_users', 1),
      });
      const index = new BlindIndexService(registry).compute('john@x.com', 'email');
      expect(ciphertext).not.toContain(index);
      expect(index).not.toContain('john');
    });
  });

  describe('TC-21 — a blind index exposes equality and nothing else', () => {
    it('is not reversible: the digest contains no trace of the input', () => {
      const secret = 'very-distinctive-plaintext@example.com';
      const index = blindIndex.compute(secret, 'email');
      expect(index).not.toContain(secret);
      expect(index).not.toContain('distinctive');
      expect(index).not.toContain('example');
      expect(Buffer.from(index, 'hex')).toHaveLength(32);
      // Fixed width regardless of input length — no length oracle.
      expect(blindIndex.compute('a@b.co', 'email')).toHaveLength(index.length);
      expect(blindIndex.compute('x'.repeat(5_000), 'email')).toHaveLength(index.length);
    });

    it('exposes equality — which is the whole feature, and the whole risk', () => {
      expect(blindIndex.compute('a@x.com', 'email')).toBe(blindIndex.compute('A@X.COM', 'email'));
      expect(blindIndex.compute('a@x.com', 'email')).not.toBe(
        blindIndex.compute('b@x.com', 'email'),
      );
    });

    it('changes completely for a one-character difference', () => {
      // No partial-match oracle: an attacker cannot narrow a guess by comparing prefixes.
      const a = blindIndex.compute('john@x.com', 'email');
      const b = blindIndex.compute('joho@x.com', 'email');
      expect(a).not.toBe(b);
      const sharedPrefix = [...a].findIndex((ch, i) => ch !== b[i]);
      expect(sharedPrefix).toBeLessThan(8);
    });

    it('restricts blind indexes to high-cardinality classifications', () => {
      expect(BLIND_INDEX_ALLOWED_CLASSIFICATIONS).toEqual(['pii', 'secret']);
      expect(() => assertBlindIndexAllowed('k', 'pii')).not.toThrow();
      expect(() => assertBlindIndexAllowed('k', 'secret')).not.toThrow();
      for (const classification of ['public', 'internal', 'confidential', 'made-up']) {
        expect(() => assertBlindIndexAllowed('policy.key', classification)).toThrow(
          BlindIndexError,
        );
        expect(() => assertBlindIndexAllowed('policy.key', classification)).toThrow(
          /frequency analysis/,
        );
      }
    });
  });

  describe('null handling and failure modes', () => {
    it('maps null and undefined to null rather than to the empty string’s index', () => {
      expect(blindIndex.compute(null, 'email')).toBeNull();
      expect(blindIndex.compute(undefined, 'email')).toBeNull();
      // If NULL hashed to a value, every NULL row would share it — a public "no value here"
      // flag over the whole column.
      expect(blindIndex.compute('', 'email')).not.toBeNull();
    });

    it('refuses a non-string value instead of coercing it', () => {
      expect(() => blindIndex.compute(42 as unknown as string, 'email')).toThrow(BlindIndexError);
    });

    it('refuses an unknown normaliser rather than defaulting to one', () => {
      const unknown = 'sha1ish' as BlindIndexNormaliserName;
      expect(() => blindIndex.compute('x', unknown)).toThrow(/Unknown blind-index normaliser/);
      expect(() => blindIndex.normalisedFor('x', unknown)).toThrow(
        /Unknown blind-index normaliser/,
      );
      // Checked before the null short-circuit, so a typo cannot hide behind a NULL column.
      expect(() => blindIndex.compute(null, unknown)).toThrow(BlindIndexError);
    });
  });

  describe('field registry', () => {
    it('resolves the login lookup key to the email normaliser', () => {
      expect(BLIND_INDEX_FIELD_NORMALISERS[EMAIL_FIELD]).toBe('email');
      expect(normaliserForField(EMAIL_FIELD)).toBe('email');
      expect(blindIndex.computeForField(EMAIL_FIELD, 'John@X.com')).toBe(KNOWN_ANSWER_EMAIL);
      expect(blindIndex.computeForField(EMAIL_FIELD, null)).toBeNull();
    });

    it('fails closed on a field with no registered rule', () => {
      expect(() => normaliserForField('reward_portal.portal_users.nickname')).toThrow(
        BlindIndexError,
      );
      expect(() => blindIndex.computeForField('nope.nope.nope', 'x')).toThrow(
        /No blind-index normalisation rule registered/,
      );
    });
  });
});
