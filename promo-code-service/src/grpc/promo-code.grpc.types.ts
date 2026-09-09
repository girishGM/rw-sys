/**
 * T-PC-031. Hand-written TypeScript shapes for `proto/promo_code.v1.proto`'s messages, as
 * `@grpc/proto-loader` hands them to a handler at runtime — camelCase (proto-loader's default
 * `keepCase: false`, unchanged in `grpc-server.bootstrap.ts`'s loader options), every field a
 * `string` exactly as the `.proto` declares (implementation note 2 — money is never a numeric
 * type). No code-generation step (`ts-proto` or similar) is wired into this project; these are
 * kept hand-in-sync with the `.proto` file the same way `PromoCodeConfigRow`/`PromoCodeConfig`
 * are kept hand-in-sync with their own migration (`promo-code-config.entity.ts`'s own
 * convention) — small, stable message set, reviewed together with the `.proto` file on any
 * change.
 *
 * T-PC-061: `versionNo` added to both `GenerateCodeRequestProto` (optional — an explicit version
 * pin, empty/absent when the caller has none) and `GenerateCodeResponseProto` (required like its
 * siblings — the resolved version, `''` when not yet populated). See `promo_code.v1.proto`'s own
 * header for why `GenerateCodeResponseProto.versionNo` is only wired to a literal `''` placeholder
 * in `promo-code.controller.ts` today, not yet a real resolved value (T-PC-060's scope).
 */

export interface ActivityContextProto {
  amount?: string;
  currency?: string;
  metadataJson?: string;
}

export interface GenerateCodeRequestProto {
  correlationId?: string;
  tenantId?: string;
  bindLevel?: string;
  bindRefId?: string;
  customerId?: string;
  merchantId?: string;
  activityContext?: ActivityContextProto;
  versionNo?: string;
}

export interface GenerateCodeResponseProto {
  status: string;
  promoCodeId: string;
  code: string;
  rewardValueType: string;
  rewardValue: string;
  rewardUnit: string;
  expiresAt: string;
  errorCode: string;
  errorMessage: string;
  versionNo: string;
}

export interface ListActivePromoCodeConfigsRequestProto {
  tenantId?: string;
  merchantId?: string;
}

export interface PromoCodeConfigSummaryProto {
  id: string;
  name: string;
  rewardValueType: string;
  rewardValue: string;
  rewardUnit: string;
}

export interface PromoCodeConfigListProto {
  configs: PromoCodeConfigSummaryProto[];
}
