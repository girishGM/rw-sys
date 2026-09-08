/**
 * T-INT-002. The actual point of this task, not an afterthought
 * (`reward-service-integration-plan/tasks/T-INT-002-fix-rr-rts-contract-mismatch.md`,
 * implementation note 4): reads reward-tracking-service's (RTS's) real, shipped source files
 * directly — never a second, independently-typed-out constant that merely happens to agree with
 * this service's (RR's) own literals today — and asserts RR's own REST path and gRPC
 * package/service/method/field-shape literals equal what RTS's real files actually declare.
 *
 * This is exactly the test shape `AGENT-PROTOCOL.md` §3 requires ("assert the observable property,
 * not the implementation string") for anything a network protocol ultimately judges: T-RR-062/
 * T-RR-035 both shipped, and their own unit test suites both passed, while quietly guessing wrong
 * about RTS's real contract — because every assertion in both suites compared RR's own code against
 * RR's own hand-typed constants, never against RTS's actual source. This file is what would have
 * caught that the day it happened, and is what stops it from silently drifting again: any future
 * change to either side's contract literals, on either side of the repo, fails this suite loudly.
 *
 * Deliberately touches `reward-tracking-service/**` only via `fs.readFileSync` (read-only) — R0 of
 * `reward-tracking-service-plan/AGENT-PROTOCOL.md` forbids any *other* plan's task from editing
 * those files, but this plan's own R0 (`reward-service-integration-plan/AGENT-PROTOCOL.md`)
 * explicitly permits *reading* across service boundaries, and this task's own "Out" section commits
 * to zero writes there — confirmed by this file never importing `fs.writeFileSync`/`fs.rmSync` or
 * any RTS module for execution, only `readFileSync` for literal extraction.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REWARD_TRACKING_COMPLETED_PATH } from '@/modules/dispatch/reward-tracking-rest.client';

// -------------------------------------------------------------------------------------------
// File locations — RTS's real, canonical source (read-only), and RR's own contract files.
// -------------------------------------------------------------------------------------------

function rtsRoot(): string {
  // test/dispatch -> test -> reward-redemption-service -> reward-system (repo root) -> reward-tracking-service
  return join(__dirname, '..', '..', '..', 'reward-tracking-service');
}

function rtsIngestControllerSource(): string {
  return readFileSync(
    join(rtsRoot(), 'src', 'modules', 'ingestion', 'reward-tracking-ingest.controller.ts'),
    'utf8',
  );
}

function rtsProtoSource(): string {
  return readFileSync(join(rtsRoot(), 'proto', 'reward_tracking_ingest.proto'), 'utf8');
}

function rrProtoSource(): string {
  return readFileSync(
    join(__dirname, '..', '..', 'proto', 'reward_tracking_dispatch.proto'),
    'utf8',
  );
}

function rrGrpcClientSource(): string {
  return readFileSync(
    join(__dirname, '..', '..', 'src', 'modules', 'dispatch', 'reward-tracking-grpc.client.ts'),
    'utf8',
  );
}

// -------------------------------------------------------------------------------------------
// Extraction helpers — pure, throw loudly (never silently return an empty/best-effort value) if
// the shape they expect isn't found, so a genuine future refactor of either side's file structure
// fails this suite immediately rather than passing on an accidentally-empty comparison.
// -------------------------------------------------------------------------------------------

/** Reads a NestJS controller's real, effective REST route: `@Controller('<prefix>')` combined with
 * the target method's own `@Post(...)` (no argument means "same as the controller prefix"). */
function extractRestPath(controllerSource: string): string {
  const controllerMatch = controllerSource.match(/@Controller\(\s*['"]([^'"]+)['"]\s*\)/);
  if (!controllerMatch) {
    throw new Error('could not find @Controller(...) decorator in RTS ingest controller source');
  }
  const postMatch = controllerSource.match(/@Post\(\s*(?:['"]([^'"]*)['"])?\s*\)/);
  if (!postMatch) {
    throw new Error('could not find @Post(...) decorator in RTS ingest controller source');
  }
  const segments = [controllerMatch[1], postMatch[1] ?? ''].filter((segment) => segment.length > 0);
  return `/${segments.join('/')}`;
}

interface GrpcContractSummary {
  packageName: string;
  serviceName: string;
  methodName: string;
  fullMethodPath: string;
}

function extractGrpcContract(protoSource: string): GrpcContractSummary {
  const packageMatch = protoSource.match(/^package\s+([\w.]+)\s*;/m);
  if (!packageMatch) {
    throw new Error('could not find "package ...;" declaration in proto source');
  }
  const serviceMatch = protoSource.match(/service\s+(\w+)\s*\{/);
  if (!serviceMatch) {
    throw new Error('could not find "service ... {" declaration in proto source');
  }
  const rpcMatch = protoSource.match(/rpc\s+(\w+)\s*\(/);
  if (!rpcMatch) {
    throw new Error('could not find "rpc ...(" declaration in proto source');
  }
  const packageName = packageMatch[1];
  const serviceName = serviceMatch[1];
  const methodName = rpcMatch[1];
  return {
    packageName,
    serviceName,
    methodName,
    fullMethodPath: `/${packageName}.${serviceName}/${methodName}`,
  };
}

interface ProtoField {
  type: string;
  number: number;
}

/** Parses every `<type> <name> = <number>;` line inside `message <messageName> { ... }` into a
 * `name -> {type, number}` map. Deliberately ignores comments/whitespace, not full proto3 grammar —
 * sufficient for this repo's own convention (no nested messages, no `oneof`, no `repeated`, in
 * either of these two message types, confirmed by direct read of both files). */
function parseMessageFields(protoSource: string, messageName: string): Map<string, ProtoField> {
  const messageRegex = new RegExp(`message\\s+${messageName}\\s*\\{([\\s\\S]*?)\\n\\}`, 'm');
  const messageMatch = protoSource.match(messageRegex);
  if (!messageMatch) {
    throw new Error(`could not find "message ${messageName} { ... }" in proto source`);
  }
  const body = messageMatch[1];
  const fieldRegex = /^\s*(string|int32|int64|bool|double)\s+(\w+)\s*=\s*(\d+)\s*;/gm;
  const fields = new Map<string, ProtoField>();
  let match: RegExpExecArray | null;
  while ((match = fieldRegex.exec(body)) !== null) {
    const [, type, name, numberText] = match;
    fields.set(name, { type, number: Number(numberText) });
  }
  if (fields.size === 0) {
    throw new Error(`message ${messageName} parsed with zero fields — regex likely out of sync`);
  }
  return fields;
}

/** Throws a descriptive error when `actual !== expected` — the one comparison every assertion in
 * this file ultimately reduces to, factored out so TC-5 (below) can prove it actually discriminates
 * instead of vacuously passing. */
function assertEqualOrThrow(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(
      `${label} mismatch: RR has ${JSON.stringify(actual)}, RTS has ${JSON.stringify(expected)}`,
    );
  }
}

// -------------------------------------------------------------------------------------------
// TC-1 — REST path parity.
// -------------------------------------------------------------------------------------------

describe('T-INT-002 — RR/RTS REST contract parity', () => {
  it("TC-1: RR's configured REST dispatch path equals RTS's real @Post route", () => {
    const rtsRealPath = extractRestPath(rtsIngestControllerSource());

    expect(rtsRealPath).toBe('/internal/reward-tracking-events');
    assertEqualOrThrow(REWARD_TRACKING_COMPLETED_PATH, rtsRealPath, 'REST dispatch path');
  });
});

// -------------------------------------------------------------------------------------------
// TC-2 — gRPC package/service/method + message field-shape parity.
// -------------------------------------------------------------------------------------------

describe('T-INT-002 — RR/RTS gRPC contract parity', () => {
  it("TC-2: RR's proto package/service/method equals RTS's real, canonical proto", () => {
    const rts = extractGrpcContract(rtsProtoSource());
    const rr = extractGrpcContract(rrProtoSource());

    expect(rts.fullMethodPath).toBe(
      '/rewardtracking.ingest.v1.RewardTrackingIngestService/IngestRewardTrackingEvent',
    );
    assertEqualOrThrow(rr.packageName, rts.packageName, 'gRPC package');
    assertEqualOrThrow(rr.serviceName, rts.serviceName, 'gRPC service name');
    assertEqualOrThrow(rr.methodName, rts.methodName, 'gRPC method name');
    assertEqualOrThrow(rr.fullMethodPath, rts.fullMethodPath, 'gRPC full method path');
  });

  it("RR's gRPC client stub navigates the same package/service path its own .proto declares (never a stale hardcoded literal)", () => {
    const rr = extractGrpcContract(rrProtoSource());
    const clientSource = rrGrpcClientSource();

    // `proto.rewardtracking.ingest.v1.RewardTrackingIngestService` — the exact property-access
    // chain the dynamically-loaded package definition must be navigated through, one segment per
    // package component plus the final service name.
    const expectedNavigation = `${rr.packageName}.${rr.serviceName}`;
    expect(clientSource).toContain(`proto.${expectedNavigation}`);

    // The generated client method for RPC `IngestRewardTrackingEvent` is its own name with a
    // lowercased first letter (`@grpc/grpc-js`'s own convention, confirmed by this repo's existing
    // `CampaignHierarchyClient`/`listActiveCampaigns` precedent) — never the old
    // `dispatchRedemptionCompleted` literal.
    const expectedClientMethod = rr.methodName.charAt(0).toLowerCase() + rr.methodName.slice(1);
    expect(clientSource).toContain(`client.${expectedClientMethod}(`);
  });

  it("TC-2: every field RTS's real request message declares is present in RR's own request message, at the identical wire number and type", () => {
    const rtsFields = parseMessageFields(rtsProtoSource(), 'IngestRewardTrackingEventRequest');
    const rrFields = parseMessageFields(rrProtoSource(), 'RedemptionCompletedMessage');

    for (const [fieldName, rtsField] of rtsFields) {
      const rrField = rrFields.get(fieldName);
      if (!rrField) {
        throw new Error(
          `RTS's real request message declares field "${fieldName}" (wire #${rtsField.number}) ` +
            "that RR's own message does not declare at all",
        );
      }
      assertEqualOrThrow(rrField.number, rtsField.number, `field "${fieldName}" wire number`);
      assertEqualOrThrow(rrField.type, rtsField.type, `field "${fieldName}" wire type`);
    }
    // RR must not declare a field number RTS doesn't also declare — a stray extra field number
    // would silently collide with whatever RTS itself puts at that wire position.
    for (const [fieldName, rrField] of rrFields) {
      const rtsField = rtsFields.get(fieldName);
      if (!rtsField) {
        throw new Error(
          `RR's own request message declares field "${fieldName}" (wire #${rrField.number}) ` +
            "that RTS's real message does not declare at all",
        );
      }
    }
  });

  it("TC-2: RR's DispatchAck response message field-shape matches RTS's real response message", () => {
    const rtsFields = parseMessageFields(rtsProtoSource(), 'IngestRewardTrackingEventResponse');
    const rrFields = parseMessageFields(rrProtoSource(), 'DispatchAck');

    assertEqualOrThrow(rrFields.size, rtsFields.size, 'response message field count');
    for (const [fieldName, rtsField] of rtsFields) {
      const rrField = rrFields.get(fieldName);
      if (!rrField) {
        throw new Error(`RTS's real response message declares field "${fieldName}" RR does not`);
      }
      assertEqualOrThrow(
        rrField.number,
        rtsField.number,
        `response field "${fieldName}" wire number`,
      );
      assertEqualOrThrow(rrField.type, rtsField.type, `response field "${fieldName}" wire type`);
    }
  });
});

// -------------------------------------------------------------------------------------------
// TC-5 (negative) — the comparison itself must fail loudly on a genuine mismatch, not just pass
// vacuously. Reproduces this exact bug's own historical values: T-RR-062's pre-RTS guess
// (`rewardtracking.v1.RewardTrackingDispatchService/DispatchRedemptionCompleted`) against RTS's
// real, shipped contract — proving that had this test existed before RTS shipped, it would have
// failed the build immediately instead of staying green.
// -------------------------------------------------------------------------------------------

describe('T-INT-002 — TC-5 (negative): parity check fails loudly on a genuine mismatch', () => {
  it("reproduces the original bug: RR's pre-fix gRPC literal vs. RTS's real contract does not silently pass", () => {
    const rtsRealFullMethodPath = extractGrpcContract(rtsProtoSource()).fullMethodPath;
    const rrPreFixFullMethodPath =
      '/rewardtracking.v1.RewardTrackingDispatchService/DispatchRedemptionCompleted';

    expect(() =>
      assertEqualOrThrow(rrPreFixFullMethodPath, rtsRealFullMethodPath, 'gRPC full method path'),
    ).toThrow(/gRPC full method path mismatch/);
  });

  it("reproduces the original bug: RR's pre-fix REST path vs. RTS's real path does not silently pass", () => {
    const rtsRealPath = extractRestPath(rtsIngestControllerSource());
    const rrPreFixPath = '/api/v1/redemptions/completed';

    expect(() => assertEqualOrThrow(rrPreFixPath, rtsRealPath, 'REST dispatch path')).toThrow(
      /REST dispatch path mismatch/,
    );
  });

  it('a genuinely equal pair never throws (the check is not just permanently failing)', () => {
    expect(() => assertEqualOrThrow('same-value', 'same-value', 'sanity check')).not.toThrow();
  });
});
