#!/usr/bin/env node
'use strict';

/**
 * Starts (or reports on, or stops) every local dev service in this repo, keyed by the ONE port
 * each one always listens on in local dev — that port is the idempotency check: if something is
 * already listening there, this script leaves it alone instead of spawning a second copy on a
 * different port. See reward-system/CLAUDE.md and .claude/commands/run-services.md.
 *
 * Usage (from the repo root):
 *   node scripts/run-services.js [start|status|stop] [serviceId ...]
 *
 * `start` is the default action. With no serviceId filter, every registered service is targeted.
 * Logs and pidfiles land in .dev-run/ (gitignored) — one <id>.log / <id>.pid pair per service.
 */

const { spawn, spawnSync } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const RUN_DIR = path.join(ROOT, '.dev-run');
fs.mkdirSync(RUN_DIR, { recursive: true });

// Every `npm`/`npx` child this script spawns needs Node 20 ahead of the shell's v16 default —
// see CLAUDE.md's "Local environment" section. Harmless if this path doesn't exist (nvm not
// installed under this exact version on some other machine) — PATH just falls back untouched.
const NODE20_BIN = path.join(os.homedir(), '.nvm/versions/node/v20.20.2/bin');
if (fs.existsSync(NODE20_BIN)) {
  process.env.PATH = `${NODE20_BIN}:${process.env.PATH}`;
}

// ---------------------------------------------------------------------------------------------
// Service registry — add new services here as they're scaffolded. Nothing outside this array
// needs to change to add one.
//
//   id       short unique key — CLI filter arg, and the <id>.log/<id>.pid filename stem
//   name     human label for status output
//   cwd      path relative to the repo root
//   port     the ONE port this service always listens on in local dev (never reassigned) —
//            the single source of truth this script uses to decide "already running"
//   command / args   how to start it
//   env      extra env vars merged over process.env for the spawned process
//   url      dev URL printed in the summary
//   phase    1 = spawned immediately; 2 = spawned only after every id in `waitFor` is confirmed
//            listening (or times out) — use for services whose own startup code calls another
//            service and fails hard if it isn't up yet
//   waitFor  service ids (from this same array) that must be listening first
//   predeps  optional setup steps run synchronously before spawning (e.g. a docker-compose
//            dependency this service needs on its own fixed port)
// ---------------------------------------------------------------------------------------------
const SERVICES = [
  {
    id: 'portal-backend',
    name: 'Portal Back-end (NestJS API)',
    cwd: 'portal/back-end',
    port: 3001,
    command: 'npm',
    args: ['run', 'start:dev'],
    // portal/back-end/.env.development defaults PORT=3000, but portal/front-end's Vite proxy
    // and every other service's PORTAL_BASE_URL point at 3001 — documented, unfixed mismatch
    // (see CLAUDE.md / the dev-environment reference memory). This override is that workaround.
    env: { PORT: '3001' },
    url: 'http://localhost:3001',
    phase: 1,
  },
  {
    id: 'portal-frontend',
    name: 'Portal Front-end (Vite)',
    cwd: 'portal/front-end',
    port: 5173,
    command: 'npm',
    args: ['run', 'dev'],
    url: 'http://localhost:5173',
    phase: 1,
  },
  {
    id: 'test-app-frontend',
    name: 'Test App Front-end (Vite)',
    cwd: 'test-app/frontend',
    port: 5174,
    command: 'npm',
    args: ['run', 'dev'],
    url: 'http://localhost:5174',
    phase: 1,
  },
  {
    id: 'promo-code-service',
    name: 'Promo Code Service (NestJS)',
    cwd: 'promo-code-service',
    port: 3010,
    command: 'npm',
    args: ['run', 'start:dev'],
    url: 'http://localhost:3010',
    phase: 1,
    predeps: [
      // Local Kafka-API broker (Redpanda) this service needs on :9092 — docker-compose.yml's
      // own container name. `docker compose up -d` is idempotent, so this is safe to run even
      // when the container is already up.
      { type: 'docker-compose-up', cwd: 'promo-code-service', containerName: 'promo-code-service-redpanda' },
    ],
  },
  {
    id: 'test-app-tracking-service',
    name: 'Test App Tracking Service (Express)',
    cwd: 'test-app/tracking-service',
    port: 4001,
    command: 'npm',
    args: ['run', 'dev'],
    url: 'http://localhost:4001',
    phase: 2,
    // server.ts calls the portal (POST /api/v1/auth/login, GET /campaigns) during its own
    // startup seed step and throws if the portal isn't reachable yet — no retry loop — so this
    // must not be spawned until portal-backend is actually listening.
    waitFor: ['portal-backend'],
  },

  // --- Planned services — not yet scaffolded, see reward-system/CLAUDE.md. Uncomment and fill
  // in the real port/command as each one lands; nothing else in this file needs to change. ---
  // {
  //   id: 'realtime-activity-processing-service',
  //   name: 'Realtime Activity Processing Service',
  //   cwd: 'realtime-activity-processing-service',
  //   port: <TBD>,
  //   command: 'npm',
  //   args: ['run', 'start:dev'],
  //   url: 'http://localhost:<TBD>',
  //   phase: 2,
  //   waitFor: ['portal-backend'],
  // },
  // {
  //   id: 'reward-redemption-service',
  //   name: 'Reward Redemption Service',
  //   cwd: 'reward-redemption-service',
  //   port: <TBD>,
  //   command: 'npm',
  //   args: ['run', 'start:dev'],
  //   url: 'http://localhost:<TBD>',
  //   phase: 2,
  //   waitFor: ['portal-backend'],
  // },
  // {
  //   id: 'reward-tracking-service',
  //   name: 'Reward Tracking Service',
  //   cwd: 'reward-tracking-service',
  //   port: <TBD>,
  //   command: 'npm',
  //   args: ['run', 'start:dev'],
  //   url: 'http://localhost:<TBD>',
  //   phase: 2,
  //   waitFor: ['portal-backend'],
  // },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tryConnect(port, host, timeoutMs) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

// Some dev servers (Vite in particular) bind only to the IPv6 loopback (`::1`) when told to
// listen on "localhost", not the IPv4 one — a bare 127.0.0.1 probe reports them as down even
// though `lsof -iTCP:<port>` shows them listening. Try both loopback families.
async function isPortOpen(port, timeoutMs = 500) {
  const [v4, v6] = await Promise.all([
    tryConnect(port, '127.0.0.1', timeoutMs),
    tryConnect(port, '::1', timeoutMs),
  ]);
  return v4 || v6;
}

async function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortOpen(port)) return true;
    await sleep(1000);
  }
  return false;
}

function portOf(id) {
  const svc = SERVICES.find((s) => s.id === id);
  if (!svc) throw new Error(`run-services: unknown service id in waitFor: ${id}`);
  return svc.port;
}

function runPredeps(svc) {
  if (!svc.predeps) return;
  for (const dep of svc.predeps) {
    if (dep.type === 'docker-compose-up') {
      const running = spawnSync(
        'docker',
        ['ps', '--filter', `name=${dep.containerName}`, '--filter', 'status=running', '-q'],
        { encoding: 'utf8' },
      );
      if (running.status === 0 && running.stdout.trim() === '') {
        console.log(`  [predep] ${dep.containerName} not running — running docker compose up -d`);
        spawnSync('docker', ['compose', 'up', '-d'], { cwd: path.join(ROOT, dep.cwd), stdio: 'inherit' });
      } else if (running.status !== 0) {
        console.warn(`  [predep] could not check docker for ${dep.containerName} (is Docker running?) — continuing anyway`);
      }
    }
  }
}

function startService(svc) {
  runPredeps(svc);
  const logPath = path.join(RUN_DIR, `${svc.id}.log`);
  const pidPath = path.join(RUN_DIR, `${svc.id}.pid`);
  const logFd = fs.openSync(logPath, 'a');
  fs.writeSync(logFd, `\n=== run-services: starting ${svc.id} at ${new Date().toISOString()} ===\n`);
  const child = spawn(svc.command, svc.args, {
    cwd: path.join(ROOT, svc.cwd),
    env: { ...process.env, ...(svc.env || {}) },
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  fs.writeFileSync(pidPath, String(child.pid));
  child.unref();
  return child.pid;
}

function relLog(svc) {
  return path.relative(ROOT, path.join(RUN_DIR, `${svc.id}.log`));
}

async function startServices(targets) {
  const results = new Map();

  for (const phase of [1, 2]) {
    const phaseServices = targets.filter((s) => (s.phase || 1) === phase);
    if (phaseServices.length === 0) continue;

    for (const svc of phaseServices) {
      if (svc.waitFor) {
        for (const depId of svc.waitFor) {
          if (await isPortOpen(portOf(depId))) continue;
          console.log(`[wait] ${svc.name} needs ${depId} on :${portOf(depId)} — waiting up to 60s...`);
          const ok = await waitForPort(portOf(depId), 60000);
          if (!ok) console.warn(`  [warn] ${depId} did not come up in time — starting ${svc.id} anyway, it may fail`);
        }
      }

      if (await isPortOpen(svc.port)) {
        results.set(svc.id, { status: 'already-running' });
        console.log(`[skip]  ${svc.name} — already listening on :${svc.port}`);
        continue;
      }

      console.log(`[start] ${svc.name} — cwd ${svc.cwd}, port ${svc.port}, log ${relLog(svc)}`);
      const pid = startService(svc);
      results.set(svc.id, { status: 'starting', pid });
    }
  }

  const stillStarting = targets.some((s) => results.get(s.id)?.status === 'starting');
  if (stillStarting) {
    console.log('\nWaiting for freshly started services to open their port (up to 90s)...');
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      let anyStarting = false;
      for (const svc of targets) {
        const r = results.get(svc.id);
        if (r && r.status === 'starting') {
          if (await isPortOpen(svc.port)) {
            r.status = 'up';
          } else {
            anyStarting = true;
          }
        }
      }
      if (!anyStarting) break;
      await sleep(1500);
    }
  }

  printSummary(targets, results);
}

function printSummary(targets, results) {
  console.log('\n--- run-services summary ---');
  for (const svc of targets) {
    const r = results.get(svc.id) || { status: 'unknown' };
    const label =
      r.status === 'already-running'
        ? 'already running'
        : r.status === 'up'
          ? `started (pid ${r.pid})`
          : r.status === 'starting'
            ? `still starting — check ${relLog(svc)} (pid ${r.pid})`
            : r.status;
    console.log(`  ${svc.name.padEnd(38)} :${String(svc.port).padEnd(6)} ${label}  ${svc.url}`);
  }
}

async function printStatus(targets) {
  console.log('--- service status ---');
  for (const svc of targets) {
    const up = await isPortOpen(svc.port);
    console.log(`  ${svc.name.padEnd(38)} :${String(svc.port).padEnd(6)} ${up ? 'RUNNING' : 'not running'}  ${svc.url}`);
  }
}

function stopServices(targets) {
  for (const svc of targets) {
    const res = spawnSync('lsof', ['-ti', `:${svc.port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
    const pids = (res.stdout || '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    if (pids.length === 0) {
      console.log(`[skip]    ${svc.name} — nothing listening on :${svc.port}`);
      continue;
    }
    spawnSync('kill', pids);
    console.log(`[stopped] ${svc.name} — killed pid(s) ${pids.join(', ')} on :${svc.port}`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const knownActions = ['start', 'status', 'stop'];
  const action = knownActions.includes(argv[0]) ? argv[0] : 'start';
  const filterIds = knownActions.includes(argv[0]) ? argv.slice(1) : argv;

  let targets = SERVICES;
  if (filterIds.length > 0) {
    const unknown = filterIds.filter((id) => !SERVICES.some((s) => s.id === id));
    if (unknown.length > 0) {
      console.error(`Unknown service id(s): ${unknown.join(', ')}`);
      console.error(`Known ids: ${SERVICES.map((s) => s.id).join(', ')}`);
      process.exit(1);
    }
    targets = SERVICES.filter((s) => filterIds.includes(s.id));
  }

  if (action === 'status') return printStatus(targets);
  if (action === 'stop') return stopServices(targets);
  return startServices(targets);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
