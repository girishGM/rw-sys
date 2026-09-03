/**
 * T-RAP-022. mTLS + allowlist enforcement for every RPC on `ActivityIngestService`
 * (`03-GRPC-CONTRACT.md` §1, TC-3/implementation note 3). Same structure as
 * `promo-code-service/src/grpc/mtls.guard.ts` (T-PC-031, this repo's own precedent for this
 * mechanism) — the TLS layer itself (`grpc.ServerCredentials.createSsl(..., checkClientCertificate:
 * true)`, wired in `grpc-server.bootstrap.ts`) already refuses any connection that doesn't present
 * a certificate signed by the configured CA, before this guard, or any handler, ever runs. This
 * guard's own job is narrower and runs *after* a TLS-valid connection is established: is this
 * specific certificate's identity on this service's own allowlist, and if so, which `tenantId`
 * does it resolve to (`service-identity.registry.ts`'s own header — this service's allowlist is
 * `identity -> tenantId`, not just `identity -> allowed/denied`, since `SubmitActivityRequest` has
 * no `tenant_id` field of its own).
 *
 * No cookie or JWT is ever read here — this guard's only inputs are the mTLS peer certificate and
 * the allowlist; nothing on this transport's pipeline ever inspects gRPC metadata for a bearer
 * token or cookie header.
 *
 * ### How the peer certificate reaches a NestJS guard
 *
 * `@grpc/grpc-js`'s public, documented API for reading the peer certificate inside a server
 * handler is `call.getAuthContext().sslPeerCertificate` — NestJS's own `ExecutionContext` exposes
 * the underlying `getArgByIndex(i)`, and `@nestjs/microservices`' gRPC `RpcContextCreator` always
 * invokes the handler (and therefore every guard) with `(request, metadata, call)` as its three
 * positional args, so `context.getArgByIndex(2)` is the raw `grpc.ServerUnaryCall`. Standard,
 * documented grpc-js/NestJS surface area — same reach-in `promo-code-service`'s own `mtls.guard.ts`
 * already documents and this repo already ships.
 */
import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import { ServiceIdentityRegistry } from './service-identity.registry';
import { ResolvedIdentityContext } from './resolved-identity.context';

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
 * `subjectaltname` is a comma-separated string, e.g. `"DNS:some-service, DNS:foo"` — extracts
 * every `DNS:` entry. Falls back to the certificate's `CN` (Common Name) when no SAN is present at
 * all, so a minimally-issued test/dev certificate with only a CN still has exactly one identity
 * candidate to check, rather than being treated as having none.
 */
function extractIdentityCandidates(cert: PeerCertificate): string[] {
  const candidates: string[] = [];
  if (cert.subjectaltname) {
    for (const rawEntry of cert.subjectaltname.split(',')) {
      const trimmed = rawEntry.trim();
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
  constructor(
    private readonly serviceIdentityRegistry: ServiceIdentityRegistry,
    private readonly identityContext: ResolvedIdentityContext,
  ) {}

  canActivate(context: ExecutionContext): boolean {
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

    const tenantId = this.serviceIdentityRegistry.resolveTenantId(candidates);
    if (tenantId === undefined) {
      denyPermission('Client certificate identity is not on the allowlist');
    }

    this.identityContext.set(call as object, tenantId);
    return true;
  }
}
