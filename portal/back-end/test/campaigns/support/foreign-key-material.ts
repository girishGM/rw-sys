/**
 * T-037 e2e support — surviving another suite's leftover `encryption_keys` rows.
 *
 * ### The problem, observed rather than anticipated
 *
 * `KeyRegistryService.onModuleInit` loads **every** row of `reward_portal.encryption_keys` and
 * throws if any one of them names an environment variable this process does not have:
 *
 * > `Environment variable 'T042_T056_FIELD_KEY' (key_ref for kid=t042_t056_fld) is not set. Every
 * > key referenced by encryption_keys must be present at boot.`
 *
 * That is exactly the right behaviour for production — a key registry that silently skips a key it
 * cannot resolve is a registry that silently stops decrypting something. But in a shared
 * development database it means **any** e2e suite that dies before its `afterAll` leaves rows
 * behind that stop every *other* suite from booting at all. When this was written the live table
 * held `t042_t056_fld` / `t042_t056_bidx`, active, from an in-flight T-042 run — a task owned by
 * a different agent and outside this task's file scope (R9).
 *
 * ### Why supplying material is the right fix, and deleting the rows is not
 *
 * Deleting another agent's fixture rows mid-run would break *their* suite, and would be this
 * task reaching into another task's state to make its own tests pass. Supplying material does
 * neither: it is confined to this process's `process.env`, it touches no shared state, and it
 * **satisfies** the registry's invariant rather than weakening it — every referenced key is
 * present at boot, which is precisely what the check demands. Nothing about the control changes;
 * the missing input is provided.
 *
 * The material is random per run and never written down (R4). Rows encrypted under a foreign kid
 * during this suite would not be readable by its owning suite later — which is harmless here,
 * because this suite deletes every user it creates in `afterAll`, and because a fixture key's
 * whole lifetime is one test run anyway.
 */
import { randomBytes } from 'node:crypto';
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';

interface KeyRow {
  readonly kid: string;
  readonly key_ref: string | null;
}

/**
 * Provisions random material for every `encryption_keys` row whose `env:`-referenced variable is
 * absent. Call **before** `app.init()`/`app.listen()`, alongside `ensureEncryptionKeys`.
 *
 * Returns the variable names it filled, so a caller can log or clear them.
 */
export async function provideMissingKeyMaterial(sequelize: Sequelize): Promise<string[]> {
  const rows = await sequelize.query<KeyRow>(
    'SELECT kid, key_ref FROM reward_portal.encryption_keys',
    { type: QueryTypes.SELECT },
  );

  const filled: string[] = [];
  for (const row of rows) {
    if (row.key_ref === null || !row.key_ref.startsWith('env:')) continue;
    const name = row.key_ref.slice('env:'.length);
    if (name === '') continue;
    const existing = process.env[name];
    if (existing !== undefined && existing !== '') continue;
    process.env[name] = randomBytes(32).toString('base64');
    filled.push(name);
  }
  return filled;
}

/** Removes what {@link provideMissingKeyMaterial} added. */
export function clearProvidedKeyMaterial(names: readonly string[]): void {
  for (const name of names) delete process.env[name];
}
