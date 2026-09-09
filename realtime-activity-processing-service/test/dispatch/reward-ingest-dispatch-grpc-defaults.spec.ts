/**
 * T-INT-006, TC-6. The port-default regression test — "RAP's gRPC client's own default port
 * constant equals 50081, read from RR's own `grpc-server.config.ts` default (parity-style test, not
 * a restated literal)". Guards against exactly the defect this task fixes: RAP's
 * `RewardGrpcFallbackClient` used to hardcode `50061` while RR's real gRPC server (the actual thing
 * this client dials) defaulted `50081` — two independent literals that both "passed" every prior
 * test suite while silently disagreeing with each other. A test that only re-asserted RAP's own
 * constant equals `50081` would not have caught that mismatch either (it would have "passed" while
 * still restating the *wrong* value, `50061`, right alongside it) — this file instead reads RR's
 * own real source file directly off disk and compares against it, so a future regression on either
 * side fails this test, not just a silent divergence.
 *
 * Reads two files across the `src/`/`proto/` directory boundary and across the sibling
 * `reward-redemption-service/` repo directory — safe here because Jest transforms/executes each
 * test file independently (no single whole-program `tsc` emit the way `nest build` does), unlike
 * `reward-grpc-fallback.client.ts` itself, which deliberately does NOT import
 * `proto/reward_ingest_dispatch_grpc_defaults.ts` for exactly that reason (see that file's own
 * header).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_REWARD_REDEMPTION_GRPC_PORT as CLIENT_DEFAULT_PORT } from '@/modules/dispatch/reward-grpc-fallback.client';
import { DEFAULT_REWARD_REDEMPTION_GRPC_PORT as PROTO_DEFAULTS_PORT } from '../../proto/reward_ingest_dispatch_grpc_defaults';

/** RR's own real gRPC server config file — the actual server this leg's gRPC fallback dials. Three
 * levels up from `test/dispatch/` is this service's own root
 * (`realtime-activity-processing-service/`); one more level up is the repo root, then into RR's own
 * directory. */
function rrGrpcServerConfigPath(): string {
  return join(
    __dirname,
    '..',
    '..',
    '..',
    'reward-redemption-service',
    'src',
    'grpc',
    'grpc-server.config.ts',
  );
}

/** Extracts RR's own `export const DEFAULT_GRPC_PORT = <n>;` value by reading its real source —
 * never a copy-pasted literal on this side. */
function readRrDefaultGrpcPort(): number {
  const source = readFileSync(rrGrpcServerConfigPath(), 'utf8');
  const match = source.match(/export const DEFAULT_GRPC_PORT\s*=\s*(\d+)\s*;/);
  if (!match) {
    throw new Error(
      `Could not find "export const DEFAULT_GRPC_PORT = <n>;" in ${rrGrpcServerConfigPath()} — ` +
        'has RR renamed or restructured its own gRPC server port default?',
    );
  }
  return Number.parseInt(match[1], 10);
}

describe('T-INT-006 TC-6 — RAP <-> RR gRPC port-default parity', () => {
  it('RewardGrpcFallbackClient default port matches reward-redemption-service’s real gRPC server default', () => {
    const rrDefault = readRrDefaultGrpcPort();
    expect(rrDefault).toBe(50081);
    expect(CLIENT_DEFAULT_PORT).toBe(rrDefault);
  });

  it('proto/reward_ingest_dispatch_grpc_defaults.ts stays in sync with the client’s own constant', () => {
    expect(PROTO_DEFAULTS_PORT).toBe(CLIENT_DEFAULT_PORT);
  });

  it('regression guard: the old, mismatched RAP default (50061) is gone from both constants', () => {
    expect(CLIENT_DEFAULT_PORT).not.toBe(50061);
    expect(PROTO_DEFAULTS_PORT).not.toBe(50061);
  });
});
