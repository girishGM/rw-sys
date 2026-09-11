export {
  RapActivityClient,
  buildRawClient,
  validateSubmitActivityRequest,
  DEFAULT_RAP_GRPC_PORT,
  DEFAULT_RAP_GRPC_TIMEOUT_MS,
  type RapClientOptions,
  type RawActivityIngestServiceClient,
} from './client';
export {
  RapActivityRestClient,
  validateSubmitActivityRequestForRest,
  type RapActivityRestClientConfig,
} from './rest.client';
export {
  ConfigurableRapActivityClient,
  RAP_ACTIVITY_TRANSPORTS,
  type RapActivityTransport,
} from './configurable.client';
export {
  createRapClientFromEnv,
  DEFAULT_RAP_ACTIVITY_REST_BASE_URL,
  DEFAULT_RAP_ACTIVITY_REST_TIMEOUT_MS,
} from './from-env';
export {
  RapServiceRequestError,
  RapServiceUnreachableError,
  RapServiceValidationError,
  RapServiceTransportNotAvailableError,
  RapServiceUnavailableError,
} from './errors';
export { toSubmitActivityRequest, type ActivityForRap } from './mapping';
export type { SubmitActivityRequest, SubmitActivityResponse, RapActivitySubmitter } from './types';
