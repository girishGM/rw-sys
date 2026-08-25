/**
 * T-015 — `MeController`: the transport decisions, tested without a server.
 *
 * Three of them are worth isolating from an HTTP round trip, because each is easy to write in a
 * way that passes an e2e and is still wrong:
 *
 *  - the 304 branch must **not** run phase two. An e2e sees the status and the empty body and is
 *    equally happy with a handler that assembled the whole payload and then threw it away — which
 *    would make the ETag a bandwidth optimisation rather than the latency one implementation note
 *    8 is asking for.
 *  - the `ETag` and `Cache-Control` headers must be set on **both** branches. A 304 without an
 *    ETag leaves the client with nothing to revalidate against on its next request.
 *  - `Vary` must be *appended*, not assigned, so it composes with the `Vary: Origin` the CORS
 *    layer adds rather than replacing it.
 */
import { HttpStatus } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AUDIT_METADATA } from '@/common/audit/decorators/audit.decorator';
import { PERMISSION_METADATA_KEY, ROLES_METADATA_KEY } from '@/common/rbac/rbac.constants';
import { IS_PUBLIC_KEY } from '@/modules/auth/decorators/public.decorator';
import { PASSWORD_CHANGE_EXEMPT_KEY } from '@/modules/auth/decorators/password-change-exempt.decorator';
import { BOOTSTRAP_CACHE_CONTROL, MeController } from '@/modules/me/me.controller';
import type { BootstrapDto } from '@/modules/me/dto/bootstrap-response.dto';
import type { BootstrapRevision, BootstrapService } from '@/modules/me/bootstrap.service';
import type { MeService } from '@/modules/me/me.service';
import { actor } from './support/me-doubles';

const ETAG = 'W/"maker-3-1000"';

class FakeBootstrapService {
  revisions = 0;
  assemblies = 0;
  etag = ETAG;

  async revision(): Promise<BootstrapRevision> {
    this.revisions += 1;
    return {
      etag: this.etag,
      user: { id: 12, displayName: 'A Maker', role: 'maker', locale: 'en', timezone: null },
    };
  }

  async assemble(): Promise<BootstrapDto> {
    this.assemblies += 1;
    return {
      user: { id: 12, displayName: 'A Maker', role: 'maker', locale: 'en', timezone: null },
      scope: { countryId: 3, tenantId: 7, merchantId: null },
      nav: [],
      permissions: {},
      widgets: [],
      messages: {},
    };
  }
}

class FakeMeService {
  profileCalls = 0;
  updates: unknown[] = [];

  async getProfile() {
    this.profileCalls += 1;
    return { id: 12 } as never;
  }

  async updateProfile(_who: unknown, dto: unknown) {
    this.updates.push(dto);
    return { id: 12 } as never;
  }
}

/** The two response methods the handler uses, plus the status and headers it produced. */
function responseDouble() {
  const headers = new Map<string, string>();
  const varied: string[] = [];
  let status = HttpStatus.OK;

  const response = {
    setHeader(name: string, value: string) {
      headers.set(name, value);
    },
    vary(field: string) {
      varied.push(field);
    },
    status(code: number) {
      status = code;
      return response;
    },
  };

  return {
    response: response as unknown as Response,
    headers,
    varied,
    statusOf: () => status,
  };
}

function requestDouble(ifNoneMatch?: string | string[]): Request {
  return {
    headers: ifNoneMatch === undefined ? {} : { 'if-none-match': ifNoneMatch },
  } as unknown as Request;
}

describe('MeController', () => {
  let bootstrap: FakeBootstrapService;
  let me: FakeMeService;
  let controller: MeController;

  beforeEach(() => {
    bootstrap = new FakeBootstrapService();
    me = new FakeMeService();
    controller = new MeController(
      bootstrap as unknown as BootstrapService,
      me as unknown as MeService,
    );
  });

  describe('GET /me/bootstrap', () => {
    it('returns the payload inside the { data } envelope (03-API-CONTRACT.md §1)', async () => {
      const { response } = responseDouble();

      const body = await controller.getBootstrap(actor(), requestDouble(), response);

      expect(Object.keys(body ?? {})).toEqual(['data']);
      expect(body?.data.user.role).toBe('maker');
    });

    it('sets ETag, Cache-Control and Vary on the 200 path', async () => {
      const probe = responseDouble();

      await controller.getBootstrap(actor(), requestDouble(), probe.response);

      expect(probe.headers.get('ETag')).toBe(ETAG);
      expect(probe.headers.get('Cache-Control')).toBe(BOOTSTRAP_CACHE_CONTROL);
      expect(probe.varied).toEqual(['Cookie']);
      expect(probe.statusOf()).toBe(HttpStatus.OK);
    });

    it('Cache-Control is `private, no-cache` — never public, never a max-age', () => {
      // Pinned as a literal: a shared cache storing one user's nav and serving it to another is
      // the failure this header exists to prevent (implementation note 7).
      expect(BOOTSTRAP_CACHE_CONTROL).toBe('private, no-cache');
    });

    it('TC-12: answers 304 with an empty body when If-None-Match matches', async () => {
      const probe = responseDouble();

      const body = await controller.getBootstrap(actor(), requestDouble(ETAG), probe.response);

      expect(probe.statusOf()).toBe(HttpStatus.NOT_MODIFIED);
      expect(body).toBeUndefined();
    });

    it('TC-12: the 304 does no phase-two work at all', async () => {
      const probe = responseDouble();

      await controller.getBootstrap(actor(), requestDouble(ETAG), probe.response);

      expect(bootstrap.revisions).toBe(1);
      expect(bootstrap.assemblies).toBe(0);
    });

    it('still sets ETag and Cache-Control on the 304', async () => {
      const probe = responseDouble();

      await controller.getBootstrap(actor(), requestDouble(ETAG), probe.response);

      expect(probe.headers.get('ETag')).toBe(ETAG);
      expect(probe.headers.get('Cache-Control')).toBe(BOOTSTRAP_CACHE_CONTROL);
    });

    it('TC-13: a stale ETag gets a fresh 200, not a 304', async () => {
      const probe = responseDouble();

      const body = await controller.getBootstrap(
        actor(),
        requestDouble('W/"maker-2-1000"'),
        probe.response,
      );

      expect(probe.statusOf()).toBe(HttpStatus.OK);
      expect(body).toBeDefined();
      expect(bootstrap.assemblies).toBe(1);
    });

    it('joins a repeated If-None-Match header rather than letting the first one win', async () => {
      const probe = responseDouble();

      await controller.getBootstrap(
        actor(),
        requestDouble(['W/"someone-elses-tag"', ETAG]),
        probe.response,
      );

      expect(probe.statusOf()).toBe(HttpStatus.NOT_MODIFIED);
    });
  });

  describe('GET /me', () => {
    it('envelopes the profile', async () => {
      const body = await controller.getProfile(actor());

      expect(Object.keys(body)).toEqual(['data']);
      expect(me.profileCalls).toBe(1);
    });
  });

  describe('PATCH /me', () => {
    it('passes the validated DTO through and envelopes the result', async () => {
      const body = await controller.updateProfile(actor(), { displayName: 'New' });

      expect(me.updates).toEqual([{ displayName: 'New' }]);
      expect(Object.keys(body)).toEqual(['data']);
    });

    it('is decorated for the portal audit log, not the campaign trail', () => {
      const options = Reflect.getMetadata(
        AUDIT_METADATA,
        MeController.prototype.updateProfile,
      ) as Record<string, unknown>;

      // No `store: 'campaign'` — a profile change is an access-control event, and 01-DATABASE.md
      // §2.5 forbids mixing the two stores.
      expect(options).toEqual({ event: 'profile_updated', targetType: 'portal_user' });
    });

    it('the read routes are not audited — a GET changes nothing', () => {
      expect(
        Reflect.getMetadata(AUDIT_METADATA, MeController.prototype.getBootstrap),
      ).toBeUndefined();
      expect(
        Reflect.getMetadata(AUDIT_METADATA, MeController.prototype.getProfile),
      ).toBeUndefined();
    });
  });

  describe('route authorisation metadata', () => {
    it('declares all six roles at the class level (03-API-CONTRACT.md §3: any)', () => {
      const roles = Reflect.getMetadata(ROLES_METADATA_KEY, MeController) as string[];

      expect([...roles].sort()).toEqual([
        'checker',
        'country_admin',
        'maker',
        'merchant',
        'super_admin',
        'tenant_admin',
      ]);
    });

    it('declares no @RequirePermission — /me must not be lockable by a config row', () => {
      for (const handler of [
        MeController.prototype.getBootstrap,
        MeController.prototype.getProfile,
        MeController.prototype.updateProfile,
      ]) {
        expect(Reflect.getMetadata(PERMISSION_METADATA_KEY, handler)).toBeUndefined();
      }
    });

    it('declares no @Public and no password-change exemption', () => {
      // 02-SECURITY.md §2: a `must_change_password` session reaches exactly two endpoints, and
      // neither of them is here. `@Public()` would make the whole endpoint anonymous (TC-14).
      for (const handler of [
        MeController.prototype.getBootstrap,
        MeController.prototype.getProfile,
        MeController.prototype.updateProfile,
      ]) {
        expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler)).toBeUndefined();
        expect(Reflect.getMetadata(PASSWORD_CHANGE_EXEMPT_KEY, handler)).toBeUndefined();
      }
      expect(Reflect.getMetadata(IS_PUBLIC_KEY, MeController)).toBeUndefined();
      expect(Reflect.getMetadata(PASSWORD_CHANGE_EXEMPT_KEY, MeController)).toBeUndefined();
    });
  });
});
