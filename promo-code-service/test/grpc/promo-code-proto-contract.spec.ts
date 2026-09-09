/**
 * T-PC-061. Regression coverage for the defect this task fixes: `GenerateCodeRequest`/
 * `GenerateCodeResponse` must carry a `version_no` field (T-PC-058's own requirement, filed here
 * because the real proto file — `promo_code.v1.proto` — is exclusively `agent-promo-messaging`'s
 * scope, not T-PC-058's own).
 *
 * Deliberately loads and reflects on the real `.proto` file through `@grpc/proto-loader` (the same
 * library `grpc-server.bootstrap.ts`/`test-grpc-client.ts` use to build the real server/client)
 * rather than pattern-matching the source text — a text-regex check (as
 * `promo-code.controller.spec.ts`'s own TC-10/TC-11 use) only proves a substring exists somewhere
 * in the file; this proves the field is actually declared, on the right message, with the right
 * field number and wire type, exactly the way `@grpc/grpc-js` itself will interpret it. Per
 * `AGENT-PROTOCOL.md` §3 ("assert the observable property, not the implementation string"): if
 * `version_no` were misspelled, on the wrong message, or given a numeric type instead of `string`,
 * this test — unlike a text-regex one — would still fail.
 *
 * Proven red on the unfixed code: reverting this task's `proto/promo_code.v1.proto` edit (the only
 * change needed to reproduce) makes every `expectHasStringField` call below throw
 * "field 'versionNo' not found", confirmed by running this file against the pre-fix proto during
 * this task's own diagnosis.
 */
import * as protoLoader from '@grpc/proto-loader';
import { resolveProtoPath } from '@/grpc/grpc-server.config';

interface ReflectedField {
  name: string;
  number: number;
  type: string;
}

interface ReflectedMessage {
  type: { field: ReflectedField[] };
}

function loadMessage(messageName: string): ReflectedMessage {
  const packageDefinition = protoLoader.loadSync(resolveProtoPath(), {}) as unknown as Record<
    string,
    ReflectedMessage
  >;
  const message = packageDefinition[`promocode.v1.${messageName}`];
  if (!message) {
    throw new Error(`message promocode.v1.${messageName} not found`);
  }
  return message;
}

function findField(message: ReflectedMessage, fieldName: string): ReflectedField {
  const field = message.type.field.find((f) => f.name === fieldName);
  if (!field) {
    throw new Error(`field '${fieldName}' not found`);
  }
  return field;
}

describe('T-PC-061 — promo_code.v1.proto carries version_no on GenerateCode request/response', () => {
  // TC-1/TC-3 (this task's own numbering): the reproduced defect / the regression test proving it.
  it('TC-1/TC-3: GenerateCodeRequest declares a string version_no field', () => {
    const field = findField(loadMessage('GenerateCodeRequest'), 'versionNo');
    expect(field.type).toBe('TYPE_STRING');
  });

  // TC-2 (this task's own numbering): the same check, now green.
  it('TC-2: GenerateCodeResponse declares a string version_no field', () => {
    const field = findField(loadMessage('GenerateCodeResponse'), 'versionNo');
    expect(field.type).toBe('TYPE_STRING');
  });

  // TC-4: appended, not renumbered — every pre-existing field keeps its original field number, so
  // an already-deployed caller/consumer never silently reinterprets an old field as a new one.
  it('TC-4: version_no is appended (field 8) without renumbering any existing GenerateCodeRequest field', () => {
    const message = loadMessage('GenerateCodeRequest');
    const expected: Array<[string, number]> = [
      ['correlationId', 1],
      ['tenantId', 2],
      ['bindLevel', 3],
      ['bindRefId', 4],
      ['customerId', 5],
      ['merchantId', 6],
      ['activityContext', 7],
      ['versionNo', 8],
    ];
    for (const [name, number] of expected) {
      expect(findField(message, name).number).toBe(number);
    }
    expect(message.type.field).toHaveLength(expected.length);
  });

  it('TC-4: version_no is appended (field 10) without renumbering any existing GenerateCodeResponse field', () => {
    const message = loadMessage('GenerateCodeResponse');
    const expected: Array<[string, number]> = [
      ['status', 1],
      ['promoCodeId', 2],
      ['code', 3],
      ['rewardValueType', 4],
      ['rewardValue', 5],
      ['rewardUnit', 6],
      ['expiresAt', 7],
      ['errorCode', 8],
      ['errorMessage', 9],
      ['versionNo', 10],
    ];
    for (const [name, number] of expected) {
      expect(findField(message, name).number).toBe(number);
    }
    expect(message.type.field).toHaveLength(expected.length);
  });
});
