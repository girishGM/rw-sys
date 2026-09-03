/**
 * T-RAP-022. Builds the `@nestjs/microservices` `MicroserviceOptions` for the mTLS
 * `ActivityIngestService` gRPC transport (`03-GRPC-CONTRACT.md` §1) from `grpc-server.config.ts`'s
 * validated env/cert material. Kept as a plain function, not a Nest provider — nothing here needs
 * dependency injection, and both `grpc-server.main.ts` (this task's own standalone composition
 * root) and any future hybrid-app wiring in `src/main.ts` (out of this task's file scope, owned by
 * `agent-rap-foundation`) can call it identically.
 *
 * `Transport.GRPC` + `@grpc/proto-loader`, not a hand-rolled `grpc.Server` — same tech-stack choice
 * `ARCHITECTURE.md` §4 makes for this whole service, and the same divergence-from-the-portal's-own-
 * hand-rolled-`node:http2`-server precedent `promo-code-service`'s own `grpc-server.bootstrap.ts`
 * already documents for the identical reason (a brand-new, framework-native NestJS service has no
 * need for the portal's own Express-specific workaround).
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
    // certificate signed by `rootCerts` before the handshake completes at all (TC-3: no cert
    // presented is rejected at the connection level, never reaching a handler or `MtlsGuard`).
    // Certificates signed by `rootCerts` but not on this service's own allowlist still pass this
    // handshake — `MtlsGuard` is what rejects those, one layer up.
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
