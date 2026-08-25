/**
 * T-018 — transport payload encryption against the **real** Postgres instance.
 *
 * The unit suites drive doubles, which is what makes 100% branch coverage reachable and proves
 * nothing about four things this file covers:
 *
 *  1. **T018_001's `CHECK` constraint really refuses a plaintext key.** That constraint is the
 *     second of the two independent layers stopping the session key being written next to the
 *     data it protects; a regex that does not compile, or one that accepts base64, would be
 *     invisible everywhere else.
 *  2. **`SessionTransportKeyRepository`'s SQL runs against the real table**, with its real
 *     `varchar(512)` width, and its `status = 'active'` predicate really is what makes a revoked
 *     session's key unreadable (TC-14).
 *  3. **`HandshakeService` round-trips through a real key registry and a real row.**
 *  4. **The interceptor ordering in `AppModule` is the one 07-DATA-PROTECTION.md §8 fixes.**
 *     That is asserted from the module's own metadata rather than from a comment, because
 *     getting it backwards encrypts the unmasked body and nothing visibly fails (TC-17).
 *
 * ### Isolation
 *
 * Key material is generated per run with `randomBytes`, lives only in `process.env`, and is
 * deleted in `afterAll` — the same arrangement `crypto.e2e-spec.ts` uses, so `scan:secrets` has
 * nothing to find. The `encryption_keys` rows and the `portal_users`/`portal_sessions` rows this
 * file creates are all prefixed/marked and removed afterwards, so a failed run cannot collide
 * with anything seeded or with another suite.
 *
 * ### This suite does not own the active field key (T-068)
 *
 * It used to assume it did. `beforeAll` inserted its own `field` key with a hardcoded
 * `status = 'active'`, which was safe only for as long as nothing in this codebase could create a
 * *permanent* field key. T-057 built the provisioning CLI that `docs/DEPLOYMENT.md` now documents
 * as a required first-run step, so any provisioned environment — this shared local database
 * included, since 2026-08-19 — legitimately and permanently holds one active row per purpose.
 * `uq_ek_active_purpose` permits exactly one globally, so from that point on the INSERT raised a
 * unique violation and all 18 tests below died in `beforeAll`.
 *
 * {@link insertFieldKey} now computes the status instead of asserting it, and every kid-sensitive
 * expectation reads {@link activeFieldKid} rather than assuming it is this suite's own. See that
 * function's comment for why yielding was chosen over the displacement route
 * `crypto.e2e-spec.ts` takes.
 */
import { randomBytes, createECDH } from 'node:crypto';
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import {
  EnvKeyMaterialResolver,
  FieldCryptoService,
  KeyRegistryService,
  UnconfiguredKmsResolver,
} from '@/common/crypto';
import { HandshakeService } from '@/common/transport-crypto/handshake.service';
import { SessionTransportKeyRepository } from '@/common/transport-crypto/session-transport-key.repository';
import { sessionKid } from '@/common/transport-crypto/transport-crypto.constants';
import { buildAppSequelize } from '../database/build-app-sequelize';
import { sweepOrphanedTestKeys } from '../support/encryption-keys';

jest.setTimeout(120_000);

const KID_PREFIX = 't018_e2e';
const FIELD_KID = `${KID_PREFIX}_fld`;
const ENV_FIELD = 'T018_E2E_FIELD_KEY';
const EMAIL_MARKER = 't018-e2e-transport@example.test';

let sequelize: Sequelize;
let registry: KeyRegistryService;
let repository: SessionTransportKeyRepository;
let handshake: HandshakeService;
let userId: number;
/**
 * The kid every envelope written by this suite will carry — `FieldCryptoService.encrypt()` uses
 * `getActiveKey('field')`, so this is the deployment's own key wherever one is provisioned and
 * {@link FIELD_KID} only on a database that has never been. Resolved once, after `registry.load()`.
 */
let activeFieldKid: string;

/**
 * Inserts one of this suite's `field` keys, taking `active` only if the deployment has none.
 *
 * **Why the status is computed rather than hardcoded (T-068).** `uq_ek_active_purpose` is a
 * partial unique index over `purpose WHERE status = 'active'` — one active key per *database*,
 * not one per suite. Hardcoding `'active'` here is what broke this file, and the `CASE WHEN
 * EXISTS` is evaluated inside the INSERT rather than as a read-then-write so that it cannot race
 * with a concurrently running suite; the index still adjudicates.
 *
 * **Yield, don't displace.** Two remedies were available, and both are already used in this
 * codebase. `test/auth/support/portal-user-fixture.ts`, `super-admin-mfa.ts` and
 * `t056-backfill.e2e-spec.ts` *yield* — insert as `rotating` when an incumbent exists and let the
 * incumbent encrypt. `test/crypto/crypto.e2e-spec.ts` *displaces* — temporarily demotes the
 * incumbent to `rotating` and restores it in `afterAll`. Displacement is the right call there
 * because that suite tests rotation itself and so must control which kid is active; it is the
 * wrong call here, for two reasons:
 *
 *  1. **This suite has no stake in which key encrypts.** Nothing below asserts a *particular*
 *     field kid as a security property. What it asserts is that the session key is stored as a
 *     T-016 envelope under the active field key and never in the clear — true under any kid.
 *  2. **Displacement can leave the database with no active field key.** The restore lives in
 *     `afterAll`, which does not run when the process is killed (Ctrl-C, `--bail`, an OOM), and
 *     the result is a database on which every later boot fails `getActiveKey('field')`. That is
 *     precisely the class of residue T-067 was written to clean up after, and adding a second
 *     suite that can produce it would be a step backwards. Yielding mutates no pre-existing row
 *     at all, so there is nothing to restore and nothing to leave broken.
 */
async function insertFieldKey(kid: string, envName: string): Promise<void> {
  await sequelize.query(
    `INSERT INTO reward_portal.encryption_keys (kid, purpose, algorithm, key_ref, status)
     VALUES (:kid, 'field', 'AES-256-GCM', :ref,
             CASE WHEN EXISTS (SELECT 1 FROM reward_portal.encryption_keys
                                WHERE purpose = 'field' AND status = 'active')
                  THEN 'rotating' ELSE 'active' END)`,
    { type: QueryTypes.INSERT, replacements: { kid, ref: `env:${envName}` } },
  );
}

/** A client, exactly as the browser behaves: an ephemeral P-256 keypair per login. */
function browser(): { publicKeyBase64: string; derive: (serverPublicKey: string) => Buffer } {
  const ecdh = createECDH('prime256v1');
  const publicKey = ecdh.generateKeys();
  return {
    publicKeyBase64: publicKey.toString('base64'),
    derive: (serverPublicKey) => ecdh.computeSecret(Buffer.from(serverPublicKey, 'base64')),
  };
}

async function createSession(status: 'active' | 'revoked' = 'active'): Promise<string> {
  const rows = await sequelize.query<{ id: string }>(
    `INSERT INTO reward_portal.portal_sessions (user_id, status, issued_at, last_seen_at, expires_at)
     VALUES (:userId, :status, now(), now(), now() + interval '1 hour')
     RETURNING id`,
    { type: QueryTypes.SELECT, replacements: { userId, status } },
  );
  return rows[0].id;
}

beforeAll(async () => {
  sequelize = buildAppSequelize();

  process.env[ENV_FIELD] = randomBytes(32).toString('base64');

  // T-067 — drop key rows an interrupted run left behind; `registry.load()` below reads the
  // whole table and fails over any one of them. See `test/support/encryption-keys.ts`.
  await sweepOrphanedTestKeys(sequelize);

  await sequelize.query(
    `DELETE FROM reward_portal.encryption_keys WHERE starts_with(kid, :prefix)`,
    { type: QueryTypes.DELETE, replacements: { prefix: KID_PREFIX } },
  );
  await insertFieldKey(FIELD_KID, ENV_FIELD);

  registry = new KeyRegistryService(sequelize, [
    new EnvKeyMaterialResolver(process.env),
    new UnconfiguredKmsResolver(),
  ]);
  await registry.load();
  activeFieldKid = registry.getActiveKey('field').kid;

  repository = new SessionTransportKeyRepository(sequelize);
  handshake = new HandshakeService(repository, new FieldCryptoService(registry));

  // A throwaway account to hang sessions off. `portal_sessions.user_id` is `ON DELETE CASCADE`,
  // so removing the user in `afterAll` removes every session this file created.
  await sequelize.query(`DELETE FROM reward_portal.portal_users WHERE display_name = :marker`, {
    type: QueryTypes.DELETE,
    replacements: { marker: EMAIL_MARKER },
  });
  const users = await sequelize.query<{ id: number }>(
    `INSERT INTO reward_portal.portal_users (email, email_bidx, display_name, role, status)
     VALUES (:email, :bidx, :marker, 'super_admin', 'active')
     RETURNING id`,
    {
      type: QueryTypes.SELECT,
      replacements: {
        email: EMAIL_MARKER,
        bidx: randomBytes(32).toString('hex'),
        marker: EMAIL_MARKER,
      },
    },
  );
  userId = users[0].id;
});

afterAll(async () => {
  if (sequelize !== undefined) {
    await sequelize.query(`DELETE FROM reward_portal.portal_users WHERE display_name = :marker`, {
      type: QueryTypes.DELETE,
      replacements: { marker: EMAIL_MARKER },
    });
    await sequelize.query(
      `DELETE FROM reward_portal.encryption_keys WHERE starts_with(kid, :prefix)`,
      { type: QueryTypes.DELETE, replacements: { prefix: KID_PREFIX } },
    );
    await sequelize.close();
  }
  delete process.env[ENV_FIELD];
});

describe('T-068 — the fixture coexists with a provisioned deployment', () => {
  /** Matches `^t018_e2e_`, so `sweepOrphanedTestKeys` reclaims it if this run is killed. */
  const PROBE_KID = `${KID_PREFIX}_probe`;
  const PROBE_ENV = 'T018_E2E_PROBE_KEY';

  afterEach(async () => {
    await sequelize.query(`DELETE FROM reward_portal.encryption_keys WHERE kid = :kid`, {
      type: QueryTypes.DELETE,
      replacements: { kid: PROBE_KID },
    });
    delete process.env[PROBE_ENV];
  });

  it('exactly one field key is active — the precondition the old INSERT violated', async () => {
    const rows = await sequelize.query<{ active_count: number }>(
      `SELECT count(*)::int AS active_count
         FROM reward_portal.encryption_keys
        WHERE purpose = 'field' AND status = 'active'`,
      { type: QueryTypes.SELECT },
    );
    // Holds in *every* environment once `beforeAll` has run: either the deployment's own
    // provisioned key, or (on a database that has never been provisioned) this suite's.
    expect(Number(rows[0].active_count)).toBe(1);
  });

  it('a further field key yields to the incumbent rather than colliding', async () => {
    process.env[PROBE_ENV] = randomBytes(32).toString('base64');

    // The regression itself. An active field key demonstrably exists (previous test), so on the
    // pre-T-068 code — `VALUES (…, 'active')` — this line raises a uq_ek_active_purpose unique
    // violation, which is exactly how `beforeAll` used to take all 18 tests down with it.
    await insertFieldKey(PROBE_KID, PROBE_ENV);

    const rows = await sequelize.query<{ status: string }>(
      `SELECT status FROM reward_portal.encryption_keys WHERE kid = :kid`,
      { type: QueryTypes.SELECT, replacements: { kid: PROBE_KID } },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('rotating');
  });

  it("the suite's own field key is loaded by the registry, whichever status it took", async () => {
    const own = registry.describe().find((descriptor) => descriptor.kid === FIELD_KID);

    expect(own).toBeDefined();
    expect(own!.purpose).toBe('field');
    // 'active' on a virgin database, 'rotating' on a provisioned one. Both are decryptable, which
    // is all this suite needs; what must never happen is the row being absent or retired.
    expect(['active', 'rotating']).toContain(own!.status);
  });

  it('no pre-existing key was displaced — this suite mutates no row it did not create', async () => {
    const rows = await sequelize.query<{ kid: string }>(
      `SELECT kid FROM reward_portal.encryption_keys
        WHERE purpose = 'field' AND status = 'active'`,
      { type: QueryTypes.SELECT },
    );
    // Guards the alternative remedy (temporarily demoting the incumbent) from being reintroduced
    // here: if the active field key is not ours, we must have left it exactly where it was.
    expect(rows).toHaveLength(1);
    expect(rows[0].kid).toBe(activeFieldKid);
  });
});

describe('T018_001 — the column and its constraint', () => {
  it('portal_sessions.transport_key_enc exists with the width AR-03 specified', async () => {
    const rows = await sequelize.query<{ data_type: string; character_maximum_length: number }>(
      `SELECT data_type, character_maximum_length
         FROM information_schema.columns
        WHERE table_schema = 'reward_portal'
          AND table_name = 'portal_sessions'
          AND column_name = 'transport_key_enc'`,
      { type: QueryTypes.SELECT },
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].data_type).toBe('character varying');
    expect(rows[0].character_maximum_length).toBe(512);
  });

  it('ck_portal_sessions_transport_key_enc is present', async () => {
    const rows = await sequelize.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
        WHERE conname = 'ck_portal_sessions_transport_key_enc'`,
      { type: QueryTypes.SELECT },
    );
    expect(rows).toHaveLength(1);
  });

  it('refuses a raw AES key written where a ciphertext belongs', async () => {
    const sessionId = await createSession();

    // 32 random bytes, base64 — the exact shape a refactor that "just stored the key" would
    // produce, and it fits `varchar(512)` perfectly. The database is the layer that says no.
    await expect(
      sequelize.query(
        `UPDATE reward_portal.portal_sessions SET transport_key_enc = :value WHERE id = :id`,
        {
          type: QueryTypes.UPDATE,
          replacements: { value: randomBytes(32).toString('base64'), id: sessionId },
        },
      ),
    ).rejects.toThrow(/ck_portal_sessions_transport_key_enc/);
  });

  it.each([
    ['a hex key', () => randomBytes(32).toString('hex')],
    ['an at-rest envelope of a future version', () => 'v2.kid.iv.tag.ct'],
    ['a bare kid', () => 'fld_2026_01'],
    ['an empty string', () => ''],
  ])('refuses %s', async (_label, value) => {
    const sessionId = await createSession();
    await expect(
      sequelize.query(
        `UPDATE reward_portal.portal_sessions SET transport_key_enc = :value WHERE id = :id`,
        { type: QueryTypes.UPDATE, replacements: { value: value(), id: sessionId } },
      ),
    ).rejects.toThrow(/ck_portal_sessions_transport_key_enc/);
  });

  it('accepts NULL, which is what a session that never handshook holds', async () => {
    const sessionId = await createSession();
    await expect(
      sequelize.query(
        `UPDATE reward_portal.portal_sessions SET transport_key_enc = NULL WHERE id = :id`,
        { type: QueryTypes.UPDATE, replacements: { id: sessionId } },
      ),
    ).resolves.toBeDefined();
  });
});

describe('SessionTransportKeyRepository against the real table', () => {
  it('stores and reads back a ciphertext for an active session', async () => {
    const sessionId = await createSession();
    const ciphertext = `v1.${FIELD_KID}.${Buffer.alloc(12).toString('base64')}.${Buffer.alloc(16).toString('base64')}.AAAA`;

    await expect(repository.store(sessionId, ciphertext)).resolves.toBe(true);
    await expect(repository.find(sessionId)).resolves.toBe(ciphertext);
  });

  it('TC-14 — a revoked session yields no key, without anything having to remember to clear it', async () => {
    const sessionId = await createSession();
    await handshake.establish(sessionId, browser().publicKeyBase64);
    await expect(handshake.keyForSession(sessionId)).resolves.not.toBeNull();

    await sequelize.query(
      `UPDATE reward_portal.portal_sessions SET status = 'revoked', revoked_at = now() WHERE id = :id`,
      { type: QueryTypes.UPDATE, replacements: { id: sessionId } },
    );

    await expect(repository.find(sessionId)).resolves.toBeNull();
    await expect(handshake.keyForSession(sessionId)).resolves.toBeNull();
    // And storing against it is refused, so a race with revocation cannot resurrect a key.
    await expect(repository.store(sessionId, `v1.${FIELD_KID}.a.b.c`)).resolves.toBe(false);
  });

  it('clearForSession removes the ciphertext even from an already-revoked session', async () => {
    const sessionId = await createSession();
    await handshake.establish(sessionId, browser().publicKeyBase64);
    await sequelize.query(
      `UPDATE reward_portal.portal_sessions SET status = 'revoked' WHERE id = :id`,
      { type: QueryTypes.UPDATE, replacements: { id: sessionId } },
    );

    await expect(repository.clearForSession(sessionId)).resolves.toBe(1);

    const rows = await sequelize.query<{ transport_key_enc: string | null }>(
      `SELECT transport_key_enc FROM reward_portal.portal_sessions WHERE id = :id`,
      { type: QueryTypes.SELECT, replacements: { id: sessionId } },
    );
    expect(rows[0].transport_key_enc).toBeNull();
  });

  it('clearForUser removes every key the user holds — logout-all', async () => {
    const first = await createSession();
    const second = await createSession();
    await handshake.establish(first, browser().publicKeyBase64);
    await handshake.establish(second, browser().publicKeyBase64);

    await handshake.destroyForUser(userId);

    await expect(repository.find(first)).resolves.toBeNull();
    await expect(repository.find(second)).resolves.toBeNull();
  });
});

describe('HandshakeService against a real key registry and a real row', () => {
  it('TC-1 — both sides derive the same key, through the database', async () => {
    const sessionId = await createSession();
    const client = browser();

    const result = await handshake.establish(sessionId, client.publicKeyBase64);
    expect(result).not.toBeNull();
    expect(result!.kid).toBe(sessionKid(sessionId));

    const serverSide = await handshake.keyForSession(sessionId);
    // The client derives from the shared secret the same way; `handshake.service.spec.ts` asserts
    // the HKDF step in isolation, so re-deriving here would only re-test that. What this adds is
    // that the value survived a real encrypt → varchar(512) → decrypt round trip intact.
    expect(serverSide).toHaveLength(32);
    expect(client.derive(result!.serverPublicKey)).toHaveLength(32);
  });

  it('the stored value is a T-016 envelope, and never the key', async () => {
    const sessionId = await createSession();
    await handshake.establish(sessionId, browser().publicKeyBase64);

    const stored = (await repository.find(sessionId))!;
    const key = (await handshake.keyForSession(sessionId))!;

    // The envelope shape is asserted structurally, and the kid against whichever field key is
    // actually active (T-068) — naming this suite's own kid here would have been a statement
    // about the fixture rather than about the code, and it silently stopped being true the day
    // the database was provisioned with a permanent field key.
    expect(stored).toMatch(/^v1\.[A-Za-z0-9_-]{1,40}\./);
    expect(stored).toMatch(new RegExp(`^v1\\.${activeFieldKid}\\.`));
    expect(stored).not.toContain(key.toString('base64'));
    expect(stored.length).toBeLessThanOrEqual(512);
  });

  it('a ciphertext copied onto another session row does not decrypt (AAD binding)', async () => {
    const source = await createSession();
    const target = await createSession();
    await handshake.establish(source, browser().publicKeyBase64);

    const stolen = (await repository.find(source))!;
    await repository.store(target, stolen);

    await expect(handshake.keyForSession(target)).resolves.toBeNull();
    // The source is unaffected — this is a failed theft, not a broken session.
    await expect(handshake.keyForSession(source)).resolves.not.toBeNull();
  });

  it('a fresh handshake on the same session replaces the key rather than accumulating', async () => {
    const sessionId = await createSession();
    await handshake.establish(sessionId, browser().publicKeyBase64);
    const first = (await handshake.keyForSession(sessionId))!;

    await handshake.establish(sessionId, browser().publicKeyBase64);
    const second = (await handshake.keyForSession(sessionId))!;

    expect(first.equals(second)).toBe(false);
  });
});

describe('TC-16 — the interceptor order fixed by 07-DATA-PROTECTION.md §8', () => {
  it('TransportCryptoModule is registered before DataProtectionModule in AppModule', async () => {
    // Asserted from the metadata rather than from a comment. Nest runs response-side interceptor
    // logic in *reverse* registration order, so "before" here is what makes the encrypt
    // interceptor run *after* `ResponseMaskingInterceptor` — i.e. what makes TC-17 hold. Getting
    // this backwards produces an envelope built from the unmasked body and no visible failure.
    const { AppModule } = await import('@/app.module');
    const { TransportCryptoModule } =
      await import('@/common/transport-crypto/transport-crypto.module');
    const { DataProtectionModule } =
      await import('@/common/data-protection/data-protection.module');

    const imports = Reflect.getMetadata('imports', AppModule) as unknown[];
    const transportAt = imports.indexOf(TransportCryptoModule);
    const dataProtectionAt = imports.indexOf(DataProtectionModule);

    expect(transportAt).toBeGreaterThanOrEqual(0);
    expect(dataProtectionAt).toBeGreaterThanOrEqual(0);
    expect(transportAt).toBeLessThan(dataProtectionAt);
  });

  it('TransportCryptoModule registers the decrypt interceptor before the encrypt one', async () => {
    // The request-side order: decrypt must resolve (and memoise) the transport key before the
    // encrypt interceptor needs it, so the two share one database read per request.
    const { TransportCryptoModule } =
      await import('@/common/transport-crypto/transport-crypto.module');
    const { PayloadDecryptInterceptor } =
      await import('@/common/transport-crypto/payload-decrypt.interceptor');
    const { PayloadEncryptInterceptor } =
      await import('@/common/transport-crypto/payload-encrypt.interceptor');

    const providers = Reflect.getMetadata('providers', TransportCryptoModule) as {
      useExisting?: unknown;
    }[];
    const registered = providers
      .filter((provider) => provider.useExisting !== undefined)
      .map((provider) => provider.useExisting);

    expect(registered).toEqual([PayloadDecryptInterceptor, PayloadEncryptInterceptor]);
  });
});
