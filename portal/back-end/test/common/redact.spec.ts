/**
 * T-014 — TC-13 and TC-14, plus the failure modes a serialiser has to survive.
 *
 * TC-13: *"Log a payload containing `password`, `token`, `mfa_secret_enc` → all rendered as
 * `[REDACTED]`"*. TC-14: *"Nested/array payload with a secret 4 levels deep → redacted at
 * depth"*.
 *
 * The rest of this suite exists because `redact` runs on the error path: it is called while the
 * application is already handling a failure, often with whatever object caused it. A serialiser
 * that throws there converts a clean 403 into an unhandled 500, so "cannot throw" is tested as
 * carefully as "does mask".
 */
import {
  BINARY,
  CIRCULAR,
  MAX_REDACTION_DEPTH,
  REDACTED,
  SENSITIVE_KEY_PATTERN,
  TRUNCATED,
  isSensitiveKey,
  redact,
  redactForLog,
  redactSerialiser,
} from '@/common/logging/redact';

describe('redact', () => {
  describe('TC-13 — the keys implementation note 6 names', () => {
    it('masks password, token and mfa_secret_enc in one flat payload', () => {
      const result = redact({
        email: 'ops@example.com',
        password: 'hunter2-correct-horse',
        token: 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.abc',
        mfa_secret_enc: 'v1:base64ciphertext',
        displayName: 'Ops Person',
      });

      expect(result).toEqual({
        email: 'ops@example.com',
        password: REDACTED,
        token: REDACTED,
        mfa_secret_enc: REDACTED,
        displayName: 'Ops Person',
      });
    });

    it.each([
      'password',
      'newPassword',
      'password_hash',
      'accessToken',
      'refresh_token_hash',
      'client_secret',
      'Authorization',
      'cookie',
      'set-cookie',
      'key_hash',
      'mfaSecret',
      'MFA_RECOVERY_CODE',
    ])('masks %s regardless of case or separator', (key) => {
      expect(isSensitiveKey(key)).toBe(true);
      expect(redact({ [key]: 'secret-value' })).toEqual({ [key]: REDACTED });
    });

    it.each(['email', 'displayName', 'countryId', 'campaignName', 'status'])(
      'leaves %s alone — over-masking a whole payload would make logs useless',
      (key) => {
        expect(isSensitiveKey(key)).toBe(false);
        expect(redact({ [key]: 'value' })).toEqual({ [key]: 'value' });
      },
    );

    it('masks the whole value when a sensitive key holds an object, not just its leaves', () => {
      // `{ mfa: { secret: 'x' } }` must not become `{ mfa: { secret: '[REDACTED]' } }` — that
      // would still disclose the shape, and one un-listed child key would leak.
      expect(
        redact({ mfa: { secret: 'x', enrolledAt: '2026-08-18', backupCodes: ['a'] } }),
      ).toEqual({ mfa: REDACTED });
    });

    it('is a documented superset of the pattern the task file specifies', () => {
      expect(SENSITIVE_KEY_PATTERN.source).toBe(
        'password|token|secret|hash|authorization|cookie|key_hash|mfa',
      );
    });
  });

  describe('TC-14 — depth and arrays', () => {
    it('redacts a secret four levels deep', () => {
      const payload = {
        request: { body: { user: { credentials: { password: 'deep-secret', email: 'a@b.c' } } } },
      };

      expect(redact(payload)).toEqual({
        request: { body: { user: { credentials: { password: REDACTED, email: 'a@b.c' } } } },
      });
    });

    it('redacts inside arrays, and inside objects inside arrays', () => {
      const payload = {
        sessions: [
          { id: 1, refreshToken: 'rt-1' },
          { id: 2, refreshToken: 'rt-2', nested: [{ mfaSecret: 's' }] },
        ],
      };

      expect(redact(payload)).toEqual({
        sessions: [
          { id: 1, refreshToken: REDACTED },
          { id: 2, refreshToken: REDACTED, nested: [{ mfaSecret: REDACTED }] },
        ],
      });
    });

    it('redacts inside a Set and a Map, including a Map key that names a secret', () => {
      expect(redact({ items: new Set([{ token: 't' }, { id: 9 }]) })).toEqual({
        items: [{ token: REDACTED }, { id: 9 }],
      });
      expect(
        redact({
          entries: new Map<string, unknown>([
            ['password', 'x'],
            ['email', 'a@b.c'],
          ]),
        }),
      ).toEqual({ entries: { password: REDACTED, email: 'a@b.c' } });
    });

    it('truncates below the depth limit rather than recursing without bound', () => {
      let deep: Record<string, unknown> = { password: 'x' };
      for (let level = 0; level <= MAX_REDACTION_DEPTH + 2; level += 1) deep = { child: deep };

      // The assertion that matters is that it returns at all, and that the deepest rendered
      // value is the truncation marker rather than a fragment of the payload.
      expect(JSON.stringify(redact(deep))).toContain(TRUNCATED);
      expect(JSON.stringify(redact(deep))).not.toContain('"x"');
    });
  });

  describe('cannot throw, cannot corrupt', () => {
    it('does not mutate its input', () => {
      const payload = { password: 'original', nested: { token: 'original' } };
      redact(payload);
      expect(payload.password).toBe('original');
      expect(payload.nested.token).toBe('original');
    });

    it('renders a cycle as [CIRCULAR] instead of overflowing the stack', () => {
      const parent: Record<string, unknown> = { name: 'parent' };
      parent.self = parent;
      expect(redact(parent)).toEqual({ name: 'parent', self: CIRCULAR });
    });

    it('renders a shared (non-circular) reference twice — it is not a cycle', () => {
      const shared = { id: 1 };
      expect(redact({ a: shared, b: shared })).toEqual({ a: { id: 1 }, b: { id: 1 } });
    });

    it('masks binary blobs — key material and ciphertext live in Buffers', () => {
      expect(redact({ keyMaterial: Buffer.from('deadbeef', 'hex') })).toEqual({
        keyMaterial: BINARY,
      });
      expect(redact({ view: new Uint8Array([1, 2, 3]) })).toEqual({ view: BINARY });
      expect(redact({ raw: new ArrayBuffer(4) })).toEqual({ raw: BINARY });
    });

    it('keeps Dates as Dates and renders a RegExp as its source', () => {
      const when = new Date('2026-08-18T09:00:00.000Z');
      expect(redact({ when })).toEqual({ when });
      expect(redact({ pattern: /abc/i })).toEqual({ pattern: '/abc/i' });
    });

    it('survives a getter that throws', () => {
      const payload = {
        get decrypted(): string {
          throw new Error('decryption failed — no key');
        },
        id: 4,
      };
      expect(redact(payload)).toEqual({ decrypted: '[UNREADABLE]', id: 4 });
    });

    it('passes primitives, null and undefined straight through', () => {
      expect(redact(null)).toBeNull();
      expect(redact(undefined)).toBeUndefined();
      expect(redact(7)).toBe(7);
      expect(redact('a string with the word password in it')).toBe(
        'a string with the word password in it',
      );
      expect(redact(true)).toBe(true);
    });

    it('renders an Error with its stack, and redacts its custom properties', () => {
      // Sequelize attaches `sql` and `parameters` to its errors; the stack must survive because
      // this output is the *server* log, where it is the whole point (TC-8 concerns responses).
      const error = Object.assign(new Error('insert failed'), {
        sql: 'INSERT INTO reward_portal.portal_users …',
        password_hash: '$argon2id$v=19$…',
      });

      const result = redact(error) as Record<string, unknown>;

      expect(result.name).toBe('Error');
      expect(result.message).toBe('insert failed');
      expect(typeof result.stack).toBe('string');
      expect(result.sql).toBe('INSERT INTO reward_portal.portal_users …');
      expect(result.password_hash).toBe(REDACTED);
    });
  });

  describe('the serialiser wrappers', () => {
    it('redactForLog and redactSerialiser are redact, typed for a logger', () => {
      const payload = { password: 'x', id: 1 };
      expect(redactForLog(payload)).toEqual({ password: REDACTED, id: 1 });
      expect(redactSerialiser(payload)).toEqual({ password: REDACTED, id: 1 });
    });
  });
});
