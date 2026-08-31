#!/usr/bin/env node
/**
 * generate-er-diagram.js — renders the CURRENT reward_portal schema (read live from Postgres
 * via information_schema) as a single self-contained HTML page: one card per table, columns,
 * primary keys, and every foreign-key relationship.
 *
 * This is a read-only report, not a design tool — it draws whatever migrations have actually
 * produced, so it can never drift from the real schema the way a hand-maintained diagram would.
 * Called by export-db-package.sh; not meant to be run standalone except for debugging.
 *
 * Usage: node generate-er-diagram.js <output-html-path>
 * Reads connection details from the environment: DB_HOST, DB_PORT, DB_NAME,
 * DB_MIGRATION_USERNAME, DB_MIGRATION_PASSWORD.
 *
 * Deliberately uses the migration role, not the least-privilege app role: confirmed live
 * (2026-08-29) that `reward_app` cannot see FK metadata through
 * information_schema.key_column_usage/constraint_column_usage at all — those views are
 * privilege-filtered per PostgreSQL's own information_schema semantics, and reward_app's grants
 * (already a known gap once before — see T-091) aren't broad enough for that introspection,
 * even though the FKs themselves are real and enforced (`pg_constraint` shows 30 of them). Using
 * DB_APP_* here silently produced a diagram with a real table list but zero FK lines — this
 * script's own first real run caught that before it shipped.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const SCHEMA = 'reward_portal';

function die(msg) {
  console.error(`\n  ✗ ${msg}\n`);
  process.exit(1);
}

async function main() {
  const outPath = process.argv[2];
  if (!outPath) die('Usage: node generate-er-diagram.js <output-html-path>');

  const { DB_HOST, DB_PORT, DB_NAME, DB_MIGRATION_USERNAME, DB_MIGRATION_PASSWORD } = process.env;
  for (const [k, v] of Object.entries({ DB_HOST, DB_PORT, DB_NAME, DB_MIGRATION_USERNAME, DB_MIGRATION_PASSWORD })) {
    if (!v) die(`${k} is not set — source portal/back-end/.env.development first`);
  }

  const client = new Client({
    host: DB_HOST,
    port: Number(DB_PORT),
    database: DB_NAME,
    user: DB_MIGRATION_USERNAME,
    password: DB_MIGRATION_PASSWORD,
  });
  await client.connect();

  try {
    const tablesRes = await client.query(
      `select table_name from information_schema.tables
       where table_schema = $1 and table_type = 'BASE TABLE'
       order by table_name`,
      [SCHEMA]
    );
    const tables = tablesRes.rows.map((r) => r.table_name);
    if (tables.length === 0) die(`No tables found in schema "${SCHEMA}" — has db:migrate run?`);

    const columnsRes = await client.query(
      `select table_name, column_name, data_type, is_nullable, column_default
       from information_schema.columns
       where table_schema = $1
       order by table_name, ordinal_position`,
      [SCHEMA]
    );

    const pkRes = await client.query(
      `select tc.table_name, kcu.column_name
       from information_schema.table_constraints tc
       join information_schema.key_column_usage kcu
         on tc.constraint_name = kcu.constraint_name and tc.table_schema = kcu.table_schema
       where tc.table_schema = $1 and tc.constraint_type = 'PRIMARY KEY'
       order by tc.table_name, kcu.ordinal_position`,
      [SCHEMA]
    );

    const fkRes = await client.query(
      `select
         tc.table_name as from_table, kcu.column_name as from_column,
         ccu.table_name as to_table, ccu.column_name as to_column,
         tc.constraint_name
       from information_schema.table_constraints tc
       join information_schema.key_column_usage kcu
         on tc.constraint_name = kcu.constraint_name and tc.table_schema = kcu.table_schema
       join information_schema.constraint_column_usage ccu
         on tc.constraint_name = ccu.constraint_name and tc.table_schema = ccu.table_schema
       where tc.table_schema = $1 and tc.constraint_type = 'FOREIGN KEY'
       order by tc.table_name, kcu.column_name`,
      [SCHEMA]
    );

    const columnsByTable = {};
    for (const row of columnsRes.rows) {
      (columnsByTable[row.table_name] ||= []).push(row);
    }
    const pkByTable = {};
    for (const row of pkRes.rows) {
      (pkByTable[row.table_name] ||= new Set()).add(row.column_name);
    }

    const html = renderHtml({ tables, columnsByTable, pkByTable, fks: fkRes.rows, schema: SCHEMA });
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, html);
    console.log(`  ✓ ${tables.length} tables, ${fkRes.rows.length} foreign keys -> ${outPath}`);
  } finally {
    await client.end();
  }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderHtml({ tables, columnsByTable, pkByTable, fks, schema }) {
  const generatedAt = new Date().toISOString();
  const fksByFromTable = {};
  for (const fk of fks) (fksByFromTable[fk.from_table] ||= []).push(fk);

  const cards = tables
    .map((table) => {
      const cols = columnsByTable[table] || [];
      const pks = pkByTable[table] || new Set();
      const tableFks = fksByFromTable[table] || [];
      const rows = cols
        .map((c) => {
          const isPk = pks.has(c.column_name);
          const fk = tableFks.find((f) => f.from_column === c.column_name);
          const badges = [
            isPk ? '<span class="badge pk">PK</span>' : '',
            fk ? `<span class="badge fk">FK &rarr; ${esc(fk.to_table)}.${esc(fk.to_column)}</span>` : '',
          ]
            .filter(Boolean)
            .join(' ');
          return `<tr><td class="col-name">${esc(c.column_name)}</td><td class="col-type">${esc(c.data_type)}</td><td class="col-null">${c.is_nullable === 'NO' ? 'not null' : ''}</td><td class="col-badges">${badges}</td></tr>`;
        })
        .join('\n');
      return `<section class="table-card" id="t-${esc(table)}">
  <h2>${esc(table)}</h2>
  <table><tbody>${rows}</tbody></table>
</section>`;
    })
    .join('\n');

  const fkList = fks
    .map(
      (fk) =>
        `<li><code>${esc(fk.from_table)}.${esc(fk.from_column)}</code> &rarr; <code>${esc(fk.to_table)}.${esc(fk.to_column)}</code></li>`
    )
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>reward_portal — ER diagram (generated)</title>
<style>
  :root {
    --bg: #f5f8f4; --surface: #ffffff; --border: #d7e3d3; --text: #17241a;
    --text-dim: #52604c; --accent: #2f7d4f; --pk: #2f7d4f; --fk: #386a86;
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px 40px 80px; background: var(--bg); color: var(--text);
    font: 14px/1.5 -apple-system, "Segoe UI", Roboto, sans-serif; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .meta { color: var(--text-dim); font-size: 13px; margin-bottom: 28px; }
  .meta code { background: var(--surface); border: 1px solid var(--border); border-radius: 4px; padding: 1px 5px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px; }
  .table-card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px;
    padding: 14px 16px; }
  .table-card h2 { font-size: 15px; margin: 0 0 8px; font-family: ui-monospace, Menlo, monospace; color: var(--accent); }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  td { padding: 3px 4px; border-bottom: 1px solid var(--border); vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  .col-name { font-family: ui-monospace, Menlo, monospace; }
  .col-type { color: var(--text-dim); }
  .col-null { color: var(--text-dim); font-size: 11px; white-space: nowrap; }
  .badge { display: inline-block; font-size: 10px; font-weight: 700; border-radius: 999px;
    padding: 1px 7px; margin-left: 4px; white-space: nowrap; }
  .badge.pk { background: #dcefe1; color: var(--pk); }
  .badge.fk { background: #dbe9f0; color: var(--fk); }
  .fk-section { margin-top: 40px; }
  .fk-section h2 { font-size: 16px; }
  .fk-section ul { columns: 3; column-gap: 24px; padding-left: 18px; }
  .fk-section code { font-size: 12px; }
  @media (max-width: 900px) { .fk-section ul { columns: 1; } }
</style>
</head>
<body>
<h1>reward_portal — ER diagram</h1>
<p class="meta">GENERATED — do not hand-edit. Source of truth is
<code>portal/back-end/src/database/migrations/</code>. Regenerate with
<code>npm run db:export-package</code> from <code>portal/</code>. Schema <code>${esc(schema)}</code>,
${tables.length} tables, ${fks.length} foreign keys, generated ${esc(generatedAt)}.</p>
<div class="grid">
${cards}
</div>
<section class="fk-section">
  <h2>Foreign keys (${fks.length})</h2>
  <ul>${fkList}</ul>
</section>
</body>
</html>
`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
