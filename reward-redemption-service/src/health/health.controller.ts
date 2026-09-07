import { Controller, Get, HttpCode, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { DbReachabilityService } from './db-reachability.service';

interface HealthStatus {
  status: 'ok' | 'degraded';
  db: 'reachable' | 'unreachable';
}

/**
 * T-RR-004. `GET /health` — process liveness plus raw DB TCP reachability, deliberately
 * unauthenticated (implementation note 3). Mirrors RAP's own deployed `/health` shape exactly
 * (`04-REST-CONTRACT.md` §4, confirmed live: `{"status":"ok","db":"reachable"}`). Supersedes
 * `AppController`'s trivial T-RR-001 placeholder in place — this controller is now the sole owner
 * of the `/health` route (`app.controller.ts` deleted, not left as a dead duplicate).
 *
 * No Kafka reachability check — `04-REST-CONTRACT.md` §4's own explicit choice: a broker is not
 * assumed to exist in every environment this service runs in (`02-KAFKA-CONTRACTS.md` §4).
 */
@Controller('health')
export class HealthController {
  constructor(private readonly dbReachability: DbReachabilityService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async check(@Res({ passthrough: true }) response: Response): Promise<HealthStatus> {
    const reachable = await this.dbReachability.connect();
    if (!reachable) {
      // Documented here as this task's own reasonable completion of `04-REST-CONTRACT.md` §4,
      // which specifies the success body but not the failure body shape (implementation note 4
      // — flagged as a minor doc gap in the completion report rather than silently improvised
      // without a note).
      response.status(HttpStatus.SERVICE_UNAVAILABLE);
      return { status: 'degraded', db: 'unreachable' };
    }
    return { status: 'ok', db: 'reachable' };
  }
}
