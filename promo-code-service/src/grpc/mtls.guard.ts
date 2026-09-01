/**
 * T-PC-031. mTLS + allowlist enforcement for every RPC on port `50061` (`03-GRPC-CONTRACT.md`
 * §3/implementation note 5). The TLS layer itself (`grpc.ServerCredentials.createSsl(...,
 * checkClientCertificate: true)`, wired in `grpc-server.bootstrap.ts`) already refuses any
 * connection that doesn't present a certificate signed by the configured CA — that is what makes
 * TC-5 ("no client certificate presented") a connection-level rejection the handshake itself
 * produces, before this guard, or any handler, ever runs. This guard's own job is narrower and
 * runs *after* a TLS-valid connection is established: is this specific certificate's identity on
 * this service's own allowlist (TC-6) — the same "coarse, connection-level check" split migration
 * `008`'s own header describes.
 *
 * No cookie or JWT is ever read here (TC-7, `03-GRPC-CONTRACT.md` §3's "no portal session cookie
 * or JWT is ever accepted on this port") — this guard's only inputs are the mTLS peer certificate
 * and the allowlist table; nothing in this file, or anywhere else on this transport's pipeline,
 * ever inspects gRPC metadata for a bearer token or cookie header.
 *
 * ### How the peer certificate reaches a NestJS guard
 *
 * `@grpc/grpc-js`'s public, documented API for reading the peer certificate inside a server
 * handler is `call.getAuthContext().sslPeerCertificate` (`server-interceptors.js`'s
 * `getAuthContext()` — returns `{ transportSecurityType: 'ssl', sslPeerCertificate }` for a TLS
 * connection, `{}` otherwise). NestJS's own `ExecutionContext.switchToRpc()` only exposes
 * `getData()`/`getContext()` (args index 0/1 — the request payload and call metadata), not the
 * raw call object — but every `ExecutionContext` also exposes the underlying `getArgByIndex(i)`
 * (`@nestjs/core`'s `ExecutionContextHost`), and `@nestjs/microservices`' gRPC `RpcContextCreator`
 * always invokes the handler (and therefore every guard) with `(request, metadata, call)` as its
 * three positional args (`rpc-context-creator.js`) — so `context.getArgByIndex(2)` is the raw
 * `grpc.ServerUnaryCall`, with `getAuthContext()` available on it directly. This is standard,
 * documented grpc-js/NestJS surface area, not an internal/undocumented reach-in.
 */
import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import { ServiceIdentityRepository } from './service-identity.repository';

interface PeerCertificate {
  subject?: Record<string, string>;
  subjectaltname?: string;
}

interface AuthContext {
  transportSecurityType?: string;
  sslPeerCertificate?: PeerCertificate;
}

interface GrpcCallWithAuthContext {
  getAuthContext(): AuthContext;
}

function hasAuthContext(value: unknown): value is GrpcCallWithAuthContext {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { getAuthContext?: unknown }).getAuthContext === 'function'
  );
}

/**
 * `subjectaltname` is a comma-separated string, e.g. `"DNS:reward-redemption-service, DNS:foo"`
 * — extracts every `DNS:` entry. Falls back to the certificate's `CN` (Common Name) when no SAN
 * is present at all, so a minimally-issued test/dev certificate with only a CN still has exactly
 * one identity candidate to check, rather than being treated as having none.
 */
function extractIdentityCandidates(cert: PeerCertificate): string[] {
  const candidates: string[] = [];
  if (cert.subjectaltname) {
    for (const entry of cert.subjectaltname.split(',')) {
      const trimmed = entry.trim();
      if (trimmed.startsWith('DNS:')) {
        candidates.push(trimmed.slice('DNS:'.length));
      }
    }
  }
  if (candidates.length === 0 && cert.subject?.CN) {
    candidates.push(cert.subject.CN);
  }
  return candidates;
}

function denyUnauthenticated(message: string): never {
  throw new RpcException({ code: GrpcStatus.UNAUTHENTICATED, message });
}

function denyPermission(message: string): never {
  throw new RpcException({ code: GrpcStatus.PERMISSION_DENIED, message });
}

@Injectable()
export class MtlsGuard implements CanActivate {
  constructor(private readonly serviceIdentityRepository: ServiceIdentityRepository) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const call = context.getArgByIndex(2) as unknown;
    if (!hasAuthContext(call)) {
      // Defensive only — an unreachable branch against the real grpc-js transport (TLS is
      // enforced at the handshake, before any handler runs), but a guard must never treat
      // "cannot determine the credential" as "credential is valid".
      denyUnauthenticated('No transport call context available to authenticate');
    }

    const authContext = call.getAuthContext();
    const cert = authContext.sslPeerCertificate;
    if (!cert || authContext.transportSecurityType !== 'ssl') {
      denyUnauthenticated('Client certificate required');
    }

    const candidates = extractIdentityCandidates(cert);
    if (candidates.length === 0) {
      denyPermission('Client certificate has no usable identity (SAN/CN)');
    }

    const match = await this.serviceIdentityRepository.findFirstActiveMatch(candidates);
    if (!match) {
      denyPermission('Client certificate identity is not on the allowlist');
    }

    return true;
  }
}
