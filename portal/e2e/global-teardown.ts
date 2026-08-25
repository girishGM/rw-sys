/**
 * T-050 — the mirror image of `global-setup.ts`: stop the back end and front end child
 * processes, then undo whichever of `global-setup.ts`'s two database strategies actually ran
 * (`state.dbStrategy` — stop-and-remove the Testcontainers container, or drop the ephemeral local
 * database added in retry 1/3, see `utils/localPostgres.ts`), and leave nothing running behind the
 * suite. Reads `.tmp/e2e-state.json` because this runs in a **separate process** from
 * `global-setup.ts` (the two share no in-memory state — `utils/state.ts`'s own header explains why
 * a file is used).
 */
import { execSync } from 'node:child_process';
import { readState } from './utils/state';
import { dropEphemeralDatabase, localSuperuserConnection } from './utils/localPostgres';

function killIfAlive(pid: number, name: string): void {
  if (pid === 0) return;
  try {
    process.kill(pid, 'SIGTERM');
    console.log(`[global-teardown] stopped ${name} (pid ${String(pid)})`);
  } catch (error) {
    // ESRCH = already gone, which is fine — everything else is worth knowing about but must not
    // stop the rest of teardown from running.
    console.warn(`[global-teardown] could not stop ${name} (pid ${String(pid)}): ${String(error)}`);
  }
}

export default async function globalTeardown(): Promise<void> {
  let state;
  try {
    state = readState();
  } catch (error) {
    console.warn(`[global-teardown] no state file found, nothing to tear down: ${String(error)}`);
    return;
  }

  killIfAlive(state.pids.backEnd, 'back-end');
  killIfAlive(state.pids.frontEnd, 'front-end');

  if (state.dbStrategy === 'local') {
    try {
      await dropEphemeralDatabase(localSuperuserConnection(), state.db.database);
      console.log(`[global-teardown] dropped ephemeral local database ${state.db.database}`);
    } catch (error) {
      console.warn(`[global-teardown] could not drop the ephemeral local database: ${String(error)}`);
    }
    return;
  }

  if (state.containerId === null) {
    console.warn('[global-teardown] dbStrategy was "container" but no containerId was recorded.');
    return;
  }

  try {
    execSync(`docker stop ${state.containerId}`, { stdio: 'ignore' });
    execSync(`docker rm ${state.containerId}`, { stdio: 'ignore' });
    console.log(`[global-teardown] stopped and removed Postgres container ${state.containerId}`);
  } catch (error) {
    console.warn(`[global-teardown] could not stop the Postgres container: ${String(error)}`);
  }
}
