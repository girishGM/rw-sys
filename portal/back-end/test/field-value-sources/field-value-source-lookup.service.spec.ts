/**
 * T-123 — `FieldValueSourceLookupService` against doubled `ScopedRepository`/
 * `FieldValueSourceRegistriesService`/`FieldApiLookupHttpClient`, the same shape
 * `field-value-source-registries.service.spec.ts` (T-121) establishes for this module.
 *
 * `FieldApiLookupHttpClient` itself is exercised separately, below, against a **real** local HTTP
 * server rather than a mocked `fetch` — see that describe block's own header for why (the same
 * "assert the observable property" reasoning `field-value-source-lookup.e2e-spec.ts` gives for
 * doing the equivalent thing at the full-stack level). Everything above that line tests only this
 * service's own branching logic, for which a plain `jest.fn()` double is the right tool: the
 * question there is "did this service call the seam correctly", not "does the seam work".
 *
 * T-172 adds `tenantId` as `apiLookup`'s required second argument (see that service's own header,
 * "T-172", for why). Every pre-existing case below passes `null` explicitly, which preserves each
 * test's original, literal expected URL unchanged — this task's own new cases, at the bottom of
 * the `apiLookup` describe block, are what actually prove the injection.
 */
import { createServer, type Server } from 'node:http';
import {
  FieldApiLookupHttpClient,
  FieldApiLookupUpstreamError,
  FieldApiLookupUpstreamTimeoutError,
  FieldLookupProviderNotAvailableError,
  FieldValueSourceLookupService,
} from '@/modules/field-value-sources/field-value-source-lookup.service';
import { NotFoundError, ValidationFailedError } from '@/common/errors/app-error';
import {
  FieldApiLookupProvider,
  FieldContextProvider,
  Tracker,
  TrackerComponent,
  TrackerTrackerComponent,
} from '@/database/models';
import type { ScopedRepository } from '@/common/scope/scoped.repository';
import type { FieldValueSourceRegistriesService } from '@/modules/field-value-sources/field-value-source-registries.service';

function link(componentId: number, sequenceOrder: number, name: string, code: string) {
  return {
    componentId,
    sequenceOrder,
    component: { name, componentCode: code },
  };
}

interface Doubles {
  service: FieldValueSourceLookupService;
  scoped: { listAll: jest.Mock; findByPkOrFail: jest.Mock };
  registries: { getAuthConfigForLookup: jest.Mock };
  httpClient: { requestJson: jest.Mock };
}

function build(): Doubles {
  const scoped = { listAll: jest.fn(), findByPkOrFail: jest.fn() };
  const registries = { getAuthConfigForLookup: jest.fn() };
  const httpClient = { requestJson: jest.fn() };
  const service = new FieldValueSourceLookupService(
    scoped as unknown as ScopedRepository,
    registries as unknown as FieldValueSourceRegistriesService,
    httpClient as unknown as FieldApiLookupHttpClient,
  );
  return { service, scoped, registries, httpClient };
}

describe('FieldValueSourceLookupService — contextLookup', () => {
  it('an unknown provider code is a 404, before the tracker is ever looked up', async () => {
    const { service, scoped } = build();
    scoped.listAll.mockResolvedValueOnce([]); // no FieldContextProvider row

    await expect(service.contextLookup('NOT_REAL', 1)).rejects.toBeInstanceOf(NotFoundError);
    expect(scoped.findByPkOrFail).not.toHaveBeenCalled();
  });

  it('TC-3: an unknown/out-of-scope trackerId propagates the 404 findByPkOrFail throws', async () => {
    const { service, scoped } = build();
    scoped.listAll.mockResolvedValueOnce([{ providerCode: 'SIBLING_COMPONENTS' }]);
    const notFound = new Error('ScopeViolationError');
    scoped.findByPkOrFail.mockRejectedValueOnce(notFound);

    await expect(service.contextLookup('SIBLING_COMPONENTS', 999)).rejects.toBe(notFound);
  });

  it('TC-1: SIBLING_COMPONENTS with excludeComponentId keeps only strictly earlier links', async () => {
    const { service, scoped } = build();
    scoped.listAll
      .mockResolvedValueOnce([{ providerCode: 'SIBLING_COMPONENTS' }])
      .mockResolvedValueOnce([
        link(10, 1, 'Earlier', 'C1'),
        link(20, 2, 'Middle', 'C2'),
        link(30, 3, 'Later', 'C3'),
      ]);
    scoped.findByPkOrFail.mockResolvedValueOnce({ id: 1 });

    const result = await service.contextLookup('SIBLING_COMPONENTS', 1, 30);

    expect(result).toEqual([
      { value: 10, label: 'Earlier', componentCode: 'C1', sequenceOrder: 1 },
      { value: 20, label: 'Middle', componentCode: 'C2', sequenceOrder: 2 },
    ]);
  });

  it('the earliest component excludes itself into an empty list, not an error', async () => {
    const { service, scoped } = build();
    scoped.listAll
      .mockResolvedValueOnce([{ providerCode: 'SIBLING_COMPONENTS' }])
      .mockResolvedValueOnce([link(10, 1, 'Earlier', 'C1'), link(20, 2, 'Later', 'C2')]);
    scoped.findByPkOrFail.mockResolvedValueOnce({ id: 1 });

    await expect(service.contextLookup('SIBLING_COMPONENTS', 1, 10)).resolves.toEqual([]);
  });

  it('TC-2: excludeComponentId omitted returns every component, unfiltered', async () => {
    const { service, scoped } = build();
    scoped.listAll
      .mockResolvedValueOnce([{ providerCode: 'SIBLING_COMPONENTS' }])
      .mockResolvedValueOnce([link(10, 1, 'A', 'C1'), link(20, 2, 'B', 'C2')]);
    scoped.findByPkOrFail.mockResolvedValueOnce({ id: 1 });

    const result = await service.contextLookup('SIBLING_COMPONENTS', 1);
    expect(result.map((r) => r.value)).toEqual([10, 20]);
  });

  it('excludeComponentId not a member of this tracker is a 400, never a silently unfiltered list', async () => {
    const { service, scoped } = build();
    scoped.listAll
      .mockResolvedValueOnce([{ providerCode: 'SIBLING_COMPONENTS' }])
      .mockResolvedValueOnce([link(10, 1, 'A', 'C1')]);
    scoped.findByPkOrFail.mockResolvedValueOnce({ id: 1 });

    await expect(service.contextLookup('SIBLING_COMPONENTS', 1, 999)).rejects.toBeInstanceOf(
      ValidationFailedError,
    );
  });

  it('JOURNEY_COMPONENTS returns the full list even when excludeComponentId is supplied', async () => {
    const { service, scoped } = build();
    scoped.listAll
      .mockResolvedValueOnce([{ providerCode: 'JOURNEY_COMPONENTS' }])
      .mockResolvedValueOnce([link(10, 1, 'A', 'C1'), link(20, 2, 'B', 'C2')]);
    scoped.findByPkOrFail.mockResolvedValueOnce({ id: 1 });

    const result = await service.contextLookup('JOURNEY_COMPONENTS', 1, 10);
    expect(result.map((r) => r.value)).toEqual([10, 20]);
  });

  it('issues the scoped read with the right model, where and include', async () => {
    const { service, scoped } = build();
    scoped.listAll
      .mockResolvedValueOnce([{ providerCode: 'JOURNEY_COMPONENTS' }])
      .mockResolvedValueOnce([]);
    scoped.findByPkOrFail.mockResolvedValueOnce({ id: 1 });

    await service.contextLookup('JOURNEY_COMPONENTS', 42);

    expect(scoped.findByPkOrFail).toHaveBeenCalledWith(Tracker, 42);
    expect(scoped.listAll).toHaveBeenNthCalledWith(1, FieldContextProvider, {
      where: { providerCode: 'JOURNEY_COMPONENTS' },
      limit: 1,
    });
    expect(scoped.listAll).toHaveBeenNthCalledWith(2, TrackerTrackerComponent, {
      where: { trackerId: 42 },
      include: [TrackerComponent],
      order: [['sequenceOrder', 'ASC']],
    });
  });
});

describe('FieldValueSourceLookupService — apiLookup', () => {
  it('TC-5: an unknown provider code is a 404', async () => {
    const { service, scoped, httpClient } = build();
    scoped.listAll.mockResolvedValueOnce([]);

    await expect(service.apiLookup('NOT_REAL', null)).rejects.toBeInstanceOf(NotFoundError);
    expect(httpClient.requestJson).not.toHaveBeenCalled();
    expect(scoped.listAll).toHaveBeenCalledWith(FieldApiLookupProvider, {
      where: { providerCode: 'NOT_REAL' },
      limit: 1,
    });
  });

  it('TC-4: a planned provider is 501 and the HTTP client is never invoked', async () => {
    const { service, scoped, httpClient } = build();
    scoped.listAll.mockResolvedValueOnce([{ id: 1, status: 'planned' }]);

    await expect(service.apiLookup('PLANNED_ONE', null)).rejects.toBeInstanceOf(
      FieldLookupProviderNotAvailableError,
    );
    expect(httpClient.requestJson).not.toHaveBeenCalled();
  });

  it('an inactive provider is declined the same way, also without a network call', async () => {
    const { service, scoped, httpClient } = build();
    scoped.listAll.mockResolvedValueOnce([{ id: 1, status: 'inactive' }]);

    await expect(service.apiLookup('INACTIVE_ONE', null)).rejects.toBeInstanceOf(
      FieldLookupProviderNotAvailableError,
    );
    expect(httpClient.requestJson).not.toHaveBeenCalled();
  });

  it('TC-6: an active provider with authType none maps the response with no auth header', async () => {
    const { service, scoped, registries, httpClient } = build();
    scoped.listAll.mockResolvedValueOnce([
      {
        id: 7,
        status: 'active',
        authType: 'none',
        endpointUrl: 'https://internal.invalid/x',
        httpMethod: 'GET',
        responseValueKey: 'id',
        responseLabelKey: 'name',
      },
    ]);
    registries.getAuthConfigForLookup.mockResolvedValue(null);
    httpClient.requestJson.mockResolvedValue([
      { id: 1, name: 'One' },
      { id: 2, name: 'Two' },
    ]);

    const result = await service.apiLookup('ACTIVE_ONE', null);

    expect(result).toEqual([
      { value: 1, label: 'One' },
      { value: 2, label: 'Two' },
    ]);
    expect(httpClient.requestJson).toHaveBeenCalledWith('https://internal.invalid/x', 'GET', {});
  });

  it('a bearer provider sends a real Authorization header built from the decrypted config', async () => {
    const { service, scoped, registries, httpClient } = build();
    scoped.listAll.mockResolvedValueOnce([
      {
        id: 8,
        status: 'active',
        authType: 'bearer',
        endpointUrl: 'https://internal.invalid/secure',
        httpMethod: 'GET',
        responseValueKey: 'id',
        responseLabelKey: 'label',
      },
    ]);
    registries.getAuthConfigForLookup.mockResolvedValue({ token: 'abc123' });
    httpClient.requestJson.mockResolvedValue([]);

    await service.apiLookup('BEARER_ONE', null);

    expect(httpClient.requestJson).toHaveBeenCalledWith('https://internal.invalid/secure', 'GET', {
      Authorization: 'Bearer abc123',
    });
  });

  it('a bearer provider with no usable token declines with a 502, not a 500', async () => {
    const { service, scoped, registries, httpClient } = build();
    scoped.listAll.mockResolvedValueOnce([
      { id: 9, status: 'active', authType: 'bearer', endpointUrl: 'u', httpMethod: 'GET' },
    ]);
    registries.getAuthConfigForLookup.mockResolvedValue(null);

    await expect(service.apiLookup('BEARER_MISCONFIGURED', null)).rejects.toBeInstanceOf(
      FieldApiLookupUpstreamError,
    );
    expect(httpClient.requestJson).not.toHaveBeenCalled();
  });

  it('an api_key provider uses the configured header name', async () => {
    const { service, scoped, registries, httpClient } = build();
    scoped.listAll.mockResolvedValueOnce([
      {
        id: 10,
        status: 'active',
        authType: 'api_key',
        endpointUrl: 'https://internal.invalid/keyed',
        httpMethod: 'GET',
        responseValueKey: 'id',
        responseLabelKey: 'label',
      },
    ]);
    registries.getAuthConfigForLookup.mockResolvedValue({
      headerName: 'X-Custom-Key',
      value: 'the-key',
    });
    httpClient.requestJson.mockResolvedValue([]);

    await service.apiLookup('API_KEY_ONE', null);

    expect(httpClient.requestJson).toHaveBeenCalledWith('https://internal.invalid/keyed', 'GET', {
      'X-Custom-Key': 'the-key',
    });
  });

  it('an api_key provider with no headerName configured defaults to X-Api-Key', async () => {
    const { service, scoped, registries, httpClient } = build();
    scoped.listAll.mockResolvedValueOnce([
      { id: 11, status: 'active', authType: 'api_key', endpointUrl: 'u', httpMethod: 'GET' },
    ]);
    registries.getAuthConfigForLookup.mockResolvedValue({ value: 'the-key' });
    httpClient.requestJson.mockResolvedValue([]);

    await service.apiLookup('API_KEY_DEFAULT', null);

    expect(httpClient.requestJson).toHaveBeenCalledWith('u', 'GET', { 'X-Api-Key': 'the-key' });
  });

  it('an api_key provider with no usable value declines with a 502', async () => {
    const { service, scoped, registries, httpClient } = build();
    scoped.listAll.mockResolvedValueOnce([
      { id: 12, status: 'active', authType: 'api_key', endpointUrl: 'u', httpMethod: 'GET' },
    ]);
    registries.getAuthConfigForLookup.mockResolvedValue({});

    await expect(service.apiLookup('API_KEY_MISCONFIGURED', null)).rejects.toBeInstanceOf(
      FieldApiLookupUpstreamError,
    );
    expect(httpClient.requestJson).not.toHaveBeenCalled();
  });

  it('an unsupported auth_type (mtls) declines with a 502 rather than attempting an unauthenticated call', async () => {
    const { service, scoped, registries, httpClient } = build();
    scoped.listAll.mockResolvedValueOnce([
      { id: 13, status: 'active', authType: 'mtls', endpointUrl: 'u', httpMethod: 'GET' },
    ]);
    registries.getAuthConfigForLookup.mockResolvedValue(null);

    await expect(service.apiLookup('MTLS_ONE', null)).rejects.toBeInstanceOf(
      FieldApiLookupUpstreamError,
    );
    expect(httpClient.requestJson).not.toHaveBeenCalled();
  });

  it('a non-array upstream response is a 502, not a partial/garbled 200', async () => {
    const { service, scoped, registries, httpClient } = build();
    scoped.listAll.mockResolvedValueOnce([
      { id: 14, status: 'active', authType: 'none', endpointUrl: 'u', httpMethod: 'GET' },
    ]);
    registries.getAuthConfigForLookup.mockResolvedValue(null);
    httpClient.requestJson.mockResolvedValue({ not: 'an array' });

    await expect(service.apiLookup('NOT_AN_ARRAY', null)).rejects.toBeInstanceOf(
      FieldApiLookupUpstreamError,
    );
  });

  it("TC-7: the HTTP client's own errors propagate unchanged (502/504), never disguised", async () => {
    const { service, scoped, registries, httpClient } = build();
    scoped.listAll.mockResolvedValue([
      { id: 15, status: 'active', authType: 'none', endpointUrl: 'u', httpMethod: 'GET' },
    ]);
    registries.getAuthConfigForLookup.mockResolvedValue(null);

    const timeout = new FieldApiLookupUpstreamTimeoutError();
    httpClient.requestJson.mockRejectedValueOnce(timeout);
    await expect(service.apiLookup('SLOW_ONE', null)).rejects.toBe(timeout);

    const upstream = new FieldApiLookupUpstreamError();
    httpClient.requestJson.mockRejectedValueOnce(upstream);
    await expect(service.apiLookup('BROKEN_ONE', null)).rejects.toBe(upstream);
  });

  it('value/label mapping coerces non-string/number entries rather than dropping them', async () => {
    const { service, scoped, registries, httpClient } = build();
    scoped.listAll.mockResolvedValueOnce([
      {
        id: 16,
        status: 'active',
        authType: 'none',
        endpointUrl: 'u',
        httpMethod: 'GET',
        responseValueKey: 'v',
        responseLabelKey: 'l',
      },
    ]);
    registries.getAuthConfigForLookup.mockResolvedValue(null);
    httpClient.requestJson.mockResolvedValue([
      { v: 1, l: 'fine' },
      { v: 'two', l: 2 },
      {}, // missing both keys entirely
      null, // not even an object
    ]);

    const result = await service.apiLookup('COERCION_CASE', null);
    expect(result).toEqual([
      { value: 1, label: 'fine' },
      { value: 'two', label: '2' },
      { value: '', label: '' },
      { value: '', label: '' },
    ]);
  });

  // T-172 — the fix under test. Everything above passes `tenantId: null` and keeps its original,
  // literal expected URL; these cases are what actually prove the injection this task adds.
  describe('T-172 — tenantId injection', () => {
    it('T-172 TC-1: reproduces the reported defect on unfixed code — a tenant-scoped upstream call carries no tenantId at all', async () => {
      // "Unfixed" here means calling with the pre-T-172 behaviour this suite pins below (TC-3):
      // a `null` tenantId leaves `endpointUrl` completely untouched. Before this task, `apiLookup`
      // had no second parameter and could never have sent anything else — this is that exact
      // shape, captured so a regression that silently drops the parameter again is caught here,
      // not only in the (harder to run) live e2e suite.
      const { service, scoped, registries, httpClient } = build();
      scoped.listAll.mockResolvedValueOnce([
        {
          id: 20,
          status: 'active',
          authType: 'bearer',
          endpointUrl: 'https://promo-code-service.invalid/api/v1/promo-code-configs',
          httpMethod: 'GET',
          responseValueKey: 'id',
          responseLabelKey: 'name',
        },
      ]);
      registries.getAuthConfigForLookup.mockResolvedValue({ token: 'svc-token' });
      httpClient.requestJson.mockResolvedValue([]);

      await service.apiLookup('PROMO_CODE_CONFIG_SERVICE', null);

      // The reported defect: no `tenantId` reaches the upstream URL at all when the caller's own
      // tenantId is unavailable/never plumbed through — indistinguishable, from the HTTP client's
      // point of view, from the pre-fix code that had nowhere to put it.
      const calledUrl = httpClient.requestJson.mock.calls[0][0] as string;
      expect(calledUrl).not.toContain('tenantId');
    });

    it('T-172 TC-2/TC-3: a real tenantId is appended as a `tenantId` query parameter — the fix, proven to matter by TC-1 above', async () => {
      const { service, scoped, registries, httpClient } = build();
      scoped.listAll.mockResolvedValueOnce([
        {
          id: 21,
          status: 'active',
          authType: 'bearer',
          endpointUrl: 'https://promo-code-service.invalid/api/v1/promo-code-configs',
          httpMethod: 'GET',
          responseValueKey: 'id',
          responseLabelKey: 'name',
        },
      ]);
      registries.getAuthConfigForLookup.mockResolvedValue({ token: 'svc-token' });
      httpClient.requestJson.mockResolvedValue([]);

      await service.apiLookup('PROMO_CODE_CONFIG_SERVICE', 4711);

      expect(httpClient.requestJson).toHaveBeenCalledWith(
        'https://promo-code-service.invalid/api/v1/promo-code-configs?tenantId=4711',
        'GET',
        { Authorization: 'Bearer svc-token' },
      );
    });

    it("an endpoint_url that already carries its own query string keeps it, and appends tenantId with '&'", async () => {
      const { service, scoped, registries, httpClient } = build();
      scoped.listAll.mockResolvedValueOnce([
        {
          id: 22,
          status: 'active',
          authType: 'none',
          endpointUrl: 'https://internal.invalid/x?foo=bar',
          httpMethod: 'GET',
          responseValueKey: 'id',
          responseLabelKey: 'name',
        },
      ]);
      registries.getAuthConfigForLookup.mockResolvedValue(null);
      httpClient.requestJson.mockResolvedValue([]);

      await service.apiLookup('WITH_QUERY_STRING', 99);

      expect(httpClient.requestJson).toHaveBeenCalledWith(
        'https://internal.invalid/x?foo=bar&tenantId=99',
        'GET',
        {},
      );
    });

    it('TC-4: a caller with no tenant scope leaves endpoint_url untouched — adjacent behaviour that must not change', async () => {
      const { service, scoped, registries, httpClient } = build();
      scoped.listAll.mockResolvedValueOnce([
        {
          id: 23,
          status: 'active',
          authType: 'none',
          endpointUrl: 'https://internal.invalid/global-catalog',
          httpMethod: 'GET',
          responseValueKey: 'id',
          responseLabelKey: 'name',
        },
      ]);
      registries.getAuthConfigForLookup.mockResolvedValue(null);
      httpClient.requestJson.mockResolvedValue([]);

      await service.apiLookup('GLOBAL_PROVIDER', null);

      expect(httpClient.requestJson).toHaveBeenCalledWith(
        'https://internal.invalid/global-catalog',
        'GET',
        {},
      );
    });

    it('a malformed (non-URL) endpoint_url is not thrown on — tenantId is still appended by plain string concatenation', async () => {
      const { service, scoped, registries, httpClient } = build();
      scoped.listAll.mockResolvedValueOnce([
        { id: 24, status: 'active', authType: 'none', endpointUrl: 'u', httpMethod: 'GET' },
      ]);
      registries.getAuthConfigForLookup.mockResolvedValue(null);
      httpClient.requestJson.mockResolvedValue([]);

      await service.apiLookup('NOT_A_REAL_URL', 5);

      expect(httpClient.requestJson).toHaveBeenCalledWith('u?tenantId=5', 'GET', {});
    });
  });
});

// --- FieldApiLookupHttpClient — against a real local HTTP server ---------------------------

/**
 * Real sockets, real timeouts, real JSON parsing. A mocked `fetch` would only prove this class
 * agrees with its own mock; this proves the class actually behaves the way TC-6/TC-7 need against
 * something that behaves like a real, uncooperative third party.
 */
describe('FieldApiLookupHttpClient — against a real local server', () => {
  let server: Server;
  let port: number;
  let handler: (
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ) => void;

  beforeAll(async () => {
    server = createServer((req, res) => handler(req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    port = typeof address === 'object' && address !== null ? address.port : 0;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it('parses a real 200 JSON response', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([{ a: 1 }]));
    };
    const client = new FieldApiLookupHttpClient();
    await expect(client.requestJson(`http://127.0.0.1:${port}/`, 'GET', {})).resolves.toEqual([
      { a: 1 },
    ]);
  });

  it('sends the headers it was given', async () => {
    let seen: string | undefined;
    handler = (req, res) => {
      seen = req.headers['x-probe'] as string | undefined;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('[]');
    };
    const client = new FieldApiLookupHttpClient();
    await client.requestJson(`http://127.0.0.1:${port}/`, 'GET', { 'X-Probe': 'hello' });
    expect(seen).toBe('hello');
  });

  it('a real non-2xx status becomes FieldApiLookupUpstreamError', async () => {
    handler = (_req, res) => {
      res.writeHead(503);
      res.end('nope');
    };
    const client = new FieldApiLookupHttpClient();
    await expect(client.requestJson(`http://127.0.0.1:${port}/`, 'GET', {})).rejects.toBeInstanceOf(
      FieldApiLookupUpstreamError,
    );
  });

  it('a real malformed JSON body becomes FieldApiLookupUpstreamError', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{not json');
    };
    const client = new FieldApiLookupHttpClient();
    await expect(client.requestJson(`http://127.0.0.1:${port}/`, 'GET', {})).rejects.toBeInstanceOf(
      FieldApiLookupUpstreamError,
    );
  });

  it('a connection that is refused outright becomes FieldApiLookupUpstreamError, not an unhandled rejection', async () => {
    const client = new FieldApiLookupHttpClient();
    // Nothing listens on this port — it was just closed above's counterpart would still be in
    // TIME_WAIT territory, so a fixed, never-bound port in the ephemeral range is used instead.
    await expect(client.requestJson('http://127.0.0.1:1/', 'GET', {})).rejects.toBeInstanceOf(
      FieldApiLookupUpstreamError,
    );
  });

  it('a real timeout becomes FieldApiLookupUpstreamTimeoutError', async () => {
    handler = (_req, res) => {
      void res; // never respond
    };
    const client = new FieldApiLookupHttpClient();
    await expect(client.requestJson(`http://127.0.0.1:${port}/`, 'GET', {})).rejects.toBeInstanceOf(
      FieldApiLookupUpstreamTimeoutError,
    );
  }, 20_000);
});
