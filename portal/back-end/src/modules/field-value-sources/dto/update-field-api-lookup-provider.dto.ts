/**
 * T-121 — `PATCH /field-api-lookup-providers/:id`. `providerCode` is immutable once created and is
 * never accepted here — T-122 stores it as the value-source reference on a rule field, so renaming
 * one would silently orphan every field pointing at it.
 *
 * Sending `authConfig` replaces the stored credential (re-encrypted under this row's id); omitting
 * it leaves the existing one untouched. There is deliberately no way to *read* the current value
 * back in order to merge into it — a partial credential update would require decrypting and
 * returning the secret first, which is exactly what this column exists to prevent.
 */
import { IsIn, IsObject, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import {
  FIELD_API_LOOKUP_AUTH_TYPES,
  FIELD_API_LOOKUP_HTTP_METHODS,
  FIELD_API_LOOKUP_PROVIDER_STATUSES,
  PROVIDER_DESCRIPTION_MAX_LENGTH,
  PROVIDER_ENDPOINT_URL_MAX_LENGTH,
  PROVIDER_NAME_MAX_LENGTH,
  PROVIDER_RESPONSE_KEY_MAX_LENGTH,
} from '../field-value-sources.constants';

export class UpdateFieldApiLookupProviderDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(PROVIDER_NAME_MAX_LENGTH)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(PROVIDER_DESCRIPTION_MAX_LENGTH)
  description?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(PROVIDER_ENDPOINT_URL_MAX_LENGTH)
  endpointUrl?: string;

  @IsOptional()
  @IsIn(FIELD_API_LOOKUP_HTTP_METHODS)
  httpMethod?: string;

  @IsOptional()
  @IsIn(FIELD_API_LOOKUP_AUTH_TYPES)
  authType?: string;

  @IsOptional()
  @IsObject()
  authConfig?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(PROVIDER_RESPONSE_KEY_MAX_LENGTH)
  responseValueKey?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(PROVIDER_RESPONSE_KEY_MAX_LENGTH)
  responseLabelKey?: string;

  @IsOptional()
  @IsIn(FIELD_API_LOOKUP_PROVIDER_STATUSES)
  status?: string;
}
