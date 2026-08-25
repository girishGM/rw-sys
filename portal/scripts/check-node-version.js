#!/usr/bin/env node
/**
 * Fails fast on the wrong Node version, per 00-ARCHITECTURE.md gap G8: NestJS 11 and
 * Vite 5+ require Node >= 20. Runs as `preinstall` so `npm ci`/`npm install` never even
 * reaches a partially-installed state on Node 16.
 */
'use strict';

const REQUIRED_MAJOR = 20;
const current = process.versions.node;
const currentMajor = parseInt(current.split('.')[0], 10);

if (currentMajor !== REQUIRED_MAJOR) {
  console.error(
    `\n  ✗ Node ${REQUIRED_MAJOR} LTS required (found v${current}). Run: nvm install 20 && nvm use\n`,
  );
  process.exit(1);
}
