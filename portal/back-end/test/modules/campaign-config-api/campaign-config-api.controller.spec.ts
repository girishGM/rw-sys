/**
 * T-INT-010 — `CampaignConfigApiController` against a mocked `CampaignConfigService`: the GrpcError
 * → HTTP status mapping, the `sections` query-string → wire-enum conversion, and the ETag polling
 * substitute for `WatchCampaignConfig` (TC-5, TC-6). Parity with the real gRPC responses (TC-1
 * through TC-4) is proven over real HTTP in `test/e2e/campaign-config-api.e2e-spec.ts` — this file
 * is the fast, isolated half.
 */
import { HttpException, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import { CampaignConfigApiController } from '@/modules/campaign-config-api/campaign-config-api.controller';
import type { CampaignConfigService } from '@/grpc/campaign-config.service';
import { GrpcError, GrpcStatus, type GrpcStatusCode } from '@/grpc/grpc.errors';
import { CONFIG_SECTION, TTL_HEADER } from '@/grpc/grpc.constants';
import type { ResolvedServiceIdentity } from '@/grpc/service-scope.guard';

const CALLER: ResolvedServiceIdentity = {
  identity: 'txn-runtime.internal',
  grants: [
    {
      id: 1,
      serviceIdentity: 'txn-runtime.internal',
      tenantId: null,
      allowedSections: ['BASIC', 'RULES'],
      status: 'active',
      createdBy: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ],
};

function fakeResponse(): jest.Mocked<Pick<Response, 'setHeader' | 'status'>> {
  return { setHeader: jest.fn(), status: jest.fn() } as unknown as jest.Mocked<
    Pick<Response, 'setHeader' | 'status'>
  >;
}

function controllerWith(service: Partial<CampaignConfigService>): CampaignConfigApiController {
  return new CampaignConfigApiController(service as CampaignConfigService);
}

describe('CampaignConfigApiController — GrpcError → HTTP mapping', () => {
  const cases: readonly [GrpcStatusCode, number][] = [
    [GrpcStatus.NOT_FOUND, HttpStatus.NOT_FOUND],
    [GrpcStatus.PERMISSION_DENIED, HttpStatus.FORBIDDEN],
    [GrpcStatus.UNAUTHENTICATED, HttpStatus.UNAUTHORIZED],
    [GrpcStatus.INVALID_ARGUMENT, HttpStatus.BAD_REQUEST],
    [GrpcStatus.RESOURCE_EXHAUSTED, HttpStatus.TOO_MANY_REQUESTS],
    [GrpcStatus.INTERNAL, HttpStatus.INTERNAL_SERVER_ERROR],
  ];

  it.each(cases)('GrpcStatus %s becomes HTTP %s', async (grpcStatus, httpStatus) => {
    const controller = controllerWith({
      getBudgetStatus: jest
        .fn()
        .mockRejectedValue(new GrpcError(grpcStatus, 'refused for the test')),
    });

    await expect(controller.getBudgetStatus(CALLER, 7, 'CAMP1')).rejects.toMatchObject({
      status: httpStatus,
    } as Partial<HttpException>);
  });

  it('TC-9: a section-grant refusal from the service surfaces as 403, not a 500', async () => {
    const controller = controllerWith({
      listActiveCampaigns: jest
        .fn()
        .mockRejectedValue(
          new GrpcError(GrpcStatus.PERMISSION_DENIED, 'section RULES not granted'),
        ),
    });

    await expect(
      controller.listActiveCampaigns(CALLER, 7, {}, fakeResponse() as unknown as Response),
    ).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN });
  });

  it('an error that is not a GrpcError propagates unchanged (caught by the global filter)', async () => {
    const boom = new Error('unexpected');
    const controller = controllerWith({
      getBudgetStatus: jest.fn().mockRejectedValue(boom),
    });

    await expect(controller.getBudgetStatus(CALLER, 7, 'CAMP1')).rejects.toBe(boom);
  });
});

describe('CampaignConfigApiController — sections query param', () => {
  it('an absent `sections` query param asks the service for none explicitly (the "give me what I may have" case)', async () => {
    const listActiveCampaigns = jest.fn().mockResolvedValue({
      list: {
        campaigns: [],
        servedAt: '2026-01-01T00:00:00Z',
        sectionsReturned: [],
        sectionsOmitted: [],
      },
      sections: { returned: [], omitted: [] },
    });
    const controller = controllerWith({ listActiveCampaigns });

    await controller.listActiveCampaigns(CALLER, 7, {}, fakeResponse() as unknown as Response);

    expect(listActiveCampaigns).toHaveBeenCalledWith(CALLER, { tenantId: 7, sections: [] });
  });

  it('translates section names to the wire enum numbers the service expects', async () => {
    const listActiveCampaigns = jest.fn().mockResolvedValue({
      list: {
        campaigns: [],
        servedAt: '2026-01-01T00:00:00Z',
        sectionsReturned: [],
        sectionsOmitted: [],
      },
      sections: { returned: [], omitted: [] },
    });
    const controller = controllerWith({ listActiveCampaigns });

    await controller.listActiveCampaigns(
      CALLER,
      7,
      { sections: ['BASIC', 'RULES'] },
      fakeResponse() as unknown as Response,
    );

    expect(listActiveCampaigns).toHaveBeenCalledWith(CALLER, {
      tenantId: 7,
      sections: [CONFIG_SECTION.BASIC, CONFIG_SECTION.RULES],
    });
  });

  it('always sets the x-config-ttl-seconds header (implementation note 3)', async () => {
    const controller = controllerWith({
      listActiveCampaigns: jest.fn().mockResolvedValue({
        list: {
          campaigns: [],
          servedAt: '2026-01-01T00:00:00Z',
          sectionsReturned: [],
          sectionsOmitted: [],
        },
        sections: { returned: [], omitted: [] },
      }),
    });
    const response = fakeResponse();

    await controller.listActiveCampaigns(CALLER, 7, {}, response as unknown as Response);

    expect(response.setHeader).toHaveBeenCalledWith(TTL_HEADER, expect.any(String));
  });
});

describe('CampaignConfigApiController — GetCampaignConfig ETag polling (TC-5, TC-6)', () => {
  function configOf(overrides: Record<string, unknown> = {}) {
    return {
      campaignId: 1,
      campaignCode: 'CAMP1',
      tenantId: 7,
      etag: 'fresh-etag',
      configHash: 'hash',
      notModified: false,
      servedAt: '2026-01-01T00:00:00Z',
      sectionsReturned: [],
      sectionsOmitted: [],
      ...overrides,
    };
  }

  it('TC-5: a still-current etag answers 304 with no body', async () => {
    const controller = controllerWith({
      getCampaignConfig: jest.fn().mockResolvedValue({
        config: configOf({ notModified: true, etag: 'current' }),
        sections: { returned: [], omitted: [] },
      }),
    });
    const response = fakeResponse();

    const body = await controller.getCampaignConfig(
      CALLER,
      7,
      'CAMP1',
      {},
      'current',
      response as unknown as Response,
    );

    expect(response.status).toHaveBeenCalledWith(HttpStatus.NOT_MODIFIED);
    expect(response.setHeader).toHaveBeenCalledWith('ETag', 'current');
    expect(body).toBeUndefined();
  });

  it('TC-6: a stale etag answers 200 with the full payload and a fresh ETag header', async () => {
    const controller = controllerWith({
      getCampaignConfig: jest.fn().mockResolvedValue({
        config: configOf({ notModified: false, etag: 'brand-new' }),
        sections: { returned: [], omitted: [] },
      }),
    });
    const response = fakeResponse();

    const body = await controller.getCampaignConfig(
      CALLER,
      7,
      'CAMP1',
      {},
      'stale',
      response as unknown as Response,
    );

    expect(response.status).not.toHaveBeenCalled();
    expect(response.setHeader).toHaveBeenCalledWith('ETag', 'brand-new');
    expect(body).toEqual({ data: configOf({ notModified: false, etag: 'brand-new' }) });
  });

  it('prefers the If-None-Match header over a ?etag= query param when both are present', async () => {
    const getCampaignConfig = jest.fn().mockResolvedValue({
      config: configOf(),
      sections: { returned: [], omitted: [] },
    });
    const controller = controllerWith({ getCampaignConfig });

    await controller.getCampaignConfig(
      CALLER,
      7,
      'CAMP1',
      { etag: 'from-query' },
      'from-header',
      fakeResponse() as unknown as Response,
    );

    expect(getCampaignConfig).toHaveBeenCalledWith(
      CALLER,
      expect.objectContaining({ etag: 'from-header' }),
    );
  });

  it('falls back to the ?etag= query param when no If-None-Match header is sent', async () => {
    const getCampaignConfig = jest.fn().mockResolvedValue({
      config: configOf(),
      sections: { returned: [], omitted: [] },
    });
    const controller = controllerWith({ getCampaignConfig });

    await controller.getCampaignConfig(
      CALLER,
      7,
      'CAMP1',
      { etag: 'from-query' },
      undefined,
      fakeResponse() as unknown as Response,
    );

    expect(getCampaignConfig).toHaveBeenCalledWith(
      CALLER,
      expect.objectContaining({ etag: 'from-query' }),
    );
  });
});
