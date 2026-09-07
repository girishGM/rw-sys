/**
 * T-RR-042 — R8 `customerId` decrypt-to-use lifetime audit (`AGENT-PROTOCOL.md` R8,
 * `reward-redemption-service-plan/tasks/T-RR-042-security-review.md` implementation note 2).
 *
 * Two complementary checks, static and functional:
 *
 * 1. **Static call-site inventory (TC-2/TC-3).** Every place `EncryptionService.decrypt(` is ever
 *    called in `src/` is enumerated here by content search, not trusted from a design doc's own
 *    prose — this is the "trace every place `customerId` (decrypted form) is produced" instruction
 *    read literally. Each call site found is asserted to assign its result to a local `const`
 *    (never a class field/property assignment, which is what "confined to the single function
 *    scope that needs it" means in code terms), and this test's own count assertion means a new,
 *    unaudited decrypt call site added by a future task fails this suite until it's reviewed here
 *    too — the same "would this test still fail if the property were violated" bar
 *    `AGENT-PROTOCOL.md` §3 sets, applied to a security invariant rather than a business rule.
 * 2. **Functional redaction proof (TC-2/TC-3 continued).** `LogRedactorService`/`StructuredLogger`
 *    (T-RR-040's own module) are exercised directly with a real decrypted `customerId` value,
 *    proving the redaction each of those three call sites' surrounding code relies on actually
 *    holds — an independent re-check of T-RR-040's own redaction tests, per this task's own
 *    instruction not to rely on T-RR-040's own suite alone.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { EncryptionService } from '@/modules/encryption/encryption.service';
import { LogRedactorService } from '@/observability/log-redactor.service';
import { StructuredLogger } from '@/observability/structured-logger.service';

const SRC_ROOT = path.join(__dirname, '..', '..', 'src');

function listFilesRecursive(dir: string, extension: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFilesRecursive(full, extension));
    } else if (entry.isFile() && entry.name.endsWith(extension)) {
      out.push(full);
    }
  }
  return out;
}

/** Every real (non-spec) `.decrypt(` call site under `src/`, with the line it appears on. */
function findDecryptCallSites(): Array<{ file: string; line: string }> {
  const files = listFilesRecursive(SRC_ROOT, '.ts').filter((f) => !f.endsWith('.spec.ts'));
  const sites: Array<{ file: string; line: string }> = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const line of source.split('\n')) {
      if (
        line.includes('.decrypt(') &&
        !line.trim().startsWith('*') &&
        !line.trim().startsWith('//')
      ) {
        sites.push({ file: path.relative(SRC_ROOT, file), line: line.trim() });
      }
    }
  }
  return sites;
}

describe('T-RR-042 TC-2/TC-3 — R8 customerId decrypt-to-use lifetime audit', () => {
  const sites = findDecryptCallSites();

  it('sanity: at least one real .decrypt( call site exists (the audit is not vacuously passing)', () => {
    expect(sites.length).toBeGreaterThan(0);
  });

  it('every known .decrypt( call site is exactly the reviewed set this audit signs off on — a new, un-reviewed call site fails here until it is added to this list', () => {
    const reviewed = [
      'modules/connectors/promo-code-service.connector.ts',
      'modules/dispatch/reward-tracking-dispatch-retry.worker.ts',
      'modules/dispatch/outbox-publisher.service.ts',
    ].sort();
    const found = Array.from(new Set(sites.map((s) => s.file))).sort();
    expect(found).toEqual(reviewed);
  });

  it('every .decrypt( call site assigns straight to a local `const`, never to `this.<field>` (a class property would outlive the call, R8)', () => {
    for (const site of sites) {
      // e.g. `const decryptedCustomerId = this.encryption.decrypt(...)` or
      // `const customerId = this.encryption.decrypt(...)` — never `this.something =
      // ...decrypt(...)`.
      expect(site.line).toMatch(/^const\s+\w+\s*=.*\.decrypt\(/);
      expect(site.line).not.toMatch(/^this\.\w+\s*=/);
    }
  });

  it('no .decrypt( call site assigns into an array/object literal field that could be persisted or cached wholesale (only a bare local variable)', () => {
    for (const site of sites) {
      expect(site.line).not.toMatch(/:\s*this\.encryption\.decrypt\(/);
    }
  });

  it('no log statement anywhere in src/ (excluding specs) contains a decrypted-customerId-shaped variable name as a logged value — customerIdHash/customerIdEncrypted/customerIdType are fine, bare customerId/decryptedCustomerId are not', () => {
    const files = listFilesRecursive(SRC_ROOT, '.ts').filter((f) => !f.endsWith('.spec.ts'));
    const offenders: string[] = [];
    const loggerCallStart = /\.(log|warn|error|debug|verbose)\(/;
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const lines = source.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        if (!loggerCallStart.test(lines[i])) continue;
        // Look at this line plus a small following window (multi-line logger calls/template
        // literals are this codebase's own convention, per outbox-publisher.service.ts).
        const windowText = lines.slice(i, i + 6).join('\n');
        // Match `customerId`/`decryptedCustomerId` as a whole identifier, explicitly excluding
        // the safe derived names that legitimately do appear in logs.
        const bareCustomerId = /\b(decrypted)?[cC]ustomerId\b(?!Hash|Encrypted|Type)/;
        if (bareCustomerId.test(windowText)) {
          offenders.push(`${path.relative(SRC_ROOT, file)}:${i + 1}: ${lines[i].trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('T-RR-042 — functional redaction re-check (independent of T-RR-040 own suite)', () => {
  const AES_KEY = Buffer.alloc(32, 3).toString('base64');
  const HMAC_KEY = Buffer.alloc(32, 5).toString('base64');
  const encryption = new EncryptionService({
    aesKey: Buffer.from(AES_KEY, 'base64'),
    hmacKey: Buffer.from(HMAC_KEY, 'base64'),
  });
  const PLAINTEXT_CUSTOMER_ID = 'MSISDN-T-RR-042-AUDIT-CUSTOMER';

  it('LogRedactorService.redactFields replaces a raw customerId value with its HMAC hash, never leaving the plaintext in the redacted output', () => {
    const redactor = new LogRedactorService(encryption);
    const hash = encryption.hash(PLAINTEXT_CUSTOMER_ID);
    const redacted = redactor.redactFields({ customerId: PLAINTEXT_CUSTOMER_ID, other: 'value' });
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain(PLAINTEXT_CUSTOMER_ID);
    expect(serialized).toContain(hash);
  });

  it('StructuredLogger never emits a plaintext customerId even when a caller mistakenly hands it one directly (own belt-and-suspenders defense)', () => {
    const redactor = new LogRedactorService(encryption);
    const logger = new StructuredLogger('T-RR-042-audit', redactor);
    const writes: string[] = [];
    const logSpy = jest.spyOn(console, 'log').mockImplementation((line: string) => {
      writes.push(line);
    });
    try {
      logger.log('audit test log line', {
        correlationId: 'corr-1',
        tenantId: 1,
        campaignCode: 'CAMP-X',
        rewardEntryId: 'entry-1',
        customerId: PLAINTEXT_CUSTOMER_ID,
      });
    } finally {
      logSpy.mockRestore();
    }
    const emitted = writes.join('\n');
    expect(emitted).not.toContain(PLAINTEXT_CUSTOMER_ID);
    expect(emitted).toContain(encryption.hash(PLAINTEXT_CUSTOMER_ID));
  });
});
