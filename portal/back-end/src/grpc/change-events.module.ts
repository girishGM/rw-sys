/**
 * T-047 — the module that carries `ChangeEventPublisher` alone.
 *
 * ### Why the publisher is not simply a provider of `GrpcModule`
 *
 * Its two producers are `CampaignsModule` (pause/resume) and `ApprovalsModule` (approve), and its
 * one consumer is `GrpcModule` (the `WatchCampaignConfig` stream). If the publisher lived in
 * `GrpcModule`, both producers would have to import a module that itself imports `CampaignsModule`
 * — a cycle, and a large one: the gRPC module drags in the TLS listener, the grants service and the
 * snapshot builder, none of which a campaign pause has any business knowing about.
 *
 * A module holding one stateful, dependency-free provider is the smallest thing that breaks that
 * cycle, and it makes the dependency honest in both directions: `CampaignsModule` depends on *"a
 * place to announce a governance transition"*, not on *"the gRPC server"*. If the transport is ever
 * replaced — a broker, a webhook, `@grpc/grpc-js` — this is the only import either producer keeps.
 */
import { Module } from '@nestjs/common';
import { ChangeEventPublisher } from './change-event.publisher';

@Module({
  providers: [ChangeEventPublisher],
  exports: [ChangeEventPublisher],
})
export class ChangeEventsModule {}
