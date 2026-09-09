import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { connect as netConnect } from 'node:net';
import type { Config } from '@/config/config.schema';

/**
 * Narrow, typed interface (T-RR-004 implementation note 6 / AGENT-PROTOCOL.md R2 — no `any`, no
 * loosely-typed wrapper around a third-party ping library this repo doesn't already depend on).
 * `HealthController` depends on this interface, not the concrete class, so a test can substitute
 * a stand-in without reaching into Node's own `net` module.
 */
export interface DbReachabilityChecker {
  connect(): Promise<boolean>;
}

/** Bounded so `GET /health` never hangs past a short timeout (TC-4). */
const TCP_CONNECT_TIMEOUT_MS = 2000;

/**
 * A raw TCP connect against `DB_HOST`/`DB_PORT` — never an authenticated query, and never even a
 * query through the migration role. `rr_app` (AGENT-PROTOCOL.md R5) may not exist yet at the
 * exact point this endpoint must already be answerable (e.g. immediately after a fresh deploy,
 * before T-RR-003's own migration has run to create that role) — TC-5. This mirrors the
 * distinction `pg_isready` itself draws: it reports a server "accepting connections" even against
 * a rejected login, because the TCP/protocol handshake alone answers "is Postgres up", which is
 * the only claim this check makes.
 */
@Injectable()
export class DbReachabilityService implements DbReachabilityChecker {
  constructor(private readonly config: ConfigService<Config, true>) {}

  connect(): Promise<boolean> {
    const host = this.config.get('DB_HOST', { infer: true });
    const port = this.config.get('DB_PORT', { infer: true });

    return new Promise((resolve) => {
      const socket = netConnect({ host, port, timeout: TCP_CONNECT_TIMEOUT_MS });

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
