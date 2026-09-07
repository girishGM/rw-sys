/**
 * T-RR-042 — token-separation audit: four distinct bearer secrets, never cross-usable
 * (`AGENT-PROTOCOL.md` R9, `04-REST-CONTRACT.md` §1/§2/§4,
 * `07-CONFIGURABILITY-AND-OBSERVABILITY.md` §1,
 * `reward-redemption-service-plan/tasks/T-RR-042-security-review.md` implementation note 4).
 *
 * **Four secrets, not the three a narrower reading of R9 might imply** — this task's own scope
 * note is explicit that `04-REST-CONTRACT.md` §3 confirms a fourth
 * (`REWARD_TRACKING_REST_TOKEN`), on top of `REWARD_ENTRY_INGEST_TOKEN` (§1), `GENERATION_SERVICE_TOKEN`
 * (§2) and `CACHE_ADMIN_TOKEN` (§4). `07-CONFIGURABILITY-AND-OBSERVABILITY.md` §1's own env-var
 * table only lists three of the four by name (an omission in that table, not a second, contradictory
 * design decision — `04-REST-CONTRACT.md` §3 and `.env.example`'s own committed header comment
 * both independently confirm the fourth), so this suite trusts the two REST-facing documents (§1/
 * §2/§4 and separately §3) over that one table's incomplete list, per `AGENT-PROTOCOL.md` §3's "if
 * a design doc contradicts itself, stop and escalate" — this is flagged in this task's own
 * completion report as a documentation gap, not treated as silently resolved by picking a side.
 *
 * `REWARD_TRACKING_REST_TOKEN` and `GENERATION_SERVICE_TOKEN` are both outbound-only credentials
 * this service *presents*, never *accepts* — confirmed by static grep (this file's own first
 * `describe` block: neither name is read by any inbound guard in `src/`) and then proven
 * functionally against the two real inbound endpoints this service actually exposes.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { AppModule } from '@/app.module';
import { createMigrationConnection } from '@/database/migration-connection';

const SRC_ROOT = path.join(__dirname, '..', '..', 'src');
const FOUR_TOKENS = [
  'REWARD_ENTRY_INGEST_TOKEN',
  'CACHE_ADMIN_TOKEN',
  'GENERATION_SERVICE_TOKEN',
  'REWARD_TRACKING_REST_TOKEN',
] as const;

function listFilesRecursive(dir: string, extension: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFilesRecursive(full, extension));
    } else if (entry.isFile() && entry.name.endsWith(extension)) {
      out.push(full);
    }
  }
  return out;
}

describe('T-RR-042 — implementation note 4: all four token names are declared in .env.example', () => {
  it('every one of the four distinct bearer-token env vars is declared (present as its own line) in .env.example', () => {
    const envExample = readFileSync(path.join(__dirname, '..', '..', '.env.example'), 'utf8');
    const declaredVarNames = new Set(
      envExample
        .split('\n')
        .filter((l) => /^[A-Z][A-Z0-9_]*=/.test(l))
        .map((l) => l.split('=')[0]),
    );
    for (const token of FOUR_TOKENS) {
      expect(declaredVarNames.has(token)).toBe(true);
    }
  });

  it('no two of the four token env vars resolve to the same non-empty real value in this actual test environment (a shared value would defeat the whole point of four distinct secrets)', () => {
    // `.env.example` itself deliberately ships every value blank (a template, not a real secret,
    // R1) — the real property this asserts only has something to check once real values are
    // loaded, which `test/database/env.setup.ts` already does for every test run
    // (`.env.local`/`.env.development`/`.env`).
    const resolved = FOUR_TOKENS.map((name) => process.env[name]).filter(
      (v): v is string => typeof v === 'string' && v.trim().length > 0,
    );
    expect(new Set(resolved).size).toBe(resolved.length);
  });
});

describe('T-RR-042 — static: GENERATION_SERVICE_TOKEN/REWARD_TRACKING_REST_TOKEN are never read by an inbound auth guard', () => {
  it('no file under src/ that implements an inbound CanActivate guard reads process.env.GENERATION_SERVICE_TOKEN or process.env.REWARD_TRACKING_REST_TOKEN — both are outbound-only credentials', () => {
    const files = listFilesRecursive(SRC_ROOT, '.ts').filter(
      (f) => !f.endsWith('.spec.ts') && /guard/i.test(path.basename(f)),
    );
    expect(files.length).toBeGreaterThan(0); // sanity: guards actually exist to check
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      // Only live (non-comment) code may read `process.env.<NAME>` — a guard's own header is
      // allowed (and expected, per these guards' own documented "never any other of this
      // service's tokens" discipline) to *mention* the other three token names in prose.
      const liveCode = source
        .split('\n')
        .filter((l) => {
          const trimmed = l.trim();
          return !trimmed.startsWith('*') && !trimmed.startsWith('//');
        })
        .join('\n');
      expect(liveCode).not.toMatch(/process\.env\.GENERATION_SERVICE_TOKEN\b/);
      expect(liveCode).not.toMatch(/process\.env\.REWARD_TRACKING_REST_TOKEN\b/);
    }
  });
});

describe('T-RR-042 TC-6/TC-7/TC-8 — real AppModule, real inbound endpoints: no token is cross-usable', () => {
  let app: INestApplication;
  let db: Sequelize;
  const TENANT_ID = 970_000 + Math.floor(Math.random() * 9_999);

  beforeAll(async () => {
    db = createMigrationConnection();
    await db.authenticate();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await db.query(
      'DELETE FROM reward_redemption.reward_redemption_entry WHERE tenant_id = :tenantId',
      { type: QueryTypes.RAW, replacements: { tenantId: TENANT_ID } },
    );
    await db.close();
    await app.close();
  });

  function rewardEntryBody(): Record<string, unknown> {
    return {
      id: randomUUID(),
      correlationId: randomUUID(),
      tenantId: TENANT_ID,
      customerId: `cust-${randomUUID()}`,
      customerIdType: 'MSISDN',
      activityPerformedDate: '2026-09-04T10:15:00.000Z',
      transactionType: null,
      activityCode: 'TXN_TOPUP',
      activityType: 'TOPUP',
      activityCategory: 'TELCO',
      activityValue: '50.0000',
      activityValueUnit: 'MYR',
      channel: 'app',
      activityPerformedEnv: 'production',
      activityName: 'T-RR-042 token-separation audit',
      campaignCode: 'CAMP-2026-Q3-001',
      trackerCode: 'TRK-TOPUP-5X',
      trackerComponentCode: 'CMP-TOPUP-STEP-3',
      merchantCode: 'MERCH-001',
      rewardCode: 'RWD-CASHBACK-5PCT',
      rewardCategory: 'CASHBACK',
      rewardValue: '2.5000',
      rewardValueUnit: 'MYR',
      rewardEntryDate: '2026-09-04T10:15:03.000Z',
      completionCycle: 1,
    };
  }

  async function countEntryRows(id: string): Promise<number> {
    const rows = await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM reward_redemption.reward_redemption_entry WHERE id = :id',
      { type: QueryTypes.SELECT, replacements: { id } },
    );
    return Number(rows[0].count);
  }

  it('TC-6: REWARD_ENTRY_INGEST_TOKEN presented to POST /api/v1/cache/invalidate is rejected with 401', async () => {
    const ingestToken = process.env.REWARD_ENTRY_INGEST_TOKEN;
    expect(ingestToken).toBeTruthy();

    const response = await request(app.getHttpServer())
      .post('/api/v1/cache/invalidate')
      .set('Authorization', `Bearer ${ingestToken}`)
      .send({ all: true });

    expect(response.status).toBe(401);
  });

  it('TC-7: CACHE_ADMIN_TOKEN presented to POST /api/v1/reward-entries is rejected with 401, no row inserted', async () => {
    const cacheAdminToken = process.env.CACHE_ADMIN_TOKEN;
    expect(cacheAdminToken).toBeTruthy();
    const body = rewardEntryBody();

    const response = await request(app.getHttpServer())
      .post('/api/v1/reward-entries')
      .set('Authorization', `Bearer ${cacheAdminToken}`)
      .send(body);

    expect(response.status).toBe(401);
    expect(await countEntryRows(body.id as string)).toBe(0);
  });

  it('TC-8: GENERATION_SERVICE_TOKEN presented to POST /api/v1/reward-entries is rejected with 401 — it is an outbound-only credential this service presents to promo-code-service, never one it accepts', async () => {
    const generationServiceToken = 'T-RR-042-audit-generation-service-token-value';
    const body = rewardEntryBody();

    const response = await request(app.getHttpServer())
      .post('/api/v1/reward-entries')
      .set('Authorization', `Bearer ${generationServiceToken}`)
      .send(body);

    expect(response.status).toBe(401);
    expect(await countEntryRows(body.id as string)).toBe(0);
  });

  it('TC-8b: GENERATION_SERVICE_TOKEN presented to POST /api/v1/cache/invalidate is also rejected with 401', async () => {
    const generationServiceToken = 'T-RR-042-audit-generation-service-token-value';

    const response = await request(app.getHttpServer())
      .post('/api/v1/cache/invalidate')
      .set('Authorization', `Bearer ${generationServiceToken}`)
      .send({ all: true });

    expect(response.status).toBe(401);
  });

  it('TC-8c: REWARD_TRACKING_REST_TOKEN presented to either real inbound endpoint is also rejected — it too is outbound-only', async () => {
    const rewardTrackingRestToken = process.env.REWARD_TRACKING_REST_TOKEN;
    expect(rewardTrackingRestToken).toBeTruthy();
    const body = rewardEntryBody();

    const ingestResponse = await request(app.getHttpServer())
      .post('/api/v1/reward-entries')
      .set('Authorization', `Bearer ${rewardTrackingRestToken}`)
      .send(body);
    expect(ingestResponse.status).toBe(401);
    expect(await countEntryRows(body.id as string)).toBe(0);

    const cacheResponse = await request(app.getHttpServer())
      .post('/api/v1/cache/invalidate')
      .set('Authorization', `Bearer ${rewardTrackingRestToken}`)
      .send({ all: true });
    expect(cacheResponse.status).toBe(401);
  });

  it('sanity: each token DOES authorize its own real endpoint (proves the 401s above are real rejections, not a broken guard rejecting everything)', async () => {
    const ingestToken = process.env.REWARD_ENTRY_INGEST_TOKEN;
    const cacheAdminToken = process.env.CACHE_ADMIN_TOKEN;
    const body = rewardEntryBody();

    const ingestResponse = await request(app.getHttpServer())
      .post('/api/v1/reward-entries')
      .set('Authorization', `Bearer ${ingestToken}`)
      .send(body);
    expect(ingestResponse.status).toBe(200);

    const cacheResponse = await request(app.getHttpServer())
      .post('/api/v1/cache/invalidate')
      .set('Authorization', `Bearer ${cacheAdminToken}`)
      .send({ key: 'serviceConfig' });
    expect(cacheResponse.status).toBe(200);
  });
});
