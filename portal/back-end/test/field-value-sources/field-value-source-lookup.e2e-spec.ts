/**
 * T-123 — the two live lookup endpoints, against the real `AppModule`, real Postgres and a real
 * local HTTP server standing in for a confirmed external provider (13-REWARD-MASTER-VALUE-SOURCES.md
 * §3). Two actors: `maker` (the only role that matters for these reads — every role is permitted,
 * see the controller header, so one non-`super_admin` actor is enough to prove that) and
 * `super_admin`, used only to register the throwaway "active" fixture provider through T-121's own
 * write endpoint.
 *
 * ### Why a real local server rather than a mocked `fetch`
 *
 * AGENT-PROTOCOL §3: *"assert the observable property, not the implementation string"*. TC-6's
 * mapping and TC-7's 502/504 both depend on `FieldApiLookupHttpClient` actually parsing a real HTTP
 * response and actually timing out against a real socket — a mocked `Response` object would prove
 * only that this suite's mock and this suite's code agree with each other. The unit spec
 * (`field-value-source-lookup.service.spec.ts`) covers the branching logic around that seam with a
 * double; this suite covers the seam itself.
 *
 * Covers TC-1…TC-8 and both verification steps.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as argon2 from 'argon2';
import request from 'supertest';
import { QueryTypes } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { AppModule } from '@/app.module';
import { ARGON2_OPTIONS } from '@/modules/auth/auth.constants';
import { SEQUELIZE } from '@/database/sequelize.provider';
import { validationExceptionFactory } from '@/common/errors/validation.exception-factory';
import { CSRF_COOKIE_NAME } from '@/modules/auth/session.constants';
import { loginCompletingMfa } from '../auth/support/super-admin-mfa';
import {
  deletePortalUsersByEmail,
  emailCryptoOf,
  ensureEncryptionKeys,
  insertPortalUser,
  removeEncryptionKeys,
} from '../auth/support/portal-user-fixture';
import type { PortalUserEmailCrypto } from '@/common/data-protection/portal-user-email.crypto';

jest.setTimeout(300_000);

const SUITE = 't123';
const PASSWORD = 'correct horse battery staple 13!';
const SUPER_ADMIN_EMAIL = 't123-e2e-super@example.invalid';
const MAKER_EMAIL = 't123-e2e-maker@example.invalid';
const STAMP = Date.now();
const TRACKER_CODE = `t123test_trk_${STAMP}`;
const ACTIVE_PROVIDER_CODE = `T123_FIXTURE_${STAMP}`;
const BEARER_PROVIDER_CODE = `T123_FIXTURE_AUTH_${STAMP}`;
/** Must never appear in any response body — verification step 2. */
const SECRET_TOKEN = `t123-secret-${STAMP}`;

let app: INestApplication;
let db: Sequelize;
let emailCrypto: PortalUserEmailCrypto;

let localServer: Server;
let localServerPort: number;
type Handler = (req: IncomingMessage, res: ServerResponse) => void;
let currentHandler: Handler = (_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('[]');
};

let tenantId: number;
let countryId: number;
let trackerId: number;
const componentIds: number[] = [];

interface Actor {
  jar: string;
  csrf: string;
}
const actors = new Map<string, Actor>();

function http() {
  return request(app.getHttpServer());
}

function cookieValue(response: request.Response, name: string): string {
  const header = response.headers['set-cookie'];
  const entries = Array.isArray(header) ? header : header === undefined ? [] : [header];
  const match = entries.find((entry) => entry.startsWith(`${name}=`));
  if (match === undefined) throw new Error(`no Set-Cookie for ${name}`);
  return decodeURIComponent(match.split(';')[0].slice(name.length + 1));
}

function jarFrom(response: request.Response): string {
  const header = response.headers['set-cookie'];
  const entries = Array.isArray(header) ? header : header === undefined ? [] : [header];
  return entries
    .map((entry) => entry.split(';')[0])
    .filter((pair) => !pair.endsWith('='))
    .join('; ');
}

function as(key: string): Actor {
  const actor = actors.get(key);
  if (actor === undefined) throw new Error(`no actor "${key}"`);
  return actor;
}

function get(key: string, path: string) {
  return http().get(`/api/v1${path}`).set('Cookie', as(key).jar);
}

function post(key: string, path: string, body: unknown) {
  return http()
    .post(`/api/v1${path}`)
    .set('Cookie', as(key).jar)
    .set('X-CSRF-Token', as(key).csrf)
    .send(body as object);
}

async function makeActor(
  key: string,
  email: string,
  role: string,
  scope: { countryId: number | null; tenantId: number | null; merchantId: number | null } = {
    countryId: null,
    tenantId: null,
    merchantId: null,
  },
): Promise<void> {
  await deletePortalUsersByEmail(db, emailCrypto, [email]);
  const userId = await insertPortalUser(db, emailCrypto, {
    email,
    displayName: `T-123 ${key}`,
    role,
    ...scope,
    mustChangePassword: false,
  });
  await db.query(
    `INSERT INTO reward_portal.portal_user_credentials (user_id, password_hash, password_algo)
     VALUES (:userId, :hash, 'argon2id')`,
    { replacements: { userId, hash: await argon2.hash(PASSWORD, ARGON2_OPTIONS) } },
  );
  const response = await loginCompletingMfa(app, { email, password: PASSWORD }, db);
  if (response.status !== 200) {
    throw new Error(`login for ${key} failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
  actors.set(key, { jar: jarFrom(response), csrf: cookieValue(response, CSRF_COOKIE_NAME) });
}

async function insertReturningId(
  sql: string,
  replacements: Record<string, unknown>,
): Promise<number> {
  const [row] = await db.query<{ id: number }>(sql, { type: QueryTypes.SELECT, replacements });
  return row.id;
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      exceptionFactory: validationExceptionFactory,
    }),
  );
  await app.init();

  db = app.get<Sequelize>(SEQUELIZE);
  await ensureEncryptionKeys(db, SUITE);
  emailCrypto = emailCryptoOf(app);

  const [tenantRow] = await db.query<{ id: number; countryId: number }>(
    `SELECT id, country_id AS "countryId" FROM reward_config.tenants LIMIT 1`,
    { type: QueryTypes.SELECT },
  );
  tenantId = tenantRow.id;
  countryId = tenantRow.countryId;

  await makeActor('super', SUPER_ADMIN_EMAIL, 'super_admin');
  await makeActor('maker', MAKER_EMAIL, 'maker', { countryId, tenantId, merchantId: null });

  // A tracker with three components, seeded in ascending sequence_order (1, 2, 3) — the fixture
  // TC-1/TC-2 filter against.
  trackerId = await insertReturningId(
    `INSERT INTO reward_config.trackers (tenant_id, tracker_code, name, completion_logic)
     VALUES (:tenantId, :code, 'T-123 sibling order', 'all') RETURNING id`,
    { tenantId, code: TRACKER_CODE },
  );
  for (let i = 0; i < 3; i += 1) {
    const componentId = await insertReturningId(
      `INSERT INTO reward_config.tracker_components (tenant_id, component_code, name)
       VALUES (:tenantId, :code, :name) RETURNING id`,
      { tenantId, code: `t123test_c${i}_${STAMP}`, name: `T-123 Component ${i}` },
    );
    componentIds.push(componentId);
    await db.query(
      `INSERT INTO reward_config.tracker_tracker_components (tracker_id, component_id, sequence_order)
       VALUES (:trackerId, :componentId, :seq)`,
      { type: QueryTypes.RAW, replacements: { trackerId, componentId, seq: i + 1 } },
    );
  }

  localServer = createServer((req, res) => currentHandler(req, res));
  await new Promise<void>((resolve) => localServer.listen(0, '127.0.0.1', resolve));
  const address = localServer.address();
  localServerPort = typeof address === 'object' && address !== null ? address.port : 0;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    localServer.close((error) => (error ? reject(error) : resolve()));
  });

  await db.query(
    `DELETE FROM reward_config.tracker_tracker_components WHERE tracker_id = :trackerId`,
    { type: QueryTypes.RAW, replacements: { trackerId } },
  );
  await db.query(
    `DELETE FROM reward_config.tracker_components WHERE tenant_id = :tenantId AND component_code LIKE 't123test\\_%'`,
    {
      type: QueryTypes.RAW,
      replacements: { tenantId },
    },
  );
  await db.query(`DELETE FROM reward_config.trackers WHERE id = :trackerId`, {
    type: QueryTypes.RAW,
    replacements: { trackerId },
  });
  await db.query(
    `DELETE FROM reward_config.field_api_lookup_providers WHERE provider_code LIKE 'T123\\_%'`,
    {
      type: QueryTypes.RAW,
    },
  );

  await deletePortalUsersByEmail(db, emailCrypto, [SUPER_ADMIN_EMAIL, MAKER_EMAIL]);
  await removeEncryptionKeys(db, SUITE);
  await app.close();
});

describe('T-123 — context lookup', () => {
  it('TC-1: SIBLING_COMPONENTS, real trackerId + excludeComponentId mid-journey — only strictly earlier components', async () => {
    const res = await get(
      'maker',
      `/field-value-sources/context/SIBLING_COMPONENTS?trackerId=${trackerId}&excludeComponentId=${componentIds[2]}`,
    );
    expect(res.status).toBe(200);
    const values = (res.body.data as Array<{ value: number }>).map((row) => row.value);
    expect(values).toEqual([componentIds[0], componentIds[1]]);
  });

  it('the earliest component has no earlier sibling at all — an empty list, not an error', async () => {
    const res = await get(
      'maker',
      `/field-value-sources/context/SIBLING_COMPONENTS?trackerId=${trackerId}&excludeComponentId=${componentIds[0]}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('TC-2: excludeComponentId omitted — every component in the tracker', async () => {
    const res = await get(
      'maker',
      `/field-value-sources/context/SIBLING_COMPONENTS?trackerId=${trackerId}`,
    );
    expect(res.status).toBe(200);
    const values = (res.body.data as Array<{ value: number }>).map((row) => row.value);
    expect(values).toEqual(componentIds);
  });

  it('the documented response shape: value/label plus componentCode/sequenceOrder', async () => {
    const res = await get(
      'maker',
      `/field-value-sources/context/SIBLING_COMPONENTS?trackerId=${trackerId}`,
    );
    expect(res.body.data[0]).toEqual({
      value: componentIds[0],
      label: 'T-123 Component 0',
      componentCode: `t123test_c0_${STAMP}`,
      sequenceOrder: 1,
    });
  });

  it('JOURNEY_COMPONENTS returns the full, unfiltered list even with excludeComponentId set', async () => {
    const res = await get(
      'maker',
      `/field-value-sources/context/JOURNEY_COMPONENTS?trackerId=${trackerId}&excludeComponentId=${componentIds[0]}`,
    );
    expect(res.status).toBe(200);
    const values = (res.body.data as Array<{ value: number }>).map((row) => row.value);
    expect(values).toEqual(componentIds);
  });

  it('TC-3: unknown trackerId is a 404', async () => {
    const res = await get(
      'maker',
      `/field-value-sources/context/SIBLING_COMPONENTS?trackerId=999999999`,
    );
    expect(res.status).toBe(404);
  });

  it('an unknown context provider code is a 404', async () => {
    const res = await get(
      'maker',
      `/field-value-sources/context/NOT_A_REAL_PROVIDER?trackerId=${trackerId}`,
    );
    expect(res.status).toBe(404);
  });

  it('excludeComponentId that is not a member of this tracker is a 400, not a silently unfiltered list', async () => {
    const res = await get(
      'maker',
      `/field-value-sources/context/SIBLING_COMPONENTS?trackerId=${trackerId}&excludeComponentId=999999999`,
    );
    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual([
      { field: 'excludeComponentId', code: 'COMPONENT_NOT_IN_TRACKER' },
    ]);
  });

  it('a missing trackerId is a 400 (whitelisted, required query param)', async () => {
    const res = await get('maker', `/field-value-sources/context/SIBLING_COMPONENTS`);
    expect(res.status).toBe(400);
  });

  it('TC-8: unauthenticated is a 401', async () => {
    const res = await http().get(
      `/api/v1/field-value-sources/context/SIBLING_COMPONENTS?trackerId=${trackerId}`,
    );
    expect(res.status).toBe(401);
  });
});

describe('T-123 — API lookup', () => {
  it('verification step 2 / TC-4: a planned provider is 501, no network call attempted', async () => {
    // PROMO_CODE_CONFIG_SERVICE is seeded by T-121 with endpoint_url = a non-URL placeholder
    // string. If this task ever attempted a real fetch against it, the failure would surface as
    // a 502 (a malformed-URL error), not a 501 — so observing 501 here is itself proof no call
    // was attempted, not merely a restatement of the status branch.
    const res = await get('maker', '/field-value-sources/api/PROMO_CODE_CONFIG_SERVICE');
    expect(res.status).toBe(501);
  });

  it('TC-5: an unknown API lookup provider code is a 404', async () => {
    const res = await get('maker', '/field-value-sources/api/NOT_A_REAL_PROVIDER');
    expect(res.status).toBe(404);
  });

  it('TC-6: an active fixture provider maps the mocked response into value/label pairs', async () => {
    currentHandler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify([
          { id: 1, label: 'Alpha' },
          { id: 2, label: 'Beta' },
        ]),
      );
    };

    const created = await post('super', '/field-api-lookup-providers', {
      providerCode: ACTIVE_PROVIDER_CODE,
      name: 'T-123 active fixture',
      endpointUrl: `http://127.0.0.1:${localServerPort}/lookup`,
      responseValueKey: 'id',
      responseLabelKey: 'label',
      status: 'active',
    });
    expect(created.status).toBe(201);

    const res = await get('maker', `/field-value-sources/api/${ACTIVE_PROVIDER_CODE}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      { value: 1, label: 'Alpha' },
      { value: 2, label: 'Beta' },
    ]);
  });

  it('a bearer credential is decrypted and sent as a real Authorization header', async () => {
    currentHandler = (req, res) => {
      if (req.headers.authorization !== `Bearer ${SECRET_TOKEN}`) {
        res.writeHead(401);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([{ code: 'X1', display: 'Option X1' }]));
    };

    const created = await post('super', '/field-api-lookup-providers', {
      providerCode: BEARER_PROVIDER_CODE,
      name: 'T-123 bearer fixture',
      endpointUrl: `http://127.0.0.1:${localServerPort}/secure`,
      authType: 'bearer',
      authConfig: { token: SECRET_TOKEN },
      responseValueKey: 'code',
      responseLabelKey: 'display',
      status: 'active',
    });
    expect(created.status).toBe(201);
    // The credential must never come back, even to the super_admin who just set it.
    expect(JSON.stringify(created.body)).not.toContain(SECRET_TOKEN);

    const res = await get('maker', `/field-value-sources/api/${BEARER_PROVIDER_CODE}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([{ value: 'X1', label: 'Option X1' }]);
    expect(JSON.stringify(res.body)).not.toContain(SECRET_TOKEN);
  });

  it('TC-7: an upstream 5xx is a clean 502 — no stack trace, no internal detail', async () => {
    currentHandler = (_req, res) => {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('internal upstream failure with a stack-shaped string at Object.<anonymous>');
    };

    const res = await get('maker', `/field-value-sources/api/${ACTIVE_PROVIDER_CODE}`);
    expect(res.status).toBe(502);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('at Object.');
    expect(raw).not.toContain('reward_config');
    expect(res.body.error.traceId).toEqual(expect.any(String));
  });

  it('TC-7 (timeout variant): an upstream that never answers within the timeout is a 504', async () => {
    currentHandler = (_req, res) => {
      // Never calls res.end() — the client-side AbortSignal.timeout is what ends this exchange.
      void res;
    };

    const res = await get('maker', `/field-value-sources/api/${ACTIVE_PROVIDER_CODE}`);
    expect(res.status).toBe(504);
  }, 20_000);

  it('TC-8: unauthenticated is a 401', async () => {
    const res = await http().get(`/api/v1/field-value-sources/api/${ACTIVE_PROVIDER_CODE}`);
    expect(res.status).toBe(401);
  });
});
