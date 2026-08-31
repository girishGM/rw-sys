/**
 * T-121 — `POST /field-api-lookup-providers`. `super_admin` only.
 *
 * `status` *is* accepted here (unlike the context-provider DTO), because a Super Admin registering
 * a provider whose real details they have already confirmed should be able to create it `active`
 * directly. It defaults to `planned` when omitted — the safe default, since a provider nobody has
 * confirmed must make T-123 decline rather than attempt a call to an unverified endpoint.
 *
 * `authConfig` is the plaintext credential object. It is encrypted by
 * `FieldApiLookupConfigCrypto` before it is stored and is never returned by any endpoint.
 */
import {
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  FIELD_API_LOOKUP_AUTH_TYPES,
  FIELD_API_LOOKUP_HTTP_METHODS,
  FIELD_API_LOOKUP_PROVIDER_STATUSES,
  PROVIDER_CODE_MAX_LENGTH,
  PROVIDER_CODE_PATTERN,
  PROVIDER_DESCRIPTION_MAX_LENGTH,
  PROVIDER_ENDPOINT_URL_MAX_LENGTH,
  PROVIDER_NAME_MAX_LENGTH,
  PROVIDER_RESPONSE_KEY_MAX_LENGTH,
} from '../field-value-sources.constants';

export class CreateFieldApiLookupProviderDto {
  @IsString()
  @MinLength(2)
  @MaxLength(PROVIDER_CODE_MAX_LENGTH)
  @Matches(PROVIDER_CODE_PATTERN, {
    message: 'providerCode must be upper snake case, e.g. PRODUCT_CATALOG',
  })
  providerCode!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(PROVIDER_NAME_MAX_LENGTH)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(PROVIDER_DESCRIPTION_MAX_LENGTH)
  description?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(PROVIDER_ENDPOINT_URL_MAX_LENGTH)
  endpointUrl!: string;

  @IsOptional()
  @IsIn(FIELD_API_LOOKUP_HTTP_METHODS)
  httpMethod?: string;

  @IsOptional()
  @IsIn(FIELD_API_LOOKUP_AUTH_TYPES)
  authType?: string;

  /** Plaintext on the way in, ciphertext at rest, never on the way out. */
  @IsOptional()
  @IsObject()
  authConfig?: Record<string, unknown>;

  @IsString()
  @MinLength(1)
  @MaxLength(PROVIDER_RESPONSE_KEY_MAX_LENGTH)
  responseValueKey!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(PROVIDER_RESPONSE_KEY_MAX_LENGTH)
  responseLabelKey!: string;

  @IsOptional()
  @IsIn(FIELD_API_LOOKUP_PROVIDER_STATUSES)
  status?: string;
}
