/**
 * T-RAP-022 test support. Builds a real `@grpc/grpc-js` client against `proto/activity_ingest.proto`
 * — loaded the same way the server itself loads it (`grpc-server.config.ts`'s `resolveProtoPath()`),
 * so a proto-shape drift between client and server expectations in this test would show up as a
 * real client-side failure, not be hidden by two independently-typed-out message shapes.
 *
 * No `ts-proto`/generated client stubs exist in this project (`activity-ingest.grpc.types.ts`'s own
 * header) — `grpc.loadPackageDefinition` returns a dynamically-shaped object at runtime; the
 * `LoadedActivityIngestPackage` interface below is this file's own typed view of the one path this
 * test suite actually calls (`rewardrap.ingest.v1.ActivityIngestService`), asserted via
 * `as unknown as X` rather than `any` (this project's ESLint config treats `no-explicit-any` as an
 * error with no task-scoped exception here).
 */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { resolveProtoPath } from '@/grpc/grpc-server.config';
import type {
  SubmitActivityRequestProto,
  SubmitActivityResponseProto,
} from '@/grpc/activity-ingest.grpc.types';

export interface ActivityIngestServiceTestClient extends grpc.Client {
  SubmitActivity(
    request: SubmitActivityRequestProto,
    callback: (error: grpc.ServiceError | null, response?: SubmitActivityResponseProto) => void,
  ): grpc.ClientUnaryCall;
  SubmitActivity(
    request: SubmitActivityRequestProto,
    metadata: grpc.Metadata,
    callback: (error: grpc.ServiceError | null, response?: SubmitActivityResponseProto) => void,
  ): grpc.ClientUnaryCall;
}

interface LoadedActivityIngestPackage {
  rewardrap: {
    ingest: {
      v1: {
        ActivityIngestService: new (
          address: string,
          credentials: grpc.ChannelCredentials,
          options?: object,
        ) => ActivityIngestServiceTestClient;
      };
    };
  };
}

export function createTestClient(
  address: string,
  credentials: grpc.ChannelCredentials,
): ActivityIngestServiceTestClient {
  const packageDefinition = protoLoader.loadSync(resolveProtoPath(), {});
  const loaded = grpc.loadPackageDefinition(
    packageDefinition,
  ) as unknown as LoadedActivityIngestPackage;
  return new loaded.rewardrap.ingest.v1.ActivityIngestService(address, credentials);
}

export function callSubmitActivity(
  client: ActivityIngestServiceTestClient,
  request: SubmitActivityRequestProto,
): Promise<SubmitActivityResponseProto> {
  return new Promise((resolve, reject) => {
    client.SubmitActivity(request, (error, response) => {
      if (error) {
        reject(error);
      } else {
        resolve(response as SubmitActivityResponseProto);
      }
    });
  });
}
