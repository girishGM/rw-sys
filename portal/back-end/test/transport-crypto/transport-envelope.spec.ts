/**
 * T-018 — the envelope codec and the AAD binding.
 *
 * Covers TC-11 (tampered ciphertext), TC-13 (replay on another request), TC-15 (malformed
 * envelope) and the half of TC-12 that is cryptographic rather than HTTP. Everything here runs
 * without Nest, without a database and without a key registry, because parsing attacker-supplied
 * bytes is the part that has to be exhaustively testable.
 */
import { randomBytes } from 'node:crypto';
import {
  buildAad,
  EnvelopeError,
  isPayloadEnvelope,
  openBodyEnvelope,
  openEnvelope,
  sealEnvelope,
  WHOLE_BODY_PATH,
  type EnvelopeBinding,
} from '@/common/transport-crypto/transport-envelope';

const KEY = Buffer.alloc(32, 0x5a);
const OTHER_KEY = Buffer.alloc(32, 0xa5);

const BINDING: EnvelopeBinding = {
  kid: 'sess_3f6a1c88-3f2b-4a1e-9d21-6b0a7c9e5d44',
  direction: 'req',
  correlationId: 'corr-0123456789abcdef',
  path: WHOLE_BODY_PATH,
};

describe('isPayloadEnvelope', () => {
  it('accepts exactly the four documented keys, all strings', () => {
    expect(isPayloadEnvelope({ kid: 'a', iv: 'b', tag: 'c', ct: 'd' })).toBe(true);
  });

  it.each([
    ['null', null],
    ['a string', 'v1.kid.iv.tag.ct'],
    ['a number', 7],
    ['an array', [{ kid: 'a', iv: 'b', tag: 'c', ct: 'd' }]],
    ['a missing key', { kid: 'a', iv: 'b', tag: 'c' }],
    ['an extra key', { kid: 'a', iv: 'b', tag: 'c', ct: 'd', extra: 'e' }],
    ['a non-string value', { kid: 'a', iv: 'b', tag: 'c', ct: 7 }],
  ])('rejects %s', (_label, value) => {
    expect(isPayloadEnvelope(value)).toBe(false);
  });

  it('does not mistake an ordinary DTO for an envelope', () => {
    // The recognition rule is what keeps `fields` mode from decrypting real payload data.
    expect(isPayloadEnvelope({ campaignCode: 'T042', name: 'Summer', status: 'draft' })).toBe(
      false,
    );
  });
});

describe('sealEnvelope / openEnvelope', () => {
  it('round-trips a payload', () => {
    const envelope = sealEnvelope(KEY, '{"a":1}', BINDING);
    expect(openEnvelope(KEY, envelope, BINDING)).toBe('{"a":1}');
  });

  it('carries the binding kid on the wire', () => {
    expect(sealEnvelope(KEY, 'x', BINDING).kid).toBe(BINDING.kid);
  });

  it('never repeats an IV (TC-19 relies on this; a repeat would leak two plaintexts)', () => {
    const ivs = new Set<string>();
    for (let i = 0; i < 200; i += 1) ivs.add(sealEnvelope(KEY, 'same plaintext', BINDING).iv);
    expect(ivs.size).toBe(200);
  });

  it('produces different ciphertext for the same plaintext', () => {
    const a = sealEnvelope(KEY, 'same', BINDING);
    const b = sealEnvelope(KEY, 'same', BINDING);
    expect(a.ct).not.toBe(b.ct);
  });

  it('TC-11 — a tampered ciphertext fails the tag check rather than yielding plaintext', () => {
    const envelope = sealEnvelope(KEY, '{"secret":"hunter2"}', BINDING);
    const bytes = Buffer.from(envelope.ct, 'base64');
    bytes[0] ^= 0xff;

    expect(() => openEnvelope(KEY, { ...envelope, ct: bytes.toString('base64') }, BINDING)).toThrow(
      new EnvelopeError('auth_failed'),
    );
  });

  it('TC-11 — a tampered tag fails', () => {
    const envelope = sealEnvelope(KEY, 'x', BINDING);
    const tag = Buffer.from(envelope.tag, 'base64');
    tag[0] ^= 0xff;
    expect(() => openEnvelope(KEY, { ...envelope, tag: tag.toString('base64') }, BINDING)).toThrow(
      EnvelopeError,
    );
  });

  it('TC-12 — a different session key cannot open it', () => {
    const envelope = sealEnvelope(KEY, 'x', BINDING);
    expect(() => openEnvelope(OTHER_KEY, envelope, BINDING)).toThrow(
      new EnvelopeError('auth_failed'),
    );
  });

  it('TC-13 — an envelope replayed on a different request is rejected', () => {
    const envelope = sealEnvelope(KEY, 'x', BINDING);
    const replayed = { ...BINDING, correlationId: 'corr-ffffffffffffffff' };
    expect(() => openEnvelope(KEY, envelope, replayed)).toThrow(new EnvelopeError('auth_failed'));
  });

  it('a response envelope cannot be replayed as a request', () => {
    const envelope = sealEnvelope(KEY, 'x', { ...BINDING, direction: 'res' });
    expect(() => openEnvelope(KEY, envelope, { ...BINDING, direction: 'req' })).toThrow(
      EnvelopeError,
    );
  });

  it('an envelope cannot be moved to another field of the same body', () => {
    const envelope = sealEnvelope(KEY, '"hunter2"', { ...BINDING, path: 'currentPassword' });
    expect(() => openEnvelope(KEY, envelope, { ...BINDING, path: 'newPassword' })).toThrow(
      EnvelopeError,
    );
  });

  it("rejects a kid that is not the caller's, before doing any crypto", () => {
    const envelope = sealEnvelope(KEY, 'x', BINDING);
    expect(() => openEnvelope(KEY, { ...envelope, kid: 'sess_someone-else' }, BINDING)).toThrow(
      new EnvelopeError('malformed'),
    );
  });

  it('rejects something that is not an envelope at all', () => {
    expect(() => openEnvelope(KEY, { hello: 'world' }, BINDING)).toThrow(
      new EnvelopeError('not_an_envelope'),
    );
  });

  describe('TC-15 — malformed envelopes are rejected without a crash', () => {
    const envelope = sealEnvelope(KEY, 'x', BINDING);

    it.each([
      ['a non-base64 iv', { ...envelope, iv: '!!!!not base64!!!!' }],
      ['an empty iv', { ...envelope, iv: '' }],
      ['a short iv', { ...envelope, iv: Buffer.alloc(8).toString('base64') }],
      ['a long iv', { ...envelope, iv: Buffer.alloc(16).toString('base64') }],
      ['a non-base64 tag', { ...envelope, tag: '@@@@' }],
      ['a short tag', { ...envelope, tag: Buffer.alloc(8).toString('base64') }],
      ['a non-base64 ct', { ...envelope, ct: '####' }],
    ])('%s', (_label, tampered) => {
      expect(() => openEnvelope(KEY, tampered, BINDING)).toThrow(new EnvelopeError('malformed'));
    });

    it('an envelope missing `iv` entirely is not even recognised as one', () => {
      const missing: Record<string, unknown> = { ...envelope };
      delete missing.iv;
      expect(() => openEnvelope(KEY, missing, BINDING)).toThrow(
        new EnvelopeError('not_an_envelope'),
      );
    });
  });

  it('round-trips an empty payload', () => {
    expect(openEnvelope(KEY, sealEnvelope(KEY, '', BINDING), BINDING)).toBe('');
  });

  it('round-trips a payload at the 1 MB body limit', () => {
    const big = randomBytes(512 * 1024).toString('hex');
    expect(openEnvelope(KEY, sealEnvelope(KEY, big, BINDING), BINDING)).toBe(big);
  });
});

describe('buildAad', () => {
  it('is the five components, pipe-separated, in a fixed order', () => {
    expect(buildAad(BINDING).toString('utf8')).toBe(
      `v1|${BINDING.kid}|req|${BINDING.correlationId}|$`,
    );
  });

  it('changes when any single component changes', () => {
    const base = buildAad(BINDING).toString('utf8');
    expect(buildAad({ ...BINDING, kid: 'sess_other' }).toString('utf8')).not.toBe(base);
    expect(buildAad({ ...BINDING, direction: 'res' }).toString('utf8')).not.toBe(base);
    expect(buildAad({ ...BINDING, correlationId: 'other' }).toString('utf8')).not.toBe(base);
    expect(buildAad({ ...BINDING, path: 'field' }).toString('utf8')).not.toBe(base);
  });
});

describe('openBodyEnvelope', () => {
  it('parses the JSON inside', () => {
    const envelope = sealEnvelope(KEY, JSON.stringify({ email: 'a@b.test' }), BINDING);
    expect(openBodyEnvelope(KEY, envelope, BINDING)).toEqual({ email: 'a@b.test' });
  });

  it('accepts an array body', () => {
    const envelope = sealEnvelope(KEY, '[1,2,3]', BINDING);
    expect(openBodyEnvelope(KEY, envelope, BINDING)).toEqual([1, 2, 3]);
  });

  it('rejects a payload that is not JSON', () => {
    const envelope = sealEnvelope(KEY, 'not json at all', BINDING);
    expect(() => openBodyEnvelope(KEY, envelope, BINDING)).toThrow(new EnvelopeError('not_json'));
  });

  it.each([
    ['a bare string', '"hello"'],
    ['a number', '7'],
    ['null', 'null'],
  ])('rejects %s as a request body', (_label, json) => {
    const envelope = sealEnvelope(KEY, json, BINDING);
    expect(() => openBodyEnvelope(KEY, envelope, BINDING)).toThrow(new EnvelopeError('not_a_body'));
  });
});

describe('EnvelopeError', () => {
  it('carries a machine-readable reason and no payload detail', () => {
    const error = new EnvelopeError('auth_failed');
    expect(error.reason).toBe('auth_failed');
    expect(error.name).toBe('EnvelopeError');
    expect(error.message).not.toMatch(/hunter2|[A-Za-z0-9+/]{40,}/);
  });
});
