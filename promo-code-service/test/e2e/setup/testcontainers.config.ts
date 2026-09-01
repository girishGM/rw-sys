/**
 * T-PC-040. Real-broker configuration/lifecycle control for the `test/e2e/**` suite.
 *
 * **Deviation from the task file's literal file name/prose** ("via testcontainers or an
 * embedded/real Redpanda instance... either is acceptable"): no `testcontainers` npm package is
 * installed in this project, and adding one means editing `package.json`'s `devDependencies` —
 * outside this agent's own delegated file scope (`project.config.json` grants `agent-promo-qa`
 * only `test/e2e/**`/`test/security/**`/`src/observability/**`/`docs/handover.md`; `package.json`
 * is `agent-promo-foundation`'s). This file therefore implements the task's own explicitly
 * sanctioned alternative instead: "the same Redpanda instance from T-PC-001's `docker-compose.yml`"
 * — the identical real-broker convention `test/messaging/generate-requested.consumer.e2e-spec.ts`
 * (T-PC-030) and `test/grpc/grpc-server.e2e-spec.ts` (T-PC-031) already established for this
 * project. Recorded in this task's completion report under "Deviations from spec", not silently
 * resolved (`AGENT-PROTOCOL.md` §3).
 *
 * The one thing this file adds beyond that existing precedent is **broker lifecycle control**
 * (`stopRedpandaBroker`/`startRedpandaBroker`/`waitForRedpandaReady`) — needed only by
 * `outbox-broker-outage.e2e-spec.ts`'s TC-6, which is the first spec in this project that actually
 * has to take the broker down and bring it back up again, not just connect to an already-running
 * one.
 */
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { connect } from 'node:net';

const execFileAsync = promisify(execFile);

/** `promo-code-service/` — where `docker-compose.yml` (T-PC-001) lives, three levels up from
 * this file (`test/e2e/setup/` → `test/e2e/` → `test/` → `promo-code-service/`). */
const PROJECT_ROOT = join(__dirname, '..', '..', '..');

export const KAFKA_BROKERS: string[] = String(process.env.KAFKA_BROKERS ?? 'localhost:9092')
  .split(',')
  .map((broker) => broker.trim())
  .filter(Boolean);

/** `docker-compose.yml`'s own service name — never a container id, so this works identically
 * across machines/CI runs regardless of how compose happens to name the container instance. */
const REDPANDA_SERVICE = 'redpanda';

/** `docker-compose.yml`'s own healthcheck target — polled directly here too, rather than
 * trusting `docker compose start`'s return to mean "ready to accept connections" (starting the
 * container and the broker inside it finishing its own boot sequence are two different events). */
const REDPANDA_READY_URL = 'http://localhost:9644/v1/status/ready';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Stops (not removes) the real Redpanda container this project's own `docker-compose.yml`
 * defines — a real broker outage, not a simulated one, per `AGENT-PROTOCOL.md` §3's "real thing,
 * not a mock that agrees with itself" discipline extended to infrastructure failure as well as
 * infrastructure success.
 */
export async function stopRedpandaBroker(): Promise<void> {
  await execFileAsync('docker', ['compose', 'stop', REDPANDA_SERVICE], { cwd: PROJECT_ROOT });
}

/** Restarts the same (already-created) container `stopRedpandaBroker` stopped. */
export async function startRedpandaBroker(): Promise<void> {
  await execFileAsync('docker', ['compose', 'start', REDPANDA_SERVICE], { cwd: PROJECT_ROOT });
}

/**
 * Polls the admin API's own readiness endpoint (same URL `docker-compose.yml`'s own healthcheck
 * uses) until it responds `200`, or throws once `timeoutMs` elapses. Needed because
 * `startRedpandaBroker`'s `docker compose start` resolves once the container process exists, not
 * once Redpanda has finished its own internal boot sequence and can actually accept a KafkaJS
 * connection again.
 */
export async function waitForRedpandaReady(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(REDPANDA_READY_URL);
      if (response.ok) {
        return;
      }
    } catch {
      // Not ready yet — admin API not accepting connections at all. Fall through to retry.
    }
    if (Date.now() > deadline) {
      throw new Error(`waitForRedpandaReady: broker not ready after ${timeoutMs}ms`);
    }
    await wait(500);
  }
}

/** Resolves `true` if a raw TCP connect to `host:port` succeeds within `timeoutMs`, `false`
 * otherwise (refused, reset, or timed out) — never rejects. */
function isPortOpen(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: timeoutMs });
    const settle = (open: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.once('connect', () => settle(true));
    socket.once('timeout', () => settle(false));
    socket.once('error', () => settle(false));
  });
}

/**
 * The mirror image of {@link waitForRedpandaReady}: polls both the admin readiness endpoint *and*
 * a raw TCP connect to the real Kafka listener port (`KAFKA_BROKERS`, the port `KafkaProducerService`
 * actually publishes on) until neither answers, or throws once `timeoutMs` elapses. Checking the
 * admin API alone is not enough — `docker compose stop`'s own graceful shutdown
 * (`stop_grace_period`) means the container process, and each of its listeners, can each stop
 * accepting connections at slightly different moments, and Redpanda can still be genuinely
 * reachable and serving *producer* requests for a real, observed window *after* the admin API has
 * already stopped answering (confirmed directly during this task's own verification pass: a
 * `runOnce()` call issued immediately after the admin API alone was already unreachable
 * occasionally still published successfully). `outbox-broker-outage.e2e-spec.ts`'s TC-6 calls this
 * immediately after `stopRedpandaBroker()` and before asserting a publish attempt must fail, so
 * that assertion is against an *observed* outage on the actual producer path, not an assumed one —
 * the same "assert the observable property" discipline `AGENT-PROTOCOL.md` §3 already requires
 * everywhere else in this suite, extended to the outage's own start edge as well as its end.
 */
export async function waitForRedpandaStopped(timeoutMs: number): Promise<void> {
  const [kafkaHost, kafkaPortRaw] = (KAFKA_BROKERS[0] ?? 'localhost:9092').split(':');
  const kafkaPort = Number(kafkaPortRaw);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [adminOpen, kafkaOpen] = await Promise.all([
      fetch(REDPANDA_READY_URL, { signal: AbortSignal.timeout(1_000) })
        .then(() => true)
        .catch(() => false),
      isPortOpen(kafkaHost, kafkaPort, 1_000),
    ]);
    if (!adminOpen && !kafkaOpen) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`waitForRedpandaStopped: broker still reachable after ${timeoutMs}ms`);
    }
    await wait(200);
  }
}
