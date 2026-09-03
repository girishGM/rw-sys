import { Controller, Get, HttpCode, HttpStatus, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { connect } from 'node:net';
import type { Config } from '@/config/config.schema';

interface HealthStatus {
  status: 'ok' | 'degraded';
  db: 'reachable' | 'unreachable';
}

/**
 * `GET /health` — process liveness plus DB reachability (this task's implementation note 7:
 * "process + DB-reachability status only, no Kafka broker check yet" — Kafka wiring doesn't
 * exist until T-RAP-023/Wave 2, so a "healthy Kafka" field here would be a stub nothing backs).
 *
 * Deliberately a raw TCP handshake against `DB_HOST`/`DB_PORT`, not an authenticated query.
 * `rap_app` (AGENT-PROTOCOL.md R1) is created by T-RAP-002's migration, which this task
 * explicitly does not run (Scope "Out") — a check that required a successful login could never
 * go green between T-RAP-001 landing and T-RAP-002 landing. This mirrors the distinction
 * `pg_isready` itself draws: it reports a server "accepting connections" even against a
 * rejected login, because the TCP/protocol handshake alone answers "is Postgres up", which is
 * the only claim this endpoint makes.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly config: ConfigService<Config, true>) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async check(@Res({ passthrough: true }) response: Response): Promise<HealthStatus> {
    const reachable = await this.isDatabaseReachable();
    if (!reachable) {
      response.status(HttpStatus.SERVICE_UNAVAILABLE);
      return { status: 'degraded', db: 'unreachable' };
    }
    return { status: 'ok', db: 'reachable' };
  }

  private isDatabaseReachable(): Promise<boolean> {
    const host = this.config.get('DB_HOST', { infer: true });
    const port = this.config.get('DB_PORT', { infer: true });

    return new Promise((resolve) => {
      const socket = connect({ host, port, timeout: 1000 });
      const finish = (result: boolean): void => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(result);
      };
      socket.once('connect', () => finish(true));
      socket.once('timeout', () => finish(false));
      socket.once('error', () => finish(false));
    });
  }
}
