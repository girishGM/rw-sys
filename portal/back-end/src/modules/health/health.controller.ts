import { Controller, Get, HttpCode, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '@/modules/auth/decorators/public.decorator';
import { HealthService } from './health.service';

/**
 * `GET /health` — liveness only, no dependency check, no version, no schema name
 * (03-API-CONTRACT.md §14, T-001 TC-6/verification steps 6-7). Unchanged since T-001/T-013;
 * still the minimal "the process is up" answer a load balancer or orchestrator restarts a
 * container on the absence of.
 *
 * `GET /health/ready` — **T-052**. The presence-of-a-dependency question `/health` was
 * always going to defer once `DatabaseModule` existed (T-001's own comment, replaced by this
 * one, said exactly that). 200 when `HealthService.isDatabaseReachable()` says the database
 * answers; **503**, not 500, when it does not — 503 is the status a load balancer or
 * orchestrator already knows means "take this instance out of rotation, try again later",
 * where a 500 would read as an application bug. Same non-disclosure rule as `/health`: the
 * body never carries the reason, the driver's error message, or anything that names a schema
 * or a dependency (03-API-CONTRACT.md §14) — see `HealthService`'s header for where that
 * detail is deliberately swallowed.
 *
 * `@Public()` on both — every route is authenticated by default once `RbacModule` registers
 * its guards globally (00-ARCHITECTURE.md §6), and 03-API-CONTRACT.md §15 lists both health
 * routes in the closed set of public ones. An orchestrator's probe carries no session cookie;
 * without this decorator both routes would 401 and every probe would read as "unhealthy".
 */
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  @Public()
  @HttpCode(HttpStatus.OK)
  check(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  @Public()
  async ready(@Res({ passthrough: true }) response: Response): Promise<{ status: string }> {
    const reachable = await this.health.isDatabaseReachable();
    if (!reachable) {
      response.status(HttpStatus.SERVICE_UNAVAILABLE);
      return { status: 'unavailable' };
    }
    return { status: 'ok' };
  }
}
