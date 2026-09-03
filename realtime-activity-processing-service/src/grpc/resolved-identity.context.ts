/**
 * T-RAP-022. Carries the `tenantId` `MtlsGuard` resolves from the caller's mTLS identity
 * (`service-identity.registry.ts`) across to `ActivityIngestController` — the one piece of
 * "auth context" this transport needs that has nowhere else to live, since `SubmitActivityRequest`
 * itself deliberately has no `tenant_id` field (`activity_ingest.proto`'s own header;
 * `inbound-activity.types.ts`'s "never a field on the wire payload itself").
 *
 * Keyed by the raw `grpc.ServerUnaryCall` object (NestJS/`@grpc/grpc-js` pass the exact same call
 * reference to every guard's `context.getArgByIndex(2)` and to a `@GrpcMethod` handler's own third
 * positional parameter for one RPC — the same reach-in `mtls.guard.ts`'s own header documents,
 * `promo-code-service/src/grpc/mtls.guard.ts`'s precedent) — a `WeakMap` so an entry is never kept
 * alive past the lifetime of the call it belongs to, and two concurrent calls (even for the same
 * identity) never share or clobber each other's resolved value.
 */
import { Injectable } from '@nestjs/common';

@Injectable()
export class ResolvedIdentityContext {
  private readonly tenantIdByCall = new WeakMap<object, number>();

  set(call: object, tenantId: number): void {
    this.tenantIdByCall.set(call, tenantId);
  }

  get(call: object): number | undefined {
    return this.tenantIdByCall.get(call);
  }
}
