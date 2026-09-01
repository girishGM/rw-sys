/**
 * T-PC-031 test support. Builds a real `@grpc/grpc-js` client against `promo_code.v1.proto` —
 * loaded the same way the server itself loads it (`grpc-server.config.ts`'s `resolveProtoPath()`),
 * so a proto-shape drift between client and server expectations in this test would show up as a
 * real client-side failure, not be hidden by two independently-typed-out message shapes.
 *
 * No `ts-proto`/generated client stubs exist in this project (`promo-code.grpc.types.ts`'s own
 * header) — `grpc.loadPackageDefinition` returns a dynamically-shaped object at runtime; the
 * `LoadedPromoCodePackage` interface below is this file's own typed view of the one path this
 * test suite actually calls (`promocode.v1.PromoCodeService`), asserted via `as unknown as X`
 * rather than `any` (this project's ESLint config, `.eslintrc.js`, treats `no-explicit-any` as an
 * error with no task-scoped exception here).
 */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { resolveProtoPath } from '@/grpc/grpc-server.config';
import type {
  GenerateCodeRequestProto,
  GenerateCodeResponseProto,
  ListActivePromoCodeConfigsRequestProto,
  PromoCodeConfigListProto,
} from '@/grpc/promo-code.grpc.types';

export interface PromoCodeServiceTestClient extends grpc.Client {
  GenerateCode(
    request: GenerateCodeRequestProto,
    callback: (error: grpc.ServiceError | null, response?: GenerateCodeResponseProto) => void,
  ): grpc.ClientUnaryCall;
  GenerateCode(
    request: GenerateCodeRequestProto,
    metadata: grpc.Metadata,
    callback: (error: grpc.ServiceError | null, response?: GenerateCodeResponseProto) => void,
  ): grpc.ClientUnaryCall;
  ListActivePromoCodeConfigs(
    request: ListActivePromoCodeConfigsRequestProto,
    callback: (error: grpc.ServiceError | null, response?: PromoCodeConfigListProto) => void,
  ): grpc.ClientUnaryCall;
}

interface LoadedPromoCodePackage {
  promocode: {
    v1: {
      PromoCodeService: new (
        address: string,
        credentials: grpc.ChannelCredentials,
        options?: object,
      ) => PromoCodeServiceTestClient;
    };
  };
}

export function createTestClient(
  address: string,
  credentials: grpc.ChannelCredentials,
): PromoCodeServiceTestClient {
  const packageDefinition = protoLoader.loadSync(resolveProtoPath(), {});
  const loaded = grpc.loadPackageDefinition(packageDefinition) as unknown as LoadedPromoCodePackage;
  return new loaded.promocode.v1.PromoCodeService(address, credentials);
}

export function callGenerateCode(
  client: PromoCodeServiceTestClient,
  request: GenerateCodeRequestProto,
): Promise<GenerateCodeResponseProto> {
  return new Promise((resolve, reject) => {
    client.GenerateCode(request, (error, response) => {
      if (error) {
        reject(error);
      } else {
        resolve(response as GenerateCodeResponseProto);
      }
    });
  });
}

export function callListActivePromoCodeConfigs(
  client: PromoCodeServiceTestClient,
  request: ListActivePromoCodeConfigsRequestProto,
): Promise<PromoCodeConfigListProto> {
  return new Promise((resolve, reject) => {
    client.ListActivePromoCodeConfigs(request, (error, response) => {
      if (error) {
        reject(error);
      } else {
        resolve(response as PromoCodeConfigListProto);
      }
    });
  });
}
