/**
 * T-RR-050. The single source of truth for which dotenv files this service loads, and in what
 * precedence order.
 *
 * Two independent things need this exact same list, and previously kept two hand-written copies
 * of it (`config.module.ts`'s own `envFilePath` array, and — before this task — no second copy at
 * all, which was the bug):
 *
 *   1. `config.module.ts`'s `NestConfigModule.forRoot({ envFilePath })` — feeds `config.schema.ts`'s
 *      Zod-validated bootstrap subset (`DB_HOST`, `KAFKA_BROKERS`, etc.).
 *   2. `load-dotenv-files.ts`'s eager, direct `process.env` loader (new in this task) — feeds every
 *      OTHER var that a later, differently-scoped module reads straight from `process.env` instead
 *      (`FIELD_ENCRYPTION_*`, `CACHE_ADMIN_TOKEN`, etc. — see `config.schema.ts`'s own header for
 *      why those are deliberately excluded from the Zod schema).
 *
 * If these two ever resolved a different file for the same `NODE_ENV`, a var could be present for
 * one loading path and silently absent for the other — extracting the list here means changing the
 * precedence is one edit, not two kept in sync by hand.
 */
export function getEnvFileNames(nodeEnv: string | undefined = process.env.NODE_ENV): string[] {
  return ['.env.local', `.env.${nodeEnv || 'development'}`, '.env'];
}
