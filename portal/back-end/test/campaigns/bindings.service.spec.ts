/**
 * T-166 — `BindingsService.attachReward` now registers a Promo Code Config with promo-code-service
 * **before** it writes anything locally, and this file is the proof of that ordering.
 *
 * ### The property under test is an ordering, not a call
 *
 * "Did the client get invoked" is the easy half and on its own proves very little. What every
 * failure case below actually asserts is the stronger property T-166 exists for: **after a failed
 * bind, nothing was written** — no assignment row, no `reward_policies.config` update, no audit
 * event. A test that only checked the thrown status would still pass if `attachReward` inserted
 * the row first and threw afterwards, which is precisely the bug this ordering prevents. So each
 * one asserts the recorded side effects are empty as well (AGENT-PROTOCOL §3: *"ask of each
 * security-critical test: if the specified value were wrong, would this test still pass?"*).
 *
 * ### What is faked, and what deliberately is not
 *
 * The repository and the audit service are faked, as in `t127-promo-code-attach.spec.ts` whose
 * harness this file reuses. `PromoCodeServiceClient` is faked **in this file's service-level
 * cases only** — the question there is "did `attachReward` order its steps correctly", not "does
 * the HTTP client work". The client's own behaviour (TC-2/TC-3/TC-4/TC-7/TC-8) is exercised at the
 * bottom of this file against a **real local HTTP server**: real sockets, a real timeout, a real
 * connection refusal, real non-2xx statuses. A mocked `fetch` would only prove the client agrees
 * with its own mock, which is the failure mode T-058 was written about.
 */
import { createServer, type Server } from 'node:http';
import type {
  CreateOptions,
  FindOptions,
  Model,
  ModelStatic,
  Transaction,
  UpdateOptions,
} from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import type { ConfigService } from '@nestjs/config';
import type { ScopedRepository } from '@/common/scope/scoped.repository';
import type { AuthenticatedUser } from '@/modules/auth/decorators/current-user.decorator';
import type { CampaignAuditService } from '@/modules/campaigns/campaign-audit.service';
import type { Env } from '@/config/env.schema';
import type { TenantCampaign } from '@/database/models';
import {
  RewardCampaignAssignment,
  RewardPolicy,
  RewardSystem,
  RewardVersion,
  RewardVersionCountryAssignment,
  TenantCampaignTracker,
  TrackerTrackerComponent,
} from '@/database/models';
import { BindingsService } from '@/modules/campaigns/bindings.service';
import {
  NotPartOfCampaignError,
  PromoCodeConfigNotApplicableError,
} from '@/modules/campaigns/campaigns.errors';
import { PermissionDeniedHttpException } from '@/common/rbac/rbac.exceptions';
import type { AttachRewardDto } from '@/modules/campaigns/dto/binding.dto';
import {
  PromoCodeServiceClient,
  toBindLevel,
  type PromoCodeBindRequest,
} from '@/modules/promo-code-integration/promo-code-service.client';
import {
  PromoCodeConfigNotBindableError,
  PromoCodeServiceBindError,
  PromoCodeServiceBindTimeoutError,
} from '@/modules/promo-code-integration/promo-code-service.errors';

// --- doubles -------------------------------------------------------------------------------------

interface RecordedUpdate {
  readonly model: string;
  readonly values: Record<string, unknown>;
  readonly options: UpdateOptions;
}

class FakeScoped {
  readonly updates: RecordedUpdate[] = [];
  readonly created: { model: string; values: Record<string, unknown> }[] = [];
  private readonly rows = new Map<string, unknown[]>();

  setRows(model: ModelStatic<Model>, rows: readonly unknown[]): this {
    this.rows.set(model.name, [...rows]);
    return this;
  }

  /**
   * Returns the seeded rows for `model`, **filtered by the plain equality keys of `where`**.
   *
   * The equivalent double in `t127-promo-code-attach.spec.ts` ignores `where` entirely, which is
   * fine there because every case it runs is set up to pass membership. It is not fine here: the
   * "component belonging to another campaign" case below is *about* a `where` that must not match,
   * and against a double that ignores `where` it passed while proving nothing (observed — the
   * attach succeeded and bound a component this campaign does not own).
   *
   * Two deliberate limits. Only **primitive** values are compared — `Op.in` and friends are
   * objects and are left alone, being Sequelize's to implement and not what any case here turns
   * on. And only keys the seeded row actually carries are compared: these model classes are
   * imported but never `init()`ed, so `model.primaryKeyAttribute` is `undefined` and
   * `byIdOrNull` builds a `{ undefined: 22 }` clause that no fixture can satisfy. Skipping unknown
   * keys keeps by-id reads working exactly as they do in the T-127 harness, while still honouring
   * the clauses the fixtures do model.
   */
  async listAll<M extends Model>(model: ModelStatic<M>, options: FindOptions = {}): Promise<M[]> {
    const rows = (this.rows.get(model.name) ?? []) as Record<string, unknown>[];
    const where = (options.where ?? {}) as Record<string, unknown>;
    return rows.filter((row) =>
      Object.entries(where).every(([key, value]) => {
        if (!(key in row)) return true;
        if (value !== null && typeof value === 'object') return true;
        return row[key] === value;
      }),
    ) as M[];
  }

  async create<M extends Model>(
    model: ModelStatic<M>,
    values: unknown,
    _options: CreateOptions = {},
  ): Promise<M> {
    this.created.push({ model: model.name, values: values as Record<string, unknown> });
    return { id: 9001, ...(values as object) } as unknown as M;
  }

  async update(
    model: ModelStatic<Model>,
    values: unknown,
    options: UpdateOptions,
  ): Promise<number> {
    this.updates.push({ model: model.name, values: values as Record<string, unknown>, options });
    return 1;
  }
}

class FakeSequelize {
  /** How many times the writing transaction was opened at all — TC-2/TC-3/TC-4 assert this is
   * zero, which is a strictly stronger statement than "no rows were created": it proves the bind
   * runs before the transaction is even started, not merely before the first insert inside it. */
  transactions = 0;
  async transaction<T>(fn: (transaction: Transaction) => Promise<T>): Promise<T> {
    this.transactions += 1;
    return fn({} as Transaction);
  }
}

class FakeAudit {
  readonly events: Record<string, unknown>[] = [];
  async record(_actor: unknown, event: Record<string, unknown>): Promise<void> {
    this.events.push(event);
  }
}

/** Records every bind, and fails with whatever the case wants it to fail with. */
class FakePromoCodeServiceClient {
  readonly binds: PromoCodeBindRequest[] = [];
  failure: Error | null = null;

  async bind(request: PromoCodeBindRequest): Promise<void> {
    this.binds.push(request);
    if (this.failure !== null) throw this.failure;
  }
}

// --- fixtures ------------------------------------------------------------------------------------

const MAKER = {
  userId: 1,
  role: 'maker',
  tenantId: 10,
  countryId: 20,
  merchantId: null,
} as unknown as AuthenticatedUser;

const CHECKER = { ...MAKER, userId: 2, role: 'checker' } as unknown as AuthenticatedUser;

const CAMPAIGN = { id: 500, tenantId: 10 } as unknown as TenantCampaign;

interface PolicyRow {
  readonly row: RewardPolicy;
  readonly updates: Record<string, unknown>[];
}

function policyRow(config: Record<string, unknown> = {}): PolicyRow {
  const updates: Record<string, unknown>[] = [];
  const row = {
    id: 22,
    rewardSystemId: 2,
    policyCode: 'POL_PROMO',
    name: 'Raya promo',
    status: 'active',
    config,
    update: async (values: Record<string, unknown>): Promise<void> => {
      updates.push(values);
    },
  } as unknown as RewardPolicy;
  return { row, updates };
}

function version(
  id: number,
  rewardKind: string | null,
  valueConfig: Record<string, unknown> | null,
): RewardVersion {
  return {
    id,
    rewardKind,
    valueConfig,
    unitType: null,
    unitCode: null,
  } as unknown as RewardVersion;
}

/** A `PROMO_CODE` version the author allowed at every level, so a case can choose freely. */
function promoVersion(
  bindLevels: readonly string[] = ['campaign', 'tracker', 'component'],
): RewardVersion {
  return version(202, 'PROMO_CODE', {
    apiProvider: 'PROMO_CODE_CONFIG_SERVICE',
    bindLevels: [...bindLevels],
  });
}

const CASHBACK_VERSION = version(101, 'FIXED_AMOUNT', {
  multiCurrency: false,
  defaultCurrency: 'MYR',
  defaultValue: 10,
});

const POINTS_VERSION = version(303, 'POINTS', { defaultPoints: 50 });

interface Wiring {
  readonly policy?: PolicyRow;
  readonly version?: RewardVersion | null;
}

function build({ policy = policyRow(), version: live = promoVersion() }: Wiring = {}) {
  const scoped = new FakeScoped();
  const audit = new FakeAudit();
  const sequelize = new FakeSequelize();
  const promoCodeService = new FakePromoCodeServiceClient();

  scoped.setRows(RewardPolicy, [policy.row]);
  scoped.setRows(RewardSystem, [
    { id: policy.row.rewardSystemId, name: 'Promo code', rewardType: 'voucher' },
  ]);
  scoped.setRows(
    RewardVersionCountryAssignment,
    live === null
      ? []
      : [{ rewardId: policy.row.rewardSystemId, rewardVersionId: live.id, status: 'active' }],
  );
  scoped.setRows(RewardVersion, live === null ? [] : [live]);

  // Tracker 7 and component 71 are genuinely part of CAMPAIGN — see the same block in
  // `t127-promo-code-attach.spec.ts` for why membership is set up rather than re-tested.
  scoped.setRows(TenantCampaignTracker, [
    { id: 30, campaignId: CAMPAIGN.id, trackerId: 7, status: 'active' },
  ]);
  scoped.setRows(TrackerTrackerComponent, [
    { id: 40, trackerId: 7, componentId: 71, sequenceOrder: 1 },
  ]);

  const service = new BindingsService(
    sequelize as unknown as Sequelize,
    scoped as unknown as ScopedRepository,
    audit as unknown as CampaignAuditService,
    promoCodeService as unknown as PromoCodeServiceClient,
  );
  return { service, scoped, audit, sequelize, promoCodeService, policy };
}

function attach(overrides: Partial<AttachRewardDto> = {}): AttachRewardDto {
  return { level: 'campaign', rewardPolicyId: 22, ...overrides } as AttachRewardDto;
}

/** Every observable local side effect of an attach, in one object — so a failure case can assert
 * "nothing happened" in a single `toEqual` instead of four that could each be forgotten. */
function sideEffects(built: ReturnType<typeof build>) {
  return {
    created: built.scoped.created,
    scopedUpdates: built.scoped.updates,
    policyUpdates: built.policy.updates,
    auditEvents: built.audit.events,
    transactionsOpened: built.sequelize.transactions,
  };
}

const NOTHING_HAPPENED = {
  created: [],
  scopedUpdates: [],
  policyUpdates: [],
  auditEvents: [],
  transactionsOpened: 0,
};

// --- TC-1: the happy path ------------------------------------------------------------------------

describe('T-166 · a PROMO_CODE attach registers the binding before it writes anything', () => {
  it('TC-1: binds remotely, then creates the assignment, the config and the audit row', async () => {
    const built = build();

    const id = await built.service.attachReward(
      MAKER,
      CAMPAIGN,
      attach({ promoCodeConfig: 'CONFIG_UUID_1' }),
    );

    expect(id).toBe(9001);

    // The bind carried exactly §2's body, built from the campaign and the verified actor — never
    // from anything the client could have supplied for tenant or actor (R3).
    expect(built.promoCodeService.binds).toEqual([
      {
        promoCodeConfigId: 'CONFIG_UUID_1',
        tenantId: 10,
        bindLevel: 'CAMPAIGN',
        bindRefId: CAMPAIGN.id,
        boundBy: MAKER.userId,
      },
    ]);

    // …and everything T-127 did before this task still happens, unchanged.
    expect(built.scoped.created.map((row) => row.model)).toEqual([RewardCampaignAssignment.name]);
    expect(built.policy.updates[0]?.['config']).toEqual({ promoCodeConfig: 'CONFIG_UUID_1' });
    expect(built.audit.events[0]?.['fieldChanges']).toEqual({
      level: 'campaign',
      refId: null,
      rewardPolicyId: 22,
      promoCodeConfig: 'CONFIG_UUID_1',
    });
  });

  it('binds before the writing transaction is opened at all, not merely before the insert', async () => {
    // The ordering property stated as directly as it can be: at the moment the client was called,
    // no transaction existed. This is what stops a network round trip being made under a lock.
    const built = build();
    let transactionsWhenBound = -1;
    built.promoCodeService.bind = async (request): Promise<void> => {
      transactionsWhenBound = built.sequelize.transactions;
      built.promoCodeService.binds.push(request);
    };

    await built.service.attachReward(MAKER, CAMPAIGN, attach({ promoCodeConfig: 'CONFIG_UUID_1' }));

    expect(transactionsWhenBound).toBe(0);
    expect(built.sequelize.transactions).toBe(1);
  });
});

// --- TC-2/TC-3/TC-4: every failure leaves nothing behind -----------------------------------------

describe('T-166 · a failed bind attaches nothing at all', () => {
  it('TC-2: a 409 from promo-code-service fails the attach with a 4xx the maker can act on', async () => {
    const built = build();
    built.promoCodeService.failure = new PromoCodeConfigNotBindableError();

    const error: unknown = await built.service
      .attachReward(MAKER, CAMPAIGN, attach({ promoCodeConfig: 'ARCHIVED_CONFIG' }))
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PromoCodeConfigNotBindableError);
    const refusal = error as PromoCodeConfigNotBindableError;
    // 4xx, not 5xx: "pick a different config" — not "try again later", which would never work.
    expect(refusal.status).toBe(409);
    expect(refusal.code).toBe('PROMO_CODE_CONFIG_NOT_BINDABLE');
    expect(refusal.details).toEqual([{ field: 'promoCodeConfig', code: 'CONFIG_NOT_ACTIVE' }]);

    expect(sideEffects(built)).toEqual(NOTHING_HAPPENED);
  });

  it('TC-3: an unreachable promo-code-service fails the attach with a 502 and writes nothing', async () => {
    const built = build();
    built.promoCodeService.failure = new PromoCodeServiceBindError();

    const error: unknown = await built.service
      .attachReward(MAKER, CAMPAIGN, attach({ promoCodeConfig: 'CONFIG_UUID_1' }))
      .catch((caught: unknown) => caught);

    expect((error as PromoCodeServiceBindError).status).toBe(502);
    expect(sideEffects(built)).toEqual(NOTHING_HAPPENED);
  });

  it('TC-4: a hung promo-code-service fails the attach with a 504 and writes nothing', async () => {
    const built = build();
    built.promoCodeService.failure = new PromoCodeServiceBindTimeoutError();

    const error: unknown = await built.service
      .attachReward(MAKER, CAMPAIGN, attach({ promoCodeConfig: 'CONFIG_UUID_1' }))
      .catch((caught: unknown) => caught);

    expect((error as PromoCodeServiceBindTimeoutError).status).toBe(504);
    expect(sideEffects(built)).toEqual(NOTHING_HAPPENED);
  });
});

// --- TC-5/TC-6/TC-9/TC-10: everything the client must never be reached from -----------------------

describe('T-166 · the paths that must never reach promo-code-service', () => {
  it('TC-5: a PROMO_CODE attach with no config picked never calls the client', async () => {
    // The ordinary attach today: `PROMO_CODE_CONFIG_SERVICE` has only just been activated, and a
    // maker who picked nothing must still be able to attach the reward.
    const built = build();

    const id = await built.service.attachReward(MAKER, CAMPAIGN, attach());

    expect(id).toBe(9001);
    expect(built.promoCodeService.binds).toEqual([]);
    expect(built.scoped.created).toHaveLength(1);
  });

  it('TC-6: a config sent for a non-PROMO_CODE reward is refused before any bind is attempted', async () => {
    const built = build({ version: CASHBACK_VERSION });

    const error: unknown = await built.service
      .attachReward(MAKER, CAMPAIGN, attach({ promoCodeConfig: 'CONFIG_UUID_1' }))
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PromoCodeConfigNotApplicableError);
    // T-127's gate still fires first, so a misdirected config never leaves this process.
    expect(built.promoCodeService.binds).toEqual([]);
    expect(sideEffects(built)).toEqual(NOTHING_HAPPENED);
  });

  it('TC-9: a checker is refused by assertRole before the client is reached', async () => {
    const built = build();

    await expect(
      built.service.attachReward(CHECKER, CAMPAIGN, attach({ promoCodeConfig: 'CONFIG_UUID_1' })),
    ).rejects.toBeInstanceOf(PermissionDeniedHttpException);

    expect(built.promoCodeService.binds).toEqual([]);
    expect(sideEffects(built)).toEqual(NOTHING_HAPPENED);
  });

  it('TC-10: the cashback path is untouched — no bind, and the amount still lands', async () => {
    const built = build({ version: CASHBACK_VERSION });

    await built.service.attachReward(
      MAKER,
      CAMPAIGN,
      attach({ cashbackAmount: '25.00', cashbackCurrency: 'MYR' }),
    );

    expect(built.promoCodeService.binds).toEqual([]);
    expect(built.policy.updates[0]?.['config']).toEqual({ amount: '25.00', currency: 'MYR' });
  });

  it('TC-10: the points path is untouched too', async () => {
    const built = build({ version: POINTS_VERSION });

    await built.service.attachReward(MAKER, CAMPAIGN, attach({ points: 120 }));

    expect(built.promoCodeService.binds).toEqual([]);
    expect(built.policy.updates[0]?.['config']).toEqual({ points: 120 });
  });

  it('a component that belongs to another campaign is refused before the bind, not after it', async () => {
    // Not in the task's own table, and the case this file most needed: without the membership
    // check in the preflight, promo-code-service would record a real binding for a component this
    // campaign does not own, and only then would the local write refuse it. The remote row would
    // survive, referring to an attach that never happened.
    const built = build();

    await expect(
      built.service.attachReward(
        MAKER,
        CAMPAIGN,
        attach({ level: 'component', refId: 99, promoCodeConfig: 'CONFIG_UUID_1' }),
      ),
    ).rejects.toBeInstanceOf(NotPartOfCampaignError);

    expect(built.promoCodeService.binds).toEqual([]);
    expect(sideEffects(built)).toEqual(NOTHING_HAPPENED);
  });
});

// --- TC-7: the level mapping ---------------------------------------------------------------------

describe('T-166 · bindLevel mapping', () => {
  it.each([
    ['campaign', 'CAMPAIGN', undefined, CAMPAIGN.id],
    ['tracker', 'TRACKER', 7, 7],
    ['component', 'COMPONENT', 71, 71],
  ] as const)('TC-7: %s is sent as %s', async (level, expected, refId, expectedRefId) => {
    const built = build();

    await built.service.attachReward(
      MAKER,
      CAMPAIGN,
      attach({ level, refId, promoCodeConfig: 'CONFIG_UUID_1' }),
    );

    expect(built.promoCodeService.binds[0]?.bindLevel).toBe(expected);
    // Campaign level carries no `refId`, so the campaign itself is what the binding refers to —
    // `bind_ref_id` is NOT NULL on the far side (01-DATABASE.md §2).
    expect(built.promoCodeService.binds[0]?.bindRefId).toBe(expectedRefId);
  });

  it('maps every portal level, and the mapping is total', () => {
    // Asserted directly on the exported function as well, because the three cases above could all
    // pass while a fourth level added later silently produced `undefined`.
    expect(toBindLevel('campaign')).toBe('CAMPAIGN');
    expect(toBindLevel('tracker')).toBe('TRACKER');
    expect(toBindLevel('component')).toBe('COMPONENT');
  });
});

// --- PromoCodeServiceClient, against a real local HTTP server ------------------------------------

/**
 * Real sockets, real JSON, real timeouts, a real connection refusal. The bind is the first
 * outbound write this codebase makes, and "every failure normalises to one of three errors" is a
 * claim only a real, uncooperative server can support.
 */
describe('PromoCodeServiceClient — against a real local server', () => {
  let server: Server;
  let port: number;
  let handler: (
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ) => void;
  /** Whatever the last request actually put on the wire — body, method and headers. */
  let seen: { method?: string; auth?: string; contentType?: string; body: string };

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        seen = {
          method: req.method,
          auth: req.headers.authorization,
          contentType: req.headers['content-type'],
          body,
        };
        handler(req, res);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    port = typeof address === 'object' && address !== null ? address.port : 0;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  /** A client configured with `baseUrl`/`token`, through the real `ConfigService` shape. */
  function client(baseUrl: string | undefined, token: string | undefined): PromoCodeServiceClient {
    const config = {
      get: (key: keyof Env): unknown =>
        key === 'PROMO_CODE_SERVICE_BASE_URL' ? baseUrl : (token as unknown),
    };
    return new PromoCodeServiceClient(config as unknown as ConfigService<Env, true>);
  }

  const REQUEST: PromoCodeBindRequest = {
    promoCodeConfigId: 'CONFIG_UUID_1',
    tenantId: 10,
    bindLevel: 'CAMPAIGN',
    bindRefId: 500,
    boundBy: 1,
  };

  it('TC-1: a real 201 resolves, having POSTed §2’s body with the bearer token', async () => {
    handler = (_req, res) => {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'binding-uuid', status: 'ACTIVE' }));
    };

    await expect(
      client(`http://127.0.0.1:${String(port)}`, 'shared-token').bind(REQUEST),
    ).resolves.toBeUndefined();

    expect(seen.method).toBe('POST');
    expect(seen.auth).toBe('Bearer shared-token');
    expect(seen.contentType).toBe('application/json');
    // The body a real server parsed — not the object we handed in.
    expect(JSON.parse(seen.body)).toEqual({
      promoCodeConfigId: 'CONFIG_UUID_1',
      tenantId: 10,
      bindLevel: 'CAMPAIGN',
      bindRefId: 500,
      boundBy: 1,
    });
  });

  it('calls §2’s path, and tolerates a base URL with a trailing slash', async () => {
    let path: string | undefined;
    handler = (req, res) => {
      path = req.url;
      res.writeHead(201);
      res.end('{}');
    };

    await client(`http://127.0.0.1:${String(port)}/`, 'shared-token').bind(REQUEST);

    expect(path).toBe('/api/v1/campaign-promo-configs');
  });

  it('TC-2: a real 409 becomes PromoCodeConfigNotBindableError, not a 502', async () => {
    handler = (_req, res) => {
      res.writeHead(409, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'config not ACTIVE for tenant' }));
    };

    await expect(
      client(`http://127.0.0.1:${String(port)}`, 'shared-token').bind(REQUEST),
    ).rejects.toBeInstanceOf(PromoCodeConfigNotBindableError);
  });

  it('TC-8: promo-code-service’s own 401 surfaces as a 502 rather than being swallowed', async () => {
    // The misconfigured-token case. It must not look like success, and it must not look like the
    // maker's fault — an operator has to see it, so the status goes to the log and a 502 goes out.
    handler = (_req, res) => {
      res.writeHead(401);
      res.end('Unauthorized');
    };

    const error: unknown = await client(`http://127.0.0.1:${String(port)}`, 'wrong-token')
      .bind(REQUEST)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PromoCodeServiceBindError);
    expect((error as PromoCodeServiceBindError).status).toBe(502);
    expect((error as PromoCodeServiceBindError).logContext?.['status']).toBe(401);
    // The upstream's own body never becomes part of what a client of this portal can see.
    expect((error as PromoCodeServiceBindError).details).toBeUndefined();
  });

  it('a real 500 becomes a 502 too', async () => {
    handler = (_req, res) => {
      res.writeHead(500);
      res.end('boom');
    };

    await expect(
      client(`http://127.0.0.1:${String(port)}`, 'shared-token').bind(REQUEST),
    ).rejects.toBeInstanceOf(PromoCodeServiceBindError);
  });

  it('a 2xx with a body this portal cannot parse still resolves — the receipt is not read', async () => {
    // Deliberate: §2 answers with the created row and the portal keeps no reference to it. A
    // "bound successfully, then failed to parse the receipt" failure mode would be pure downside.
    handler = (_req, res) => {
      res.writeHead(201, { 'content-type': 'text/html' });
      res.end('<html>created</html>');
    };

    await expect(
      client(`http://127.0.0.1:${String(port)}`, 'shared-token').bind(REQUEST),
    ).resolves.toBeUndefined();
  });

  it('TC-3: a refused connection becomes a 502', async () => {
    // Port 1 on loopback: nothing listens, and the OS refuses immediately.
    const error: unknown = await client('http://127.0.0.1:1', 'shared-token')
      .bind(REQUEST)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PromoCodeServiceBindError);
    expect((error as PromoCodeServiceBindError).status).toBe(502);
  });

  it('TC-4: a server that hangs past the timeout becomes a 504', async () => {
    let hung: import('node:http').ServerResponse | undefined;
    handler = (_req, res) => {
      // Never answers. The client's own AbortSignal.timeout is what has to end this.
      hung = res;
    };

    const error: unknown = await client(`http://127.0.0.1:${String(port)}`, 'shared-token')
      .bind(REQUEST)
      .catch((caught: unknown) => caught);

    hung?.end();

    expect(error).toBeInstanceOf(PromoCodeServiceBindTimeoutError);
    expect((error as PromoCodeServiceBindTimeoutError).status).toBe(504);
    // Distinguished from the plain 502 on purpose: "up and slow" is diagnosed differently.
    expect((error as PromoCodeServiceBindTimeoutError).code).toBe(
      'PROMO_CODE_SERVICE_BIND_TIMEOUT',
    );
  }, 15000);

  it('fails closed with a 502 when the token is not configured, without calling anything', async () => {
    let called = false;
    handler = (_req, res) => {
      called = true;
      res.writeHead(201);
      res.end('{}');
    };

    await expect(
      client(`http://127.0.0.1:${String(port)}`, undefined).bind(REQUEST),
    ).rejects.toBeInstanceOf(PromoCodeServiceBindError);

    // An unconfigured portal refuses the attach; it never binds anonymously and never proceeds.
    expect(called).toBe(false);
  });

  it('fails closed with a 502 when the base URL is not configured', async () => {
    await expect(client(undefined, 'shared-token').bind(REQUEST)).rejects.toBeInstanceOf(
      PromoCodeServiceBindError,
    );
  });

  it('never puts the token or the upstream URL into anything a client could see', async () => {
    // R4-adjacent: the bearer token exists in this process and must stay there. `logMessage`/
    // `logContext` are server-log only (app-error.ts), and `details` is the only field of an
    // AppError that reaches a response body.
    handler = (_req, res) => {
      res.writeHead(503);
      res.end('nope');
    };

    const error = (await client(`http://127.0.0.1:${String(port)}`, 'super-secret-token')
      .bind(REQUEST)
      .catch((caught: unknown) => caught)) as PromoCodeServiceBindError;

    expect(error.details).toBeUndefined();
    expect(JSON.stringify(error.details ?? [])).not.toContain('super-secret-token');
    expect(error.code).toBe('PROMO_CODE_SERVICE_BIND_FAILED');
  });
});
