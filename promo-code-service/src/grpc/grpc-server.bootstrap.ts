/**
 * T-PC-031. Builds the `@nestjs/microservices` `MicroserviceOptions` for the mTLS gRPC transport
 * (`03-GRPC-CONTRACT.md` §3) from `grpc-server.config.ts`'s validated env/cert material. Kept as
 * a plain function, not a Nest provider — nothing here needs dependency injection, and both
 * `grpc-server.main.ts` (this task's own standalone composition root, see that file's header for
 * why) and any future hybrid-app wiring in `src/main.ts` (out of this task's file scope, owned by
 * `agent-promo-foundation` — see this task's completion report) can call it identically.
 *
 * `Transport.GRPC` + `@grpc/proto-loader`, not a hand-rolled `grpc.Server` — the confirmed,
 * deliberate divergence from the portal's own T-047 (implementation note 3,
 * `ARCHITECTURE.md` §4).
 */
import { Transport } from '@nestjs/microservices';
import type { GrpcOptions } from '@nestjs/microservices';
import { ServerCredentials } from '@grpc/grpc-js';
import {
  GRPC_PACKAGE_NAME,
  loadGrpcServerConfig,
  type GrpcServerConfig,
} from './grpc-server.config';

/**
 * `null` when `GRPC_SERVER_ENABLED=false` (the Rollback lever, `grpc-server.config.ts`'s own
 * header) — callers must treat `null` as "do not start this transport", not retry or fall back to
 * an insecure default.
 */
export function buildGrpcMicroserviceOptions(): GrpcOptions | null {
  const config: GrpcServerConfig | null = loadGrpcServerConfig();
  if (config === null) {
    return null;
  }

  const credentials = ServerCredentials.createSsl(
    config.rootCerts,
    [{ private_key: config.serverKey, cert_chain: config.serverCert }],
    // `checkClientCertificate: true` — Node's TLS layer requires and verifies a client
    // certificate signed by `rootCerts` before the handshake completes at all (TC-5: no cert
    // presented is rejected at the connection level, never reaching a handler or this
    // service's own `MtlsGuard`). Certificates signed by `rootCerts` but not on this service's
    // own allowlist table still pass this handshake — `MtlsGuard` is what rejects those
    // (TC-6), one layer up.
    true,
  );

  return {
    transport: Transport.GRPC,
    options: {
      package: GRPC_PACKAGE_NAME,
      protoPath: config.protoPath,
      url: `0.0.0.0:${config.port}`,
      credentials,
    },
  };
}
