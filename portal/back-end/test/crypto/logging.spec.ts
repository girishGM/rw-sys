/**
 * T-016 TC-22 — nothing sensitive reaches a log line, during *any* of the operations above.
 *
 * This is the test that catches the failure 07-DATA-PROTECTION.md §1 exists to prevent: "a
 * field that is carefully encrypted in the database and then written in cleartext to a log
 * file". Encryption that logs its own input has bought nothing.
 *
 * Three things must never appear (Implementation notes §8 — "Never log plaintext, key
 * material, or a full ciphertext. Log `kid` only."):
 *
 *  1. **plaintext** — the obvious one.
 *  2. **key material** — including the base64/hex forms an operator would paste into an env
 *     var, and including partial prefixes, because a logged prefix narrows a brute force.
 *  3. **a full ciphertext** — not because it is readable, but because a log aggregator is a
 *     second, unaudited copy of the encrypted database, and because the AAD-swap protection
 *     assumes an attacker cannot collect ciphertexts at will.
 *
 * Every Nest `Logger` call in the crypto core is routed through `Logger.overrideLogger` here,
 * so this covers the real logging path rather than a stub of it. Thrown error *messages* are
 * checked too: T-014's error normaliser writes them to the log, so an error message carrying
 * plaintext leaks exactly as loudly as a log call would.
 */
import { Logger, type LoggerService } from '@nestjs/common';
import {
  BlindIndexService,
  FieldCryptoService,
  KeyRegistryService,
  RotateKeysCommand,
  type RotationTarget,
} from '@/common/crypto';
import { FakeDb, type FakeRow } from './support/fake-db';
import {
  FIELD_ENV,
  FIELD_ENV_V2,
  FIELD_KID,
  FIELD_KID_V2,
  blindKeyRow,
  fieldKeyRow,
  keyMaterial,
  resolvers,
  testEnv,
} from './support/keys';

const TABLE = 'reward_portal.portal_users';
const TARGET: RotationTarget = { table: TABLE, pkColumn: 'id', columns: ['email_enc'] };

/** A distinctive plaintext: if any fragment of this shows up anywhere, it came from us. */
const PLAINTEXT = 'canary-plaintext-9f2a@example.invalid';

/** The base64 key material behind the field key, as an operator would have written it. */
const FIELD_KEY_B64 = keyMaterial(0x11);
const FIELD_KEY_HEX = Buffer.from(FIELD_KEY_B64, 'base64').toString('hex');

/** Collects everything written through Nest's logger. */
class CapturingLogger implements LoggerService {
  readonly lines: string[] = [];

  private record(message: unknown, ...rest: unknown[]): void {
    this.lines.push([message, ...rest].map((part) => safeStringify(part)).join(' '));
  }

  log(message: unknown, ...rest: unknown[]): void {
    this.record(message, ...rest);
  }
  error(message: unknown, ...rest: unknown[]): void {
    this.record(message, ...rest);
  }
  warn(message: unknown, ...rest: unknown[]): void {
    this.record(message, ...rest);
  }
  debug(message: unknown, ...rest: unknown[]): void {
    this.record(message, ...rest);
  }
  verbose(message: unknown, ...rest: unknown[]): void {
    this.record(message, ...rest);
  }
}

function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack ?? ''}`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

let logger: CapturingLogger;

beforeEach(() => {
  logger = new CapturingLogger();
  Logger.overrideLogger(logger);
});

afterAll(() => {
  Logger.overrideLogger(false);
});

/**
 * The whole exercise: load a registry, encrypt, decrypt, fail to decrypt several ways,
 * blind-index, rotate, retire. Returns every log line plus every error message raised.
 */
async function runEverything(): Promise<{ lines: string[]; ciphertexts: string[] }> {
  const errors: string[] = [];
  const ciphertexts: string[] = [];

  const capture = async (fn: () => unknown | Promise<unknown>): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      errors.push(safeStringify(err));
    }
  };

  const db = new FakeDb();
  db.keyRows = [
    fieldKeyRow(),
    fieldKeyRow({ kid: FIELD_KID_V2, key_ref: `env:${FIELD_ENV_V2}`, status: 'rotating' }),
    blindKeyRow(),
  ];
  const registry = new KeyRegistryService(db.asSequelize(), resolvers(testEnv()));
  await registry.load();

  const fieldCrypto = new FieldCryptoService(registry);
  const blindIndex = new BlindIndexService(registry);
  const command = new RotateKeysCommand(db.asSequelize(), registry, fieldCrypto, blindIndex);

  const aad = FieldCryptoService.aadFor(TABLE, 1);
  const ciphertext = fieldCrypto.encrypt(PLAINTEXT, { aad });
  ciphertexts.push(ciphertext);

  fieldCrypto.decrypt(ciphertext, { aad });
  blindIndex.compute(PLAINTEXT, 'email');

  // Every failure path, since error messages are logged.
  await capture(() =>
    fieldCrypto.decrypt(ciphertext, { aad: FieldCryptoService.aadFor(TABLE, 2) }),
  );
  await capture(() => fieldCrypto.decrypt('garbage', { aad }));
  await capture(() => fieldCrypto.decrypt(`${ciphertext}x`, { aad }));
  await capture(() => fieldCrypto.encrypt(PLAINTEXT, { aad: '' }));
  await capture(() => registry.getKeyForDecryption('never_existed'));

  // A boot failure carrying a real key in the wrong column, and a wrong-length key.
  await capture(async () => {
    const bad = new KeyRegistryService(db.asSequelize(), resolvers(testEnv()));
    db.keyRows = [fieldKeyRow({ key_ref: `env:${FIELD_KEY_B64}` })];
    await bad.load();
  });
  await capture(async () => {
    const bad = new KeyRegistryService(
      db.asSequelize(),
      resolvers(testEnv({ [FIELD_ENV]: keyMaterial(0x11, 16) })),
    );
    db.keyRows = [fieldKeyRow()];
    await bad.load();
  });

  // Rotation, including a row that cannot be decrypted.
  db.keyRows = [
    fieldKeyRow(),
    fieldKeyRow({ kid: FIELD_KID_V2, key_ref: `env:${FIELD_ENV_V2}`, status: 'rotating' }),
    blindKeyRow(),
  ];
  await registry.load();

  const rows: FakeRow[] = [1, 2, 3].map((id) => {
    const value = fieldCrypto.encrypt(`${PLAINTEXT}.${id}`, {
      aad: FieldCryptoService.aadFor(TABLE, id),
    });
    ciphertexts.push(value);
    return { id, email_enc: value };
  });
  db.setTable(TABLE, rows);

  await command.activateKey(FIELD_KID_V2);
  await command.rotate(TARGET);
  for (const row of db.getTable(TABLE)) ciphertexts.push(row.email_enc as string);
  await capture(() => command.retireKey(FIELD_KID, [TARGET]));
  await command.retireKey(FIELD_KID);
  await capture(() => command.activateKey(FIELD_KID));

  return { lines: [...logger.lines, ...errors], ciphertexts };
}

describe('TC-22 — logging leaks nothing', () => {
  let lines: string[];
  let output: string;
  let ciphertexts: string[];

  beforeAll(async () => {
    logger = new CapturingLogger();
    Logger.overrideLogger(logger);
    const result = await runEverything();
    lines = result.lines;
    ciphertexts = result.ciphertexts;
    output = lines.join('\n');
  });

  it('actually produced log output — otherwise this suite proves nothing', () => {
    expect(lines.length).toBeGreaterThan(5);
    expect(output).toContain('Key registry loaded');
  });

  it('never logs plaintext', () => {
    expect(output).not.toContain(PLAINTEXT);
    expect(output).not.toContain('canary-plaintext');
    expect(output).not.toContain('example.invalid');
  });

  it('never logs key material, in any encoding, not even a prefix', () => {
    expect(output).not.toContain(FIELD_KEY_B64);
    expect(output).not.toContain(FIELD_KEY_HEX);
    // A logged prefix narrows a brute force, so partial disclosure is checked too.
    expect(output).not.toContain(FIELD_KEY_B64.slice(0, 16));
    expect(output).not.toContain(FIELD_KEY_HEX.slice(0, 16));
    for (const value of [keyMaterial(0x22), keyMaterial(0x33)]) {
      expect(output).not.toContain(value);
      expect(output).not.toContain(value.slice(0, 16));
    }
  });

  it('never logs a full ciphertext', () => {
    expect(ciphertexts.length).toBeGreaterThan(3);
    for (const ciphertext of ciphertexts) {
      expect(output).not.toContain(ciphertext);
      // Nor the body alone, which is the part worth exfiltrating.
      const body = ciphertext.split('.')[4];
      expect(body.length).toBeGreaterThan(0);
      expect(output).not.toContain(body);
    }
  });

  it('never logs a blind index — it is a stable pseudonym for a real person', () => {
    // Two rows sharing a logged index would be provably the same person, and the index is
    // stable across restarts, so a log aggregator becomes a correlation database. Matched by
    // shape (64 hex chars) rather than by value, so it also catches an index for a plaintext
    // this test never chose.
    expect(output).not.toMatch(/\b[0-9a-f]{64}\b/);
  });

  it('does log the kid — the one identifier that is safe and is needed to operate', () => {
    expect(output).toContain(FIELD_KID);
    expect(output).toContain(FIELD_KID_V2);
    expect(output).toMatch(/Key '.*' is now the active 'field' key\./);
    expect(output).toMatch(/retired/);
  });

  it('logs key metadata only — purpose and status, never the key_ref', () => {
    expect(output).toContain('field/active');
    // The registry-loaded line enumerates every key; it must not enumerate where they live.
    // (`decodeKeyMaterial` does name an env var in its *error* messages, deliberately, so an
    // operator can find the broken variable — that is a name, never a value, and none of the
    // failure paths exercised here reach it.)
    expect(output).not.toContain(`env:${FIELD_ENV}`);
    expect(output).not.toContain(`env:${FIELD_ENV_V2}`);
  });
});
