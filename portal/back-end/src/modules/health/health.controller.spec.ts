import { HttpStatus } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

/** Minimal double for Express's `Response`, capturing only what the controller calls. */
function fakeResponse(): { status: jest.Mock } {
  return { status: jest.fn() };
}

describe('HealthController', () => {
  describe('GET /health', () => {
    let controller: HealthController;

    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        controllers: [HealthController],
        providers: [{ provide: HealthService, useValue: { isDatabaseReachable: jest.fn() } }],
      }).compile();

      controller = module.get<HealthController>(HealthController);
    });

    it('returns { status: "ok" } and nothing else (TC-1, TC-4)', () => {
      const result = controller.check();
      expect(result).toEqual({ status: 'ok' });
      expect(Object.keys(result)).toEqual(['status']);
    });
  });

  describe('GET /health/ready', () => {
    async function build(isDatabaseReachable: jest.Mock): Promise<HealthController> {
      const module: TestingModule = await Test.createTestingModule({
        controllers: [HealthController],
        providers: [{ provide: HealthService, useValue: { isDatabaseReachable } }],
      }).compile();
      return module.get<HealthController>(HealthController);
    }

    it('200 { status: "ok" } when the database is reachable (TC-2)', async () => {
      const controller = await build(jest.fn().mockResolvedValue(true));
      const response = fakeResponse();

      const body = await controller.ready(response as never);

      expect(body).toEqual({ status: 'ok' });
      expect(response.status).not.toHaveBeenCalled();
    });

    it('sets 503 and a body with no dependency detail when the database is down (TC-3, TC-4)', async () => {
      const controller = await build(jest.fn().mockResolvedValue(false));
      const response = fakeResponse();

      const body = await controller.ready(response as never);

      expect(response.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
      expect(body).toEqual({ status: 'unavailable' });
      // TC-4: no version, no dependency name, no schema name anywhere in the body.
      expect(JSON.stringify(body)).not.toMatch(/reward_portal|reward_config|postgres|version/i);
    });
  });
});
