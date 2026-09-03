/**
 * T-RAP-010. Pure, synchronous unit tests for `loadCampaignConfigClientOptions` — no network, no
 * DB. The real wire-level round trip against a live proto-shaped server is exercised in
 * `campaign-config-cache.e2e-spec.ts` (TC-1..3), which already stands up a mock portal for that
 * purpose — duplicating a second mock server here would just be the same coverage twice.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_PORTAL_GRPC_PORT,
  DEFAULT_PORTAL_GRPC_TIMEOUT_MS,
  loadCampaignConfigClientOptions,
} from '@/modules/campaign-cache/campaign-config.client';

const ENV_KEYS = [
  'PORTAL_GRPC_HOST',
  'PORTAL_GRPC_PORT',
  'PORTAL_GRPC_TIMEOUT_MS',
  'PORTAL_GRPC_TLS_CA_PATH',
  'PORTAL_GRPC_TLS_CERT_PATH',
  'PORTAL_GRPC_TLS_KEY_PATH',
] as const;

describe('loadCampaignConfigClientOptions', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    for (const key of ENV_KEYS) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  it('defaults host/port/timeout when nothing is configured, and no TLS material', () => {
    const options = loadCampaignConfigClientOptions();
    expect(options).toEqual({
      host: 'localhost',
      port: DEFAULT_PORTAL_GRPC_PORT,
      timeoutMs: DEFAULT_PORTAL_GRPC_TIMEOUT_MS,
    });
  });

  it('reads a custom host/port/timeout from the environment', () => {
    process.env.PORTAL_GRPC_HOST = 'portal.internal';
    process.env.PORTAL_GRPC_PORT = '60123';
    process.env.PORTAL_GRPC_TIMEOUT_MS = '9000';

    const options = loadCampaignConfigClientOptions();
    expect(options.host).toBe('portal.internal');
    expect(options.port).toBe(60123);
    expect(options.timeoutMs).toBe(9000);
  });

  it('rejects a non-numeric PORTAL_GRPC_PORT', () => {
    process.env.PORTAL_GRPC_PORT = 'not-a-port';
    expect(() => loadCampaignConfigClientOptions()).toThrow(/PORTAL_GRPC_PORT/);
  });

  it('rejects a zero/negative PORTAL_GRPC_TIMEOUT_MS', () => {
    process.env.PORTAL_GRPC_TIMEOUT_MS = '0';
    expect(() => loadCampaignConfigClientOptions()).toThrow(/PORTAL_GRPC_TIMEOUT_MS/);
  });

  describe('TLS material', () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'rap-grpc-client-tls-'));
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('rejects a partial TLS configuration (only some of the three paths set)', () => {
      const caPath = join(dir, 'ca.pem');
      writeFileSync(caPath, 'fake-ca');
      process.env.PORTAL_GRPC_TLS_CA_PATH = caPath;
      // cert/key paths deliberately left unset.

      expect(() => loadCampaignConfigClientOptions()).toThrow(
        /must all be set together, or none of them/,
      );
    });

    it('loads all three certs when fully configured', () => {
      const caPath = join(dir, 'ca.pem');
      const certPath = join(dir, 'cert.pem');
      const keyPath = join(dir, 'key.pem');
      writeFileSync(caPath, 'fake-ca');
      writeFileSync(certPath, 'fake-cert');
      writeFileSync(keyPath, 'fake-key');
      process.env.PORTAL_GRPC_TLS_CA_PATH = caPath;
      process.env.PORTAL_GRPC_TLS_CERT_PATH = certPath;
      process.env.PORTAL_GRPC_TLS_KEY_PATH = keyPath;

      const options = loadCampaignConfigClientOptions();
      expect(options.tls?.rootCerts.toString()).toBe('fake-ca');
      expect(options.tls?.clientCert.toString()).toBe('fake-cert');
      expect(options.tls?.clientKey.toString()).toBe('fake-key');
    });
  });
});
