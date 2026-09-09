/**
 * T-RR-011. Carries the `tenantId` `MtlsGuard` resolves from the caller's mTLS identity
 * (`service-identity.registry.ts`) across to `RewardIngestController` — the one piece of "auth
 * context" this transport needs that has nowhere else to live, since `RewardEntry` itself
 * deliberately has no trustworthy `tenant_id` field the wire payload can be trusted to carry
 * (`03-GRPC-CONTRACT.md` §1's own "since `RewardEntry` ... has no caller-supplied `tenant_id`
 * field whose trustworthiness would otherwise need separate verification").
 *
 * Keyed by the raw `grpc.ServerUnaryCall` object (NestJS/`@grpc/grpc-js` pass the exact same call
 * reference to every guard's `context.getArgByIndex(2)` and to a `@GrpcMethod` handler's own third
 * positional parameter for one RPC) — a `WeakMap` so an entry is never kept alive past the
 * lifetime of the call it belongs to, and two concurrent calls (even for the same identity) never
 * share or clobber each other's resolved value. Same mechanism as RAP's own
 * `resolved-identity.context.ts` (confirmed by direct read).
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
