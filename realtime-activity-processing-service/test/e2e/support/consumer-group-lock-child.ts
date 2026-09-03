/**
 * T-RAP-056 / T-RAP-041 (retry 1). Standalone child-process helper for
 * `kafka-shared-consumer-group-lock.spec.ts`'s own regression coverage — spawned as a REAL, separate
 * OS process (never `require`d directly) so that suite can prove the lock module's own cross-process
 * mutual-exclusion guarantee against an actual second process, not just call the same in-process
 * functions twice (which the module's own reentrant counter would legitimately allow, but which
 * would prove nothing about the cross-process case this task exists to fix).
 *
 * Never imported by, or spawned from, a real full-pipeline/ingest-consumer spec file — test-only
 * support for this one regression suite.
 *
 * Usage: `ts-node-transpile-only consumer-group-lock-child.ts <mode> <holdMs> [acquireTimeoutMs]`
 * where `<mode>` is `writer` or `reader` — both exercise the SAME underlying cross-process mutex (see
 * `kafka-shared-consumer-group-lock.ts`'s own header), so this only affects which entry point is
 * called, not the outcome. Prints one JSON line to stdout as soon as the outcome (acquired, or failed
 * to acquire) is known, so the parent process can read a single `readline`-friendly line without
 * waiting for the child to exit.
 *
 * T-RAP-056 retry 1 adds a third mode, `hammer <iterations> <holdMs>`: acquires and releases the
 * writer lock `iterations` times back-to-back in a tight loop, with essentially zero delay between
 * one iteration's own release and the next iteration's own re-acquire attempt — deliberately
 * reproducing the exact structural pattern (`full-pipeline-multi-instance.e2e-spec.ts`'s own several
 * sequential per-TC `startInstance()`/`close()` cycles) that starved out a genuine stranger waiter
 * under the pre-fix, race-based mutex. Prints one JSON line PER iteration (not just the first), so
 * the parent can assert exactly when each of this hammering process's own re-acquisitions actually
 * happened relative to a concurrently-waiting stranger's own single acquisition.
 */
import {
  acquireIngestConsumerGroupReaderLease,
  acquireIngestConsumerGroupWriterLock,
  releaseIngestConsumerGroupWriterLock,
  type IngestConsumerGroupReaderLease,
} from '../kafka-shared-consumer-group-lock';

async function runHammer(iterations: number, holdMs: number): Promise<void> {
  for (let i = 0; i < iterations; i += 1) {
    const requestedAt = Date.now();
    try {
      // Deliberately generous per-iteration acquire budget: this mode's own point is to prove
      // fairness holds even when this process retries essentially immediately, not to prove
      // anything about acquire timeouts.
      await acquireIngestConsumerGroupWriterLock(30_000);
    } catch (error) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, iteration: i, requestedAt, error: (error as Error).message })}\n`,
      );
      process.exitCode = 1;
      return;
    }
    const acquiredAt = Date.now();
    process.stdout.write(
      `${JSON.stringify({ ok: true, iteration: i, requestedAt, acquiredAt })}\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, holdMs));
    releaseIngestConsumerGroupWriterLock();
    // No delay here on purpose — the very next loop iteration's own acquire attempt begins
    // immediately, which is the exact structural advantage a fair, ticket-ordered queue must not
    // let this process exploit against an already-waiting stranger.
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode !== 'writer' && mode !== 'reader' && mode !== 'hammer') {
    throw new Error(
      `consumer-group-lock-child.ts: unknown mode "${String(mode)}" (want writer|reader|hammer)`,
    );
  }

  if (mode === 'hammer') {
    const iterations = Number(process.argv[3] ?? '5');
    const holdMs = Number(process.argv[4] ?? '300');
    await runHammer(iterations, holdMs);
    return;
  }

  const holdMs = Number(process.argv[3] ?? '500');
  const acquireTimeoutMsArg = process.argv[4];
  const acquireTimeoutMs =
    acquireTimeoutMsArg === undefined ? undefined : Number(acquireTimeoutMsArg);

  const requestedAt = Date.now();
  let readerLease: IngestConsumerGroupReaderLease | undefined;
  try {
    if (mode === 'writer') {
      if (acquireTimeoutMs === undefined) {
        await acquireIngestConsumerGroupWriterLock();
      } else {
        await acquireIngestConsumerGroupWriterLock(acquireTimeoutMs);
      }
    } else {
      readerLease =
        acquireTimeoutMs === undefined
          ? await acquireIngestConsumerGroupReaderLease()
          : await acquireIngestConsumerGroupReaderLease(acquireTimeoutMs);
    }
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, requestedAt, error: (error as Error).message })}\n`,
    );
    process.exitCode = 1;
    return;
  }
  const acquiredAt = Date.now();
  process.stdout.write(`${JSON.stringify({ ok: true, requestedAt, acquiredAt })}\n`);

  await new Promise((resolve) => setTimeout(resolve, holdMs));
  if (mode === 'writer') {
    releaseIngestConsumerGroupWriterLock();
  } else {
    readerLease?.release();
  }
}

main().catch((error: unknown) => {
  process.stdout.write(`${JSON.stringify({ ok: false, error: String(error) })}\n`);
  process.exitCode = 1;
});
