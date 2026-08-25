/**
 * T-047 — the lifecycle object that owns the internal socket: reads configuration, binds the
 * handlers, listens, and closes on shutdown.
 *
 * ### Why the listener is started from a provider rather than from `main.ts`
 *
 * `main.ts` is a shared registration point every task appends to, and this listener needs the DI
 * container (the controllers it registers are providers). Starting it from
 * `onApplicationBootstrap` keeps the whole of the internal surface — port, certificates, handlers,
 * shutdown — in one place, so "what is listening on 50051?" is answered by reading one file.
 * `main.ts` is untouched by this task.
 *
 * ### Why it lives here and not in `grpc.module.ts`
 *
 * `grpc.module.ts` imports `AuditModule → DatabaseModule → ConfigModule`, whose `validate` runs at
 * **import** time and calls `process.exit(1)` on an incomplete environment — the same hazard
 * `jest.config.js` already documents for `data-protection.module.ts`, `transport-crypto.module.ts`
 * and `tracing.module.ts`. A Jest worker that imports it dies, so nothing in that file can be unit
 * tested. This class is exactly the part that *must* be: it decides whether an mTLS port opens at
 * all and whether a missing CA fails the boot, and `test/grpc/bootstrap.spec.ts` asserts both.
 *
 * ### Disabled by default, and that is the rollback plan
 *
 * The task file's Rollback section: *"Disable the gRPC listener via config. The REST portal is
 * unaffected; the runtime falls back to its cache and then fails closed."* `GRPC_ENABLED` is that
 * switch, and it defaults to **off**: a deployment that has not been given certificates must not
 * open an mTLS port it cannot authenticate anyone on, and every environment that predates this
 * task — including every developer's machine and the e2e suite — must keep booting unchanged.
 *
 * When it *is* enabled, missing certificate material is a **boot failure**, not a warning
 * (02-SECURITY.md §9: no silent defaults for security values). A listener that came up without a
 * CA to validate clients against would accept anyone, which is worse than not coming up.
 */
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'node:fs';
import type { Env } from '@/config/env.schema';
import {
  CLIENT_CACHE_TTL_SECONDS,
  GRPC_DEFAULT_PORT,
  GRPC_SERVICE_FULL_NAME,
  TTL_HEADER,
} from './grpc.constants';
import { CampaignConfigController } from './campaign-config.controller';
import { BudgetBreachController } from './budget-breach.controller';
import { InternalTlsListener } from './wire/grpc-http2.server';

@Injectable()
export class InternalServiceBootstrap implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('InternalServiceBootstrap');
  private listener: InternalTlsListener | null = null;

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly campaignConfig: CampaignConfigController,
    private readonly budgetBreach: BudgetBreachController,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.get('GRPC_ENABLED', { infer: true }) !== true) {
      this.logger.log('internal configuration service is disabled (GRPC_ENABLED is not "true")');
      return;
    }
    const listener = this.build();
    await listener.listen();
    this.listener = listener;
    this.logger.log(
      `internal configuration service listening on ${listener.address()} (mTLS, read-only)`,
    );
  }

  async onApplicationShutdown(): Promise<void> {
    await this.listener?.close();
    this.listener = null;
  }

  /** The configured listener, handlers bound, **not** listening. Exposed for the e2e suite. */
  build(overrides: { port?: number; host?: string } = {}): InternalTlsListener {
    const listener = new InternalTlsListener(GRPC_SERVICE_FULL_NAME, {
      port: overrides.port ?? this.config.get('GRPC_PORT', { infer: true }) ?? GRPC_DEFAULT_PORT,
      // Bound to the internal network only, never internet-facing (§7). The default is loopback
      // rather than `0.0.0.0`: a deployment must *choose* to widen it.
      host: overrides.host ?? this.config.get('GRPC_HOST', { infer: true }) ?? '127.0.0.1',
      key: requiredFile(this.config.get('GRPC_TLS_KEY_PATH', { infer: true }), 'GRPC_TLS_KEY_PATH'),
      cert: requiredFile(
        this.config.get('GRPC_TLS_CERT_PATH', { infer: true }),
        'GRPC_TLS_CERT_PATH',
      ),
      ca: requiredFile(this.config.get('GRPC_TLS_CA_PATH', { infer: true }), 'GRPC_TLS_CA_PATH'),
      // §8: the client TTL is part of the contract, not of this process's configuration. Serving
      // it on every response means an operator can see the number without reading a document.
      responseHeaders: { [TTL_HEADER]: String(CLIENT_CACHE_TTL_SECONDS) },
      onError: (message, error) => this.logger.warn(`${message}: ${String(error)}`),
    });

    this.campaignConfig.register(listener);
    this.budgetBreach.register(listener);
    return listener;
  }
}

/** Reads a required PEM file, or fails the boot naming the variable. */
function requiredFile(path: string | undefined, variable: string): Buffer {
  if (path === undefined || path.trim() === '') {
    throw new Error(
      `${variable} is required when GRPC_ENABLED is true — the internal service will not start ` +
        'without mutual-TLS material (02-SECURITY.md §9: no silent defaults for security values).',
    );
  }
  return readFileSync(path);
}
