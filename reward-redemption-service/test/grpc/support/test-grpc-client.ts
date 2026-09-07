/**
 * T-RR-011 test support. Builds a real `@grpc/grpc-js` client against `proto/reward_ingest.proto`
 * — loaded the same way the server itself loads it (`grpc-server.config.ts`'s
 * `resolveProtoPath()`), so a proto-shape drift between client and server expectations in this
 * test would show up as a real client-side failure, not be hidden by two independently-typed-out
 * message shapes. Also exposes `resolveFullyQualifiedMethodPath` for TC-7: proving, via real
 * `@grpc/proto-loader` package-definition introspection rather than a string literal, that this
 * server registers exactly the method path RAP's real, shipped tier-2 fallback client dials.
 *
 * No `ts-proto`/generated client stubs exist in this project
 * (`reward-ingest.grpc.types.ts`'s own header) — `grpc.loadPackageDefinition` returns a
 * dynamically-shaped object at runtime; the `LoadedRewardIngestPackage` interface below is this
 * file's own typed view of the one path this test suite actually calls
 * (`rewardrap.reward.v1.RewardIngestService`), asserted via `as unknown as X` rather than `any`
 * (this project's ESLint config treats `no-explicit-any` as an error with no task-scoped exception
 * here).
 */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { resolveProtoPath } from '@/grpc/grpc-server.config';
import type { RewardEntryProto, SubmitRewardEntryAckProto } from '@/grpc/reward-ingest.grpc.types';

export interface RewardIngestServiceTestClient extends grpc.Client {
  SubmitRewardEntry(
    request: RewardEntryProto,
    callback: (error: grpc.ServiceError | null, response?: SubmitRewardEntryAckProto) => void,
  ): grpc.ClientUnaryCall;
  SubmitRewardEntry(
    request: RewardEntryProto,
    metadata: grpc.Metadata,
    callback: (error: grpc.ServiceError | null, response?: SubmitRewardEntryAckProto) => void,
  ): grpc.ClientUnaryCall;
}

interface LoadedRewardIngestPackage {
  rewardrap: {
    reward: {
      v1: {
        RewardIngestService: new (
          address: string,
          credentials: grpc.ChannelCredentials,
          options?: object,
        ) => RewardIngestServiceTestClient;
      };
    };
  };
}

function loadPackageDefinition(): protoLoader.PackageDefinition {
  return protoLoader.loadSync(resolveProtoPath(), {});
}

export function createTestClient(
  address: string,
  credentials: grpc.ChannelCredentials,
): RewardIngestServiceTestClient {
  const loaded = grpc.loadPackageDefinition(
    loadPackageDefinition(),
  ) as unknown as LoadedRewardIngestPackage;
  return new loaded.rewardrap.reward.v1.RewardIngestService(address, credentials);
}

export function callSubmitRewardEntry(
  client: RewardIngestServiceTestClient,
  request: RewardEntryProto,
): Promise<SubmitRewardEntryAckProto> {
  return new Promise((resolve, reject) => {
    client.SubmitRewardEntry(request, (error, response) => {
      if (error) {
        reject(error);
      } else {
        resolve(response as SubmitRewardEntryAckProto);
      }
    });
  });
}

/** TC-7 — the fully-qualified gRPC method path this package definition registers, derived from
 * real `@grpc/proto-loader` introspection (`<package>.<Service>.<Method>` -> `/pkg.Service/Method`
 * wire form), never a hand-typed string literal a future proto edit could silently drift from. */
export function resolveFullyQualifiedMethodPath(): string {
  const packageDefinition = loadPackageDefinition();
  const serviceKey = 'rewardrap.reward.v1.RewardIngestService';
  const serviceDefinition = packageDefinition[serviceKey] as unknown as
    Record<string, { path: string }> | undefined;
  if (!serviceDefinition || !serviceDefinition.SubmitRewardEntry) {
    throw new Error(`${serviceKey}.SubmitRewardEntry not found in loaded proto package definition`);
  }
  return serviceDefinition.SubmitRewardEntry.path;
}
