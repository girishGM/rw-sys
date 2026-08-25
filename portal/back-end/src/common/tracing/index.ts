/**
 * T-019 — the public surface of the tracing layer.
 *
 * Import from `@/common/tracing`, never from an individual file, so the internal layout can
 * change without a cross-task edit. The names other tasks actually use are `traceSpan` (one line
 * of instrumentation, no constructor change — see `span.service.ts`), `TraceContext` (the
 * ambient correlation id), `outboundTraceHeaders` (propagate to a downstream service, TC-22) and
 * `SpanService` (the injectable form, for T-045).
 *
 * **`TracingModule` is deliberately not re-exported here**, for the reason `@/common/crypto`,
 * `@/common/rbac`, `@/common/audit` and `@/common/data-protection` all give: it imports
 * `DatabaseModule` → `ConfigModule`, whose `validate` calls `process.exit(1)` on an incomplete
 * environment, so a barrel that reaches it is a barrel no unit test can import. Import it from
 * `@/common/tracing/tracing.module`, which is a module file and nowhere else.
 *
 * `logger.config.ts` is likewise not re-exported: it pulls in winston and the T-017 serialiser,
 * and its only consumers are `LoggerModule` and its own spec, both of which name it directly.
 */
export * from './correlation.middleware';
export * from './otel';
export * from './span.service';
export * from './sql-comment.hook';
export * from './trace-context';
