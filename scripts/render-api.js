'use strict';

/**
 * Tiny shared Render REST API client used by render-deploy.js and render-db-sync.js. No npm
 * dependency beyond Node's own https — this repo already leans on psql/curl directly elsewhere
 * (RENDER-DB-MIGRATION.md) rather than a Render SDK.
 */

const { execFileSync } = require('child_process');
const https = require('https');

function getApiKey() {
  if (process.env.RENDER_API_KEY) return process.env.RENDER_API_KEY.trim();
  try {
    const key = execFileSync(
      'security',
      ['find-generic-password', '-a', 'render-api', '-s', 'render-cli', '-w'],
      { encoding: 'utf8' },
    ).trim();
    if (key) return key;
  } catch {
    // fall through to the error below
  }
  throw new Error(
    'No Render API key. Set RENDER_API_KEY, or store one in Keychain: ' +
      'security add-generic-password -a "render-api" -s "render-cli" -w "<key>"',
  );
}

function request(apiKey, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = https.request(
      {
        hostname: 'api.render.com',
        path: urlPath,
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode >= 400) {
            reject(new Error(`Render API ${method} ${urlPath} -> ${res.statusCode}: ${data}`));
            return;
          }
          resolve(data ? JSON.parse(data) : null);
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function getPostgresConnectionInfo(apiKey, postgresId) {
  return request(apiKey, 'GET', `/v1/postgres/${postgresId}/connection-info`);
}

module.exports = { getApiKey, request, getPostgresConnectionInfo };
