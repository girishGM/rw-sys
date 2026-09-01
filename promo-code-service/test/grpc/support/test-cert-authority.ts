/**
 * T-PC-031 test support. Generates an ephemeral CA + server certificate + per-identity client
 * certificates via the system `openssl` binary (present on every dev/CI machine this project
 * already assumes — same "real thing, not a mock" discipline `createAppTestConnection` applies to
 * Postgres) into a fresh temp directory per test run. Nothing here is committed material (R4 — no
 * secret in a committed file): every key is generated fresh, used only for the lifetime of one
 * `describe` block, and the temp directory is deleted in `afterAll`.
 *
 * Each client certificate's Subject Alternative Name (`DNS:<identity>`) is exactly what
 * `MtlsGuard`/`ServiceIdentityRepository` check against the `promo_code.grpc_service_identity`
 * allowlist — `issueClientCert('some-identity')` produces a certificate this project's own guard
 * will extract `'some-identity'` from.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface IssuedCertificate {
  certPath: string;
  keyPath: string;
}

function run(args: string[]): void {
  execFileSync('openssl', args, { stdio: 'pipe' });
}

export class TestCertAuthority {
  private constructor(
    readonly dir: string,
    readonly caCertPath: string,
    private readonly caKeyPath: string,
    readonly serverCertPath: string,
    readonly serverKeyPath: string,
  ) {}

  static build(): TestCertAuthority {
    const dir = mkdtempSync(join(tmpdir(), 'pc-grpc-mtls-'));
    const caKeyPath = join(dir, 'ca.key');
    const caCertPath = join(dir, 'ca.crt');
    run([
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      caKeyPath,
      '-out',
      caCertPath,
      '-days',
      '2',
      '-subj',
      '/CN=T-PC-031 Test CA',
    ]);

    const serverKeyPath = join(dir, 'server.key');
    const serverCsrPath = join(dir, 'server.csr');
    run([
      'req',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      serverKeyPath,
      '-out',
      serverCsrPath,
      '-subj',
      '/CN=localhost',
    ]);
    const serverExtPath = join(dir, 'server-ext.cnf');
    writeFileSync(serverExtPath, 'subjectAltName=DNS:localhost,IP:127.0.0.1\n');
    const serverCertPath = join(dir, 'server.crt');
    run([
      'x509',
      '-req',
      '-in',
      serverCsrPath,
      '-CA',
      caCertPath,
      '-CAkey',
      caKeyPath,
      '-CAcreateserial',
      '-out',
      serverCertPath,
      '-days',
      '2',
      '-extfile',
      serverExtPath,
    ]);

    return new TestCertAuthority(dir, caCertPath, caKeyPath, serverCertPath, serverKeyPath);
  }

  /** Issues a client certificate whose SAN is exactly `DNS:<identity>` — signed by this same CA
   * (so the TLS handshake itself always succeeds; whether `identity` is on the application-level
   * allowlist is a separate, later check `MtlsGuard` makes). */
  issueClientCert(identity: string): IssuedCertificate {
    const safe = identity.replace(/[^a-zA-Z0-9._-]/g, '_');
    const keyPath = join(this.dir, `client-${safe}.key`);
    const csrPath = join(this.dir, `client-${safe}.csr`);
    const certPath = join(this.dir, `client-${safe}.crt`);
    const extPath = join(this.dir, `client-${safe}-ext.cnf`);
    run([
      'req',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      csrPath,
      '-subj',
      `/CN=${identity}`,
    ]);
    writeFileSync(extPath, `subjectAltName=DNS:${identity}\n`);
    run([
      'x509',
      '-req',
      '-in',
      csrPath,
      '-CA',
      this.caCertPath,
      '-CAkey',
      this.caKeyPath,
      '-CAcreateserial',
      '-out',
      certPath,
      '-days',
      '2',
      '-extfile',
      extPath,
    ]);
    return { certPath, keyPath };
  }

  cleanup(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}
