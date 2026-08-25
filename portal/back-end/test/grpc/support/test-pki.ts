/**
 * T-047 e2e support — a throwaway certificate authority, so the mTLS tests exercise **real** mutual
 * TLS rather than a mock of it.
 *
 * TC-9 (*"no client certificate → connection rejected"*), TC-10 (*"cert not in the allowlist →
 * rejected"*) and TC-38/TC-41 are claims about a TLS handshake. A stubbed `getPeerCertificate()`
 * would prove that the *guard* works while proving nothing about whether the listener actually asks
 * for a certificate — which is the half that, if wrong, silently opens the port to anyone.
 *
 * Generated with `openssl` into a per-run temporary directory and deleted afterwards, so no key
 * material is ever written into the repository (R4). Node has no X.509 *issuing* API — only key
 * generation — so `openssl` is the tool; if it is unavailable the suite **fails loudly** rather
 * than skipping, because a skipped mTLS test reads exactly like a passing one in a report.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface Identity {
  readonly certPath: string;
  readonly keyPath: string;
  readonly cert: Buffer;
  readonly key: Buffer;
}

export interface TestPki {
  readonly dir: string;
  readonly caPath: string;
  readonly ca: Buffer;
  /** The listener's own certificate (`CN=localhost`, SAN `DNS:localhost, IP:127.0.0.1`). */
  readonly server: Identity;
  /** A client certificate with the given SAN, signed by this CA. */
  client(sanDns: string): Identity;
  /** A client certificate signed by a **different** CA — the TC-10 "not trusted" case. */
  foreignClient(sanDns: string): Identity;
  destroy(): void;
}

function openssl(args: readonly string[], cwd: string): void {
  try {
    execFileSync('openssl', [...args], { cwd, stdio: 'pipe' });
  } catch (error) {
    throw new Error(
      `openssl failed (${args.join(' ')}). The T-047 mTLS suite needs it to issue test ` +
        `certificates; it is not optional, because a skipped mutual-TLS test looks exactly like a ` +
        `passing one. Cause: ${(error as Error).message}`,
    );
  }
}

/** A self-signed CA plus a server certificate, in a fresh temporary directory. */
export function createTestPki(): TestPki {
  const dir = mkdtempSync(join(tmpdir(), 't047-pki-'));

  const makeCa = (prefix: string, commonName: string): void => {
    openssl(
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        `${prefix}.key`,
        '-out',
        `${prefix}.crt`,
        '-days',
        '2',
        '-subj',
        `/CN=${commonName}`,
      ],
      dir,
    );
  };

  makeCa('ca', 'T047 Test CA');
  makeCa('otherca', 'T047 Untrusted CA');

  const issue = (name: string, commonName: string, san: string, ca: string): Identity => {
    writeFileSync(
      join(dir, `${name}.ext`),
      `subjectAltName=${san}\nextendedKeyUsage=serverAuth,clientAuth\n`,
    );
    openssl(
      [
        'req',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        `${name}.key`,
        '-out',
        `${name}.csr`,
        '-subj',
        `/CN=${commonName}`,
      ],
      dir,
    );
    openssl(
      [
        'x509',
        '-req',
        '-in',
        `${name}.csr`,
        '-CA',
        `${ca}.crt`,
        '-CAkey',
        `${ca}.key`,
        '-CAcreateserial',
        '-out',
        `${name}.crt`,
        '-days',
        '2',
        '-extfile',
        `${name}.ext`,
      ],
      dir,
    );
    return {
      certPath: join(dir, `${name}.crt`),
      keyPath: join(dir, `${name}.key`),
      cert: readFileSync(join(dir, `${name}.crt`)),
      key: readFileSync(join(dir, `${name}.key`)),
    };
  };

  const server = issue('server', 'localhost', 'DNS:localhost,IP:127.0.0.1', 'ca');
  let counter = 0;

  return {
    dir,
    caPath: join(dir, 'ca.crt'),
    ca: readFileSync(join(dir, 'ca.crt')),
    server,
    client: (sanDns) => issue(`client${(counter += 1)}`, sanDns, `DNS:${sanDns}`, 'ca'),
    foreignClient: (sanDns) =>
      issue(`foreign${(counter += 1)}`, sanDns, `DNS:${sanDns}`, 'otherca'),
    destroy: () => rmSync(dir, { recursive: true, force: true }),
  };
}
