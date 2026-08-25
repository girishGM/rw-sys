/**
 * T-047 — sampled access logging (09-INTEGRATION.md §7).
 *
 * > *"Each RPC writes a sampled access log with the service identity, tenant and campaign. **Not**
 * > one audit row per call — at transaction volume that would dwarf every other table."*
 *
 * So this writes to the **application log** (T-019's JSON envelope, correlation-id aware, run
 * through T-017's masking serialiser) and never to `portal_audit_log`. Two consequences worth
 * stating, because both are the point rather than a limitation:
 *
 *  - The portal's audit tables stay a record of *governance* — who approved, who paused, who
 *    changed a grant. A read by a peer service is traffic, not governance.
 *  - Sampling is **1 in {@link ACCESS_LOG_SAMPLE_RATE}, plus every denial**. A denial is rare, is
 *    the line an operator actually needs, and losing 49 out of 50 of them to sampling would make
 *    the log useless exactly when it matters. Every `PERMISSION_DENIED`, `UNAUTHENTICATED` and
 *    `RESOURCE_EXHAUSTED` is therefore logged in full.
 *
 * The counter is deterministic (every Nth call), not random: a random sampler makes "why is there
 * no line for that call?" unanswerable, and a deterministic one is reproducible in a test.
 */
import { Injectable, Logger, Optional } from '@nestjs/common';
import { ACCESS_LOG_SAMPLE_RATE } from './grpc.constants';
import { GrpcStatus, grpcStatusName, type GrpcStatusCode } from './grpc.errors';

export interface AccessLogEntry {
  readonly method: string;
  readonly identity: string;
  readonly tenantId: number | null;
  readonly campaignCode?: string | null;
  readonly status: GrpcStatusCode;
  readonly durationMs: number;
  readonly sections?: readonly string[];
}

/** Statuses that are always logged, whatever the sampler says. */
const ALWAYS_LOGGED: readonly number[] = [
  GrpcStatus.PERMISSION_DENIED,
  GrpcStatus.UNAUTHENTICATED,
  GrpcStatus.RESOURCE_EXHAUSTED,
  GrpcStatus.INTERNAL,
  GrpcStatus.FAILED_PRECONDITION,
];

@Injectable()
export class GrpcAccessLog {
  private readonly logger = new Logger('GrpcAccessLog');
  private counter = 0;

  /**
   * `@Optional()` is load-bearing, not decoration. The emitted `design:paramtypes` for a `number`
   * parameter is `Number`, which is not a provider, so without it Nest refuses to construct this
   * class and — because `GrpcModule` is imported by `AppModule` — the **whole application** fails
   * to boot with *"can't resolve dependencies of the GrpcAccessLog (?)"*. Marking it optional makes
   * Nest pass `undefined`, which is exactly what the default value is for; the sample rate is a
   * constant of the design (`ACCESS_LOG_SAMPLE_RATE`), and the parameter exists only so a test can
   * pin it without reaching into a private field.
   */
  constructor(@Optional() private readonly sampleRate: number = ACCESS_LOG_SAMPLE_RATE) {}

  /** Whether this call would be written, without writing it. Exposed for the test that proves
   * sampling actually samples rather than logging everything. */
  shouldLog(status: GrpcStatusCode): boolean {
    if (ALWAYS_LOGGED.includes(status)) return true;
    return this.counter % this.sampleRate === 0;
  }

  record(entry: AccessLogEntry): void {
    const write = this.shouldLog(entry.status);
    this.counter += 1;
    if (!write) return;

    const line =
      `grpc ${entry.method} identity=${entry.identity} ` +
      `tenant=${entry.tenantId ?? '-'} campaign=${entry.campaignCode ?? '-'} ` +
      `sections=${entry.sections?.join('+') ?? '-'} ` +
      `status=${grpcStatusName(entry.status)} duration_ms=${entry.durationMs}`;

    if (ALWAYS_LOGGED.includes(entry.status)) this.logger.warn(line);
    else this.logger.log(line);
  }
}
