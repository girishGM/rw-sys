import { Controller, Get, HttpCode, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { DbReachabilityService } from './db-reachability.service';

interface HealthStatus {
  status: 'ok' | 'degraded';
  db: 'reachable' | 'unreachable';
}

/**
 * T-RTS-001. `GET /health` — process liveness plus raw DB TCP reachability, deliberately
 * unauthenticated. Mirrors every sibling service's own deployed `/health` shape exactly:
 * `{"status":"ok","db":"reachable"}`.
 *
 * No Kafka reachability check, same explicit choice every sibling service already made — a broker
 * is not assumed to exist in every environment this service runs in.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly dbReachability: DbReachabilityService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async check(@Res({ passthrough: true }) response: Response): Promise<HealthStatus> {
    const reachable = await this.dbReachability.connect();
    if (!reachable) {
      response.status(HttpStatus.SERVICE_UNAVAILABLE);
      return { status: 'degraded', db: 'unreachable' };
    }
    return { status: 'ok', db: 'reachable' };
  }
}
