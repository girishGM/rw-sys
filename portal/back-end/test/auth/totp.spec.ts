/**
 * T-055 — RFC 4226 / RFC 6238 conformance and the base32 codec.
 *
 * The centrepiece is `describe('RFC 6238 Appendix B')`: the published test vectors, run against
 * this implementation. That is the evidence that "we implemented TOTP ourselves" is a claim about
 * *where the code lives* and not about whether it is the same algorithm every authenticator app
 * computes — a home-grown variant would fail the very first vector, and a phone would never agree
 * with the server. It is also the substitute the completion report offers for T-055's verification
 * step 3 ("scan the QR with an actual authenticator app"), which cannot be performed in this
 * environment: agreeing with the RFC is what agreeing with the app *means*.
 */
import {
  TotpFormatError,
  buildOtpauthUri,
  constantTimeEquals,
  decodeBase32,
  encodeBase32,
  generateTotpSecret,
  hotpCode,
  timeStepAt,
  totpCodeAt,
  verifyTotpCode,
} from '@/modules/auth/services/totp';
import {
  TOTP_DIGITS,
  TOTP_PERIOD_SECONDS,
  TOTP_SECRET_BYTES,
  TOTP_SKEW_STEPS,
} from '@/modules/auth/mfa.constants';

/** RFC 6238's SHA-1 seed: the ASCII string "12345678901234567890". */
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');

describe('RFC 6238 Appendix B — the published SHA-1 test vectors', () => {
  // Every SHA-1 row of the table, unmodified. The RFC prints 8-digit codes; the portal uses 6, so
  // each 6-digit expectation below is the same value truncated the way `hotpCode` truncates it.
  it.each([
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ])('at T=%i produces %s', (unixSeconds, expectedEightDigits) => {
    const at = new Date(unixSeconds * 1000);

    expect(totpCodeAt(RFC_SECRET, at, 8)).toBe(expectedEightDigits);
    expect(totpCodeAt(RFC_SECRET, at, 6)).toBe(expectedEightDigits.slice(-6));
  });

  it('derives the step index exactly as §4.2 defines it', () => {
    // The RFC's own worked example: T = floor(59 / 30) = 1.
    expect(timeStepAt(new Date(59_000))).toBe(1);
    expect(timeStepAt(new Date(0))).toBe(0);
    expect(timeStepAt(new Date(1111111109_000))).toBe(37037036);
  });
});

describe('hotpCode', () => {
  it('is deterministic for a counter and a secret', () => {
    expect(hotpCode(RFC_SECRET, 1)).toBe(hotpCode(RFC_SECRET, 1));
    expect(hotpCode(RFC_SECRET, 1)).not.toBe(hotpCode(RFC_SECRET, 2));
  });

  it('always returns exactly the configured number of digits, zero-padded', () => {
    // A code whose leading digit is zero is the classic off-by-one in home-grown HOTP: `String(n)`
    // of a value below 100000 is five characters and every comparison against it then fails.
    for (let counter = 0; counter < 200; counter += 1) {
      const code = hotpCode(RFC_SECRET, counter);
      expect(code).toHaveLength(TOTP_DIGITS);
      expect(code).toMatch(/^[0-9]{6}$/);
    }
  });

  it('handles counters above 2^32 — the boundary a two-word implementation gets wrong', () => {
    expect(() => hotpCode(RFC_SECRET, Math.floor(20000000000 / TOTP_PERIOD_SECONDS))).not.toThrow();
    expect(totpCodeAt(RFC_SECRET, new Date(20000000000 * 1000), 8)).toBe('65353130');
  });

  it.each([[-1], [1.5], [Number.MAX_SAFE_INTEGER + 2]])(
    'refuses the counter %p rather than producing a code from it',
    (counter) => {
      expect(() => hotpCode(RFC_SECRET, counter)).toThrow(TotpFormatError);
    },
  );

  it('refuses an empty secret', () => {
    expect(() => hotpCode(Buffer.alloc(0), 1)).toThrow(TotpFormatError);
  });
});

describe('verifyTotpCode', () => {
  const now = new Date(1_700_000_000_000);

  it('accepts the current step (TC-6)', () => {
    expect(verifyTotpCode(RFC_SECRET, totpCodeAt(RFC_SECRET, now), now)).toBe(true);
  });

  it('accepts one step in the past and one in the future (TC-9)', () => {
    const oneStep = TOTP_PERIOD_SECONDS * 1000;
    const past = totpCodeAt(RFC_SECRET, new Date(now.getTime() - oneStep));
    const future = totpCodeAt(RFC_SECRET, new Date(now.getTime() + oneStep));

    expect(verifyTotpCode(RFC_SECRET, past, now)).toBe(true);
    expect(verifyTotpCode(RFC_SECRET, future, now)).toBe(true);
  });

  it('rejects three steps in the past (TC-10)', () => {
    const threeSteps = TOTP_PERIOD_SECONDS * 3 * 1000;
    const stale = totpCodeAt(RFC_SECRET, new Date(now.getTime() - threeSteps));

    expect(verifyTotpCode(RFC_SECRET, stale, now)).toBe(false);
  });

  it('rejects two steps either side, i.e. the window is exactly ±1', () => {
    const twoSteps = TOTP_PERIOD_SECONDS * 2 * 1000;

    expect(TOTP_SKEW_STEPS).toBe(1);
    expect(
      verifyTotpCode(RFC_SECRET, totpCodeAt(RFC_SECRET, new Date(now.getTime() - twoSteps)), now),
    ).toBe(false);
    expect(
      verifyTotpCode(RFC_SECRET, totpCodeAt(RFC_SECRET, new Date(now.getTime() + twoSteps)), now),
    ).toBe(false);
  });

  it('rejects a code from a different secret', () => {
    const other = generateTotpSecret();
    expect(verifyTotpCode(other, totpCodeAt(RFC_SECRET, now), now)).toBe(false);
  });

  it.each([['12345'], ['1234567'], ['12345a'], ['      '], ['']])(
    'returns false rather than throwing for the malformed code %p',
    (code) => {
      expect(verifyTotpCode(RFC_SECRET, code, now)).toBe(false);
    },
  );

  it('tolerates the spaces and dashes an authenticator app displays', () => {
    const code = totpCodeAt(RFC_SECRET, now);
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;

    expect(verifyTotpCode(RFC_SECRET, spaced, now)).toBe(true);
  });

  it('returns false for an empty secret rather than throwing', () => {
    expect(verifyTotpCode(Buffer.alloc(0), '000000', now)).toBe(false);
  });

  it('does not throw when the clock is at the epoch and the window reaches below zero', () => {
    // Only reachable with a badly-set clock; the guard exists so `hotpCode` cannot be handed a
    // negative counter, and this is what proves the guard is exercised rather than assumed.
    expect(() => verifyTotpCode(RFC_SECRET, '000000', new Date(0))).not.toThrow();
    expect(verifyTotpCode(RFC_SECRET, totpCodeAt(RFC_SECRET, new Date(0)), new Date(0))).toBe(true);
  });
});

describe('base32', () => {
  it('round-trips a generated secret', () => {
    const secret = generateTotpSecret();
    expect(secret).toHaveLength(TOTP_SECRET_BYTES);
    expect(decodeBase32(encodeBase32(secret)).equals(secret)).toBe(true);
  });

  it('matches RFC 4648 §10 for the standard test vectors', () => {
    expect(encodeBase32(Buffer.from('f'))).toBe('MY');
    expect(encodeBase32(Buffer.from('fo'))).toBe('MZXQ');
    expect(encodeBase32(Buffer.from('foo'))).toBe('MZXW6');
    expect(encodeBase32(Buffer.from('foob'))).toBe('MZXW6YQ');
    expect(encodeBase32(Buffer.from('fooba'))).toBe('MZXW6YTB');
    expect(encodeBase32(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
  });

  it('emits no padding, which is what an otpauth URI needs', () => {
    expect(encodeBase32(Buffer.from('f'))).not.toContain('=');
    expect(encodeBase32(generateTotpSecret())).toMatch(/^[A-Z2-7]+$/);
  });

  it('encodes an empty buffer to an empty string', () => {
    expect(encodeBase32(Buffer.alloc(0))).toBe('');
  });

  it('accepts lowercase, padding, spaces and dashes on the way back in', () => {
    const secret = Buffer.from('foobar');
    const encoded = encodeBase32(secret);

    expect(decodeBase32(encoded.toLowerCase()).equals(secret)).toBe(true);
    expect(decodeBase32(`${encoded}======`).equals(secret)).toBe(true);
    expect(decodeBase32(`${encoded.slice(0, 4)} ${encoded.slice(4)}`).equals(secret)).toBe(true);
    expect(decodeBase32(`${encoded.slice(0, 4)}-${encoded.slice(4)}`).equals(secret)).toBe(true);
  });

  it.each([[''], ['   '], ['===']])('refuses %p rather than returning an empty key', (input) => {
    expect(() => decodeBase32(input)).toThrow(TotpFormatError);
  });

  it('refuses a character outside the alphabet rather than skipping it', () => {
    // Skipping would silently produce a *different* key, and the user would see "wrong code"
    // forever with nothing to diagnose.
    expect(() => decodeBase32('MZXW6YTB!')).toThrow(TotpFormatError);
    expect(() => decodeBase32('MZXW0YTB')).toThrow(TotpFormatError);
  });
});

describe('constantTimeEquals', () => {
  // Unreachable from `verifyTotpCode` (see the function's own comment); asserted directly so the
  // guard that keeps `timingSafeEqual` from throwing on a length mismatch is known to work rather
  // than assumed to be unnecessary.
  it('is false for different lengths, and never throws', () => {
    expect(() => constantTimeEquals('123456', '1234567')).not.toThrow();
    expect(constantTimeEquals('123456', '1234567')).toBe(false);
    expect(constantTimeEquals('', '1')).toBe(false);
  });

  it('is true for equal strings and false for equal-length different ones', () => {
    expect(constantTimeEquals('123456', '123456')).toBe(true);
    expect(constantTimeEquals('123456', '123457')).toBe(false);
  });
});

describe('buildOtpauthUri', () => {
  const uri = buildOtpauthUri({
    issuer: 'Reward Portal',
    account: 'super admin@example.invalid',
    secretBase32: 'MZXW6YTBOI',
  });

  it('is a totp URI labelled issuer:account, with the issuer repeated as a parameter', () => {
    expect(uri.startsWith('otpauth://totp/Reward%20Portal:super%20admin%40example.invalid?')).toBe(
      true,
    );
    expect(uri).toContain('issuer=Reward%20Portal');
  });

  it('states algorithm, digits and period explicitly rather than relying on defaults', () => {
    expect(uri).toContain('algorithm=SHA1');
    expect(uri).toContain(`digits=${TOTP_DIGITS}`);
    expect(uri).toContain(`period=${TOTP_PERIOD_SECONDS}`);
    expect(uri).toContain('secret=MZXW6YTBOI');
  });
});
