/**
 * T-048 — TC-4 and Verification step 2, as a test rather than as a grep somebody remembers to run.
 *
 * > **Verification step 2:** `grep -rniE "insert into|createQueryBuilder|sequelize.query"
 * > src/modules/campaign-agent` → **zero matches**
 *
 * > **TC-4:** search the module for SQL generation → **zero** — no `INSERT`, no query building
 *
 * 10-AI-CAMPAIGN-AGENT.md §1 deletes `sql-generator.tool.ts`, `sql-executor.tool.ts` and
 * `statement-firewall.ts` from the portal's copy of the agent. A grep proves that today; this file
 * proves it on every run, including the run after somebody adds a "quick raw query for
 * performance". That is the difference between a verification step and a control.
 *
 * ### The one documented exception, and why it is narrow enough to name
 *
 * `agent-session.repository.ts` uses parameterised SQL against **`reward_portal.agent_sessions`**
 * and **`agent_session_events`** — the agent's own two tables — for the reason its header sets out
 * at length (no model exists, and the two files needed to give it one belong to T-003/T-013). It
 * touches no campaign table, no `reward_config` table, and binds every value through
 * `replacements`.
 *
 * So the assertion is not "no SQL anywhere", which would be false; it is the two things that
 * actually matter and that TC-4/TC-5 are about:
 *
 *  1. **No campaign, rule, reward, merchant or tenant table is named anywhere in the module.** The
 *     agent has no way to reach campaign data except through `CampaignsService` and friends.
 *  2. **No string interpolation into SQL, anywhere.** Every statement is a template-free string
 *     literal with `:named` bindings.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MODULE_ROOT = join(__dirname, '..', '..', 'src', 'modules', 'campaign-agent');

/** The one file allowed to contain SQL at all. See this file's header. */
const SESSION_REPOSITORY = 'agent-session.repository.ts';

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
  });
}

const files = sourceFiles(MODULE_ROOT).map((path) => ({
  path,
  name: path.slice(MODULE_ROOT.length + 1),
  source: readFileSync(path, 'utf8'),
}));

/** Comments and doc blocks discuss SQL by name; only executable text is scanned. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/^\s*\*.*$/gm, '');
}

describe('the module is there at all', () => {
  it('has source files to scan, so a passing scan is not a scan of nothing', () => {
    expect(files.length).toBeGreaterThan(10);
    expect(files.map((file) => file.name)).toContain('portal-api.client.ts');
  });
});

describe('the three deleted files are not here — 10-AI-CAMPAIGN-AGENT §1', () => {
  it.each(['sql-generator.tool.ts', 'sql-executor.tool.ts', 'statement-firewall.ts'])(
    '%s does not exist',
    (name) => {
      expect(files.map((file) => file.name.split('/').pop())).not.toContain(name);
    },
  );
});

describe('no SQL generation anywhere but the session repository — TC-4', () => {
  const others = files.filter((file) => !file.name.endsWith(SESSION_REPOSITORY));

  it.each([
    ['INSERT INTO', /\binsert\s+into\b/i],
    ['UPDATE … SET', /\bupdate\s+\w+\s+set\b/i],
    ['DELETE FROM', /\bdelete\s+from\b/i],
    ['SELECT … FROM', /\bselect\s+[\s\S]{0,80}?\bfrom\b/i],
    ['DROP/ALTER/TRUNCATE', /\b(drop|alter|truncate)\s+table\b/i],
    ['createQueryBuilder', /createQueryBuilder/],
    ['sequelize.query', /sequelize\s*\.\s*query/],
    ['QueryTypes', /QueryTypes/],
  ])('contains no %s', (_label, pattern) => {
    const offenders = others.filter((file) => pattern.test(code(file.source)));
    expect(offenders.map((file) => file.name)).toEqual([]);
  });

  it('never names a campaign, rule, reward, merchant or tenant table', () => {
    // The point of TC-5: there is no DB write path out of this module, because there is no table
    // name in it to write to. Scanned by *physical* table name (snake_case, as it appears in SQL)
    // rather than by model class name — `Merchant` and `RewardPolicy` are Sequelize models passed
    // to `ScopedRepository`, which is the sanctioned path and must keep working.
    const tables = [
      'tenant_campaigns',
      'campaign_merchants',
      'campaign_caps',
      'tenant_campaign_trackers',
      'tracker_components',
      'tracker_component_rules',
      'tracker_tracker_components',
      'reward_policies',
      'reward_systems',
      'reward_campaign_assignments',
      'reward_component_assignments',
      'reward_tracker_assignments',
      'rule_master',
      'rule_versions',
      'rule_country_assignments',
      'merchant_activities',
      'tenant_budget_ceilings',
      'portal_campaign_audit_trail',
      'portal_approval_requests',
    ];
    for (const table of tables) {
      const offenders = files.filter((file) => code(file.source).includes(table));
      expect({ table, offenders: offenders.map((file) => file.name) }).toEqual({
        table,
        offenders: [],
      });
    }
  });

  it('never names the reward_config schema at all — R1’s surface is not reachable from here', () => {
    const offenders = files.filter((file) => code(file.source).includes('reward_config'));
    expect(offenders.map((file) => file.name)).toEqual([]);
  });
});

describe('the one file that does hold SQL holds only what it claims', () => {
  const repository = files.find((file) => file.name.endsWith(SESSION_REPOSITORY));

  it('exists', () => {
    expect(repository).toBeDefined();
  });

  it('names only the agent’s own two tables', () => {
    const source = code(repository?.source ?? '');
    const tableNames = [...source.matchAll(/reward_portal\.(\w+)/g)].map((match) => match[1]);
    expect([...new Set(tableNames)].sort()).toEqual(['agent_session_events', 'agent_sessions']);
  });

  it('interpolates no value into SQL text — every value is a :named binding', () => {
    const source = code(repository?.source ?? '');
    // A template placeholder inside a SQL string is how an injection gets written by accident.
    // `${OWNED}` and `${SESSION_COLUMNS}` are module constants, never request data, so they are
    // the two allowed substitutions and are named explicitly rather than pattern-matched.
    const placeholders = [...source.matchAll(/\$\{(\w+)\}/g)].map((match) => match[1]);
    expect([...new Set(placeholders)].sort()).toEqual(['OWNED', 'SESSION_COLUMNS']);
  });

  it('filters every statement on the owner, from the verified scope', () => {
    const source = code(repository?.source ?? '');
    expect(source).toContain("ScopeContext.require('agent_sessions')");
    expect(source).toContain('portal_user_id = :userId AND tenant_id = :tenantId');
  });
});

describe('there is no direct database handle outside the session repository', () => {
  it('nothing else injects SEQUELIZE', () => {
    const offenders = files
      .filter((file) => !file.name.endsWith(SESSION_REPOSITORY))
      .filter((file) => code(file.source).includes('SEQUELIZE'));
    expect(offenders.map((file) => file.name)).toEqual([]);
  });

  it('nothing opens a transaction of its own around a campaign write', () => {
    const offenders = files.filter((file) => /\.\s*transaction\s*\(/.test(code(file.source)));
    expect(offenders.map((file) => file.name)).toEqual([]);
  });
});

describe('the agent never submits — TC-16', () => {
  it('no file calls submit on the campaigns service', () => {
    const offenders = files.filter((file) => /\bsubmit\s*\(/.test(code(file.source)));
    expect(offenders.map((file) => file.name)).toEqual([]);
  });

  it('portal-api.client.ts does not even import a submit path', () => {
    const client = files.find((file) => file.name === 'portal-api.client.ts');
    expect(code(client?.source ?? '')).not.toMatch(/submit/i);
  });
});
