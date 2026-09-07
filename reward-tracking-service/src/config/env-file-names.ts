/**
 * T-RTS-001. The single source of truth for which dotenv files this service loads, and in what
 * precedence order.
 *
 * Two independent things need this exact same list — kept as one shared helper rather than two
 * hand-written copies, the fix reward-redemption-service's own T-RR-050 applied after finding the
 * two had drifted apart in that sibling service (see `load-dotenv-files.ts`'s header for the full
 * root-cause writeup this file avoids from day one):
 *
 *   1. `config.module.ts`'s `NestConfigModule.forRoot({ envFilePath })` — feeds `config.schema.ts`'s
 *      Zod-validated bootstrap subset (`DB_HOST`, `KAFKA_BROKERS`, etc.).
 *   2. `load-dotenv-files.ts`'s eager, direct `process.env` loader — feeds every OTHER var that a
 *      later, differently-scoped module (Wave 1+) reads straight from `process.env` instead.
 *
 * If these two ever resolved a different file for the same `NODE_ENV`, a var could be present for
 * one loading path and silently absent for the other — extracting the list here means changing the
 * precedence is one edit, not two kept in sync by hand.
 */
export function getEnvFileNames(nodeEnv: string | undefined = process.env.NODE_ENV): string[] {
  return ['.env.local', `.env.${nodeEnv || 'development'}`, '.env'];
}
