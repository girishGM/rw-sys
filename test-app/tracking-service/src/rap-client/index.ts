export {
  RapActivityClient,
  buildRawClient,
  validateSubmitActivityRequest,
  DEFAULT_RAP_GRPC_PORT,
  DEFAULT_RAP_GRPC_TIMEOUT_MS,
  type RapClientOptions,
  type RawActivityIngestServiceClient,
} from './client';
export { createRapClientFromEnv } from './from-env';
export {
  RapServiceRequestError,
  RapServiceUnreachableError,
  RapServiceValidationError,
} from './errors';
export { toSubmitActivityRequest, type ActivityForRap } from './mapping';
export type { SubmitActivityRequest, SubmitActivityResponse } from './types';
