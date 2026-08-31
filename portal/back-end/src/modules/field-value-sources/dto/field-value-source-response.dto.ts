/**
 * T-121 — the response bodies the two registry endpoints return.
 *
 * Built by hand from the model instances, never by spreading a Sequelize row — the same
 * construction rule `rule-registry-response.dto.ts` follows. Here that rule is load-bearing rather
 * than stylistic: `FieldApiLookupProvider.authConfigEnc` holds an encrypted credential, and
 * `{ ...row.get() }` would put it in a response body the moment someone added the column. Listing
 * every field explicitly means a new sensitive column is invisible to the API until a human
 * deliberately adds it here.
 *
 * `authConfigEnc` is therefore absent below, and so is any decrypted form of it. Verification
 * step 2 of this task — *"no plaintext credential ever appears in the response"* — holds by
 * construction, not by filtering.
 */
import type { FieldApiLookupProvider } from '@/database/models/field-api-lookup-provider.model';
import type { FieldContextProvider } from '@/database/models/field-context-provider.model';

/** The API-wide `{ data }` envelope. Each module keeps its own copy — see
 * `rule-response.dto.ts`'s note: this is a convention no task owns a shared home for. */
export interface DataEnvelope<T> {
  readonly data: T;
}

export function envelope<T>(data: T): DataEnvelope<T> {
  return { data };
}

export interface FieldContextProviderDto {
  readonly id: number;
  readonly providerCode: string;
  readonly name: string;
  readonly description: string | null;
  readonly status: string;
}

export function toFieldContextProviderDto(row: FieldContextProvider): FieldContextProviderDto {
  return {
    id: row.id,
    providerCode: row.providerCode,
    name: row.name,
    description: row.description,
    status: row.status,
  };
}

/**
 * `authType` is included; `authConfigEnc` is not. Knowing a provider *needs* a bearer token is
 * not a secret — the Maker-facing UI (T-125) needs it to explain why a `planned` provider is not
 * usable yet. The token itself never leaves the process.
 */
export interface FieldApiLookupProviderDto {
  readonly id: number;
  readonly providerCode: string;
  readonly name: string;
  readonly description: string | null;
  readonly endpointUrl: string;
  readonly httpMethod: string;
  readonly authType: string;
  readonly responseValueKey: string;
  readonly responseLabelKey: string;
  readonly status: string;
}

export function toFieldApiLookupProviderDto(
  row: FieldApiLookupProvider,
): FieldApiLookupProviderDto {
  return {
    id: row.id,
    providerCode: row.providerCode,
    name: row.name,
    description: row.description,
    endpointUrl: row.endpointUrl,
    httpMethod: row.httpMethod,
    authType: row.authType,
    responseValueKey: row.responseValueKey,
    responseLabelKey: row.responseLabelKey,
    status: row.status,
  };
}
