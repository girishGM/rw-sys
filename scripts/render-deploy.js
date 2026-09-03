#!/usr/bin/env node
'use strict';

/**
 * Deploys one, several, or all of this repo's Render services from a chosen branch.
 * See reward-system/CLAUDE.md and .claude/commands/deploy-render.md.
 *
 * Usage (from the repo root):
 *   node scripts/render-deploy.js --service=<id|id1,id2|all> --branch=<branch> [--no-wait]
 *   node scripts/render-deploy.js --status --service=<id|all>
 *
 * Every service this repo currently deploys to Render is registered in
 * scripts/render-registry.json (id, human name, Render's own serviceId) — add a new service
 * there, nothing else needs to change here.
 *
 * Auth: needs a Render API key. Reads RENDER_API_KEY from the environment first; if unset,
 * falls back to this machine's Keychain entry (the same one promo-code-service/CLAUDE.md's own
 * "Retrieving the Render API key" section documents): `security find-generic-password
 * -a "render-api" -s "render-cli" -w`. Ask the human operator for a Render dashboard → Account
 * Settings → API Keys value if neither is available.
 *
 * What "deploy" does per selected service, via Render's REST API (never git push — these
 * services were created directly via the API, not a Blueprint sync, so a Blueprint re-sync is
 * not the deploy mechanism here; see promo-code-service/CLAUDE.md's "Render deployment" section):
 *   1. If the service's currently configured branch differs from --branch, PATCH it
 *      (`{"branch": "<branch>"}`) so future auto-deploys (and this one) come from the right ref.
 *   2. POST /services/{id}/deploys with an empty body — Render deploys the latest commit on
 *      the now-configured branch (see api-docs.render.com/reference/create-deploy).
 *   3. Unless --no-wait, poll GET /services/{id}/deploys/{deployId} every 10s until the status
 *      is a terminal one (live / build_failed / update_failed / canceled / deactivated), up to
 *      --timeout seconds (default 600).
 */

const path = require('path');
const { getApiKey, request: renderApi } = require('./render-api');

const ROOT = path.resolve(__dirname, '..');
const REGISTRY = require(path.join(ROOT, 'scripts', 'render-registry.json'));

function parseArgs(argv) {
  const out = { service: null, branch: 'main', wait: true, status: false, timeout: 600 };
  for (const arg of argv) {
    if (arg === '--status') out.status = true;
    else if (arg === '--no-wait') out.wait = false;
    else if (arg.startsWith('--service=')) out.service = arg.slice('--service='.length);
    else if (arg.startsWith('--branch=')) out.branch = arg.slice('--branch='.length);
    else if (arg.startsWith('--timeout=')) out.timeout = Number(arg.slice('--timeout='.length));
  }
  return out;
}

function resolveServices(selector) {
  if (!selector || selector === 'all') return REGISTRY.services;
  const ids = new Set(selector.split(',').map((s) => s.trim()));
  const known = new Set(REGISTRY.services.map((s) => s.id));
  const unknown = [...ids].filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown service id(s): ${unknown.join(', ')}. Known: ${[...known].join(', ')}`,
    );
  }
  return REGISTRY.services.filter((s) => ids.has(s.id));
}

const TERMINAL_STATUSES = new Set(['live', 'build_failed', 'update_failed', 'canceled', 'deactivated']);

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function deployOne(apiKey, service, branch, wait, timeoutSeconds) {
  const current = await renderApi(apiKey, 'GET', `/v1/services/${service.renderServiceId}`);
  if (current.branch !== branch) {
    await renderApi(apiKey, 'PATCH', `/v1/services/${service.renderServiceId}`, { branch });
    console.log(`  [${service.id}] branch: ${current.branch} -> ${branch}`);
  } else {
    console.log(`  [${service.id}] branch already ${branch}`);
  }

  const deploy = await renderApi(apiKey, 'POST', `/v1/services/${service.renderServiceId}/deploys`, {});
  console.log(`  [${service.id}] deploy triggered: ${deploy.id}`);

  if (!wait) return { service: service.id, deployId: deploy.id, status: deploy.status };

  const deadline = Date.now() + timeoutSeconds * 1000;
  let status = deploy.status;
  while (!TERMINAL_STATUSES.has(status) && Date.now() < deadline) {
    await sleep(10000);
    const check = await renderApi(
      apiKey,
      'GET',
      `/v1/services/${service.renderServiceId}/deploys/${deploy.id}`,
    );
    status = check.status;
    console.log(`  [${service.id}] ... ${status}`);
  }
  return { service: service.id, deployId: deploy.id, status };
}

async function reportStatus(apiKey, services) {
  for (const service of services) {
    const detail = await renderApi(apiKey, 'GET', `/v1/services/${service.renderServiceId}`);
    const deploys = await renderApi(
      apiKey,
      'GET',
      `/v1/services/${service.renderServiceId}/deploys?limit=1`,
    );
    const last = deploys[0] && (deploys[0].deploy || deploys[0]);
    console.log(
      `${service.id.padEnd(28)} branch=${(detail.branch || '?').padEnd(16)} ` +
        `lastDeploy=${(last && last.status) || 'unknown'} url=${
          (detail.serviceDetails && detail.serviceDetails.url) || ''
        }`,
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = getApiKey();
  const services = resolveServices(args.service);

  if (args.status) {
    await reportStatus(apiKey, services);
    return;
  }

  console.log(`Deploying ${services.map((s) => s.id).join(', ')} from branch "${args.branch}"...`);
  const results = [];
  for (const service of services) {
    results.push(await deployOne(apiKey, service, args.branch, args.wait, args.timeout));
  }

  console.log('\n--- render-deploy summary ---');
  let anyFailed = false;
  for (const r of results) {
    console.log(`${r.service.padEnd(28)} ${r.status}`);
    if (r.status && r.status !== 'live' && r.status !== 'build_in_progress' && r.status !== 'update_in_progress') {
      anyFailed = true;
    }
  }
  if (anyFailed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
