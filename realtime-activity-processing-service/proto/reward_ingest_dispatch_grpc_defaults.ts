/**
 * T-INT-006. RAP's own default port for the outbound gRPC dial `RewardGrpcFallbackClient` makes to
 * reward-redemption-service's (RR's) `RewardIngestService` gRPC server (`ARCHITECTURE.md` finding
 * 6(c) of `reward-service-integration-plan`: "RAP defaults `50061`, RR defaults `50081`" — a real,
 * shipped bug, not a design gap). RR is the server of record for this leg
 * (`reward-redemption-service/src/grpc/grpc-server.config.ts`'s own `DEFAULT_GRPC_PORT = 50081`) —
 * this constant only ever *tracks* RR's own default, it never defines the port independently.
 *
 * Deliberately its own file under `proto/` (alongside this leg's own `reward_ingest.proto`, the
 * wire contract both sides already share field-for-field) rather than staying inlined in
 * `src/modules/dispatch/reward-grpc-fallback.client.ts`, specifically so
 * `test/dispatch/reward-ingest-dispatch-grpc-defaults.spec.ts` can assert this value against a
 * direct read of RR's own real source file — a genuine cross-repo parity check, not a restated
 * literal on both sides (`reward-service-integration-plan/AGENT-PROTOCOL.md` §3's own "assert the
 * observable property, not the implementation string" rule: two independent `50081` literals, one
 * in each service, would both have silently "passed" every prior test suite even while disagreeing
 * with each other, exactly as `50061` vs `50081` already did undetected until this task's audit).
 *
 * If RR's own `DEFAULT_GRPC_PORT` ever changes, this constant (and the parity test asserting it)
 * must be updated to match — never the other way around; RAP is the caller, never the definer, of
 * this port.
 */
export const DEFAULT_REWARD_REDEMPTION_GRPC_PORT = 50081;
