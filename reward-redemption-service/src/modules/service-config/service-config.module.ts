/**
 * T-RR-006. Wires `ServiceConfigRepository` and `ServiceConfigResolverService` so later
 * tasks (T-RR-007's cache wrapper, and every Wave 2+ task reading a configurable knob) can import
 * this module directly.
 *
 * **Not wired into `AppModule` by this task** — same convention `ClaimWorkerModule` (T-RR-020) and
 * `EncryptionModule` (T-RR-005, before it registered itself) already documented: `AppModule` isn't
 * in this task's own "Files owned" list (R3 — don't edit another task's owned files), and nothing
 * transport-facing consumes this resolver yet until T-RR-007 wraps it with a cache.
 *
 * No dedicated shutdown hook class is needed here (unlike some of RAP's own sibling modules):
 * `ServiceConfigRepository` implements `OnModuleDestroy` itself, and Nest calls that lifecycle
 * hook on any provider that implements it — same precedent `EncryptionModule`'s own
 * `FieldEncryptionConfigRepository` provider already relies on.
 */
import { Module } from '@nestjs/common';
import { ServiceConfigResolverService } from './service-config-resolver.service';
import { ServiceConfigRepository } from './service-config.repository';

@Module({
  providers: [ServiceConfigRepository, ServiceConfigResolverService],
  exports: [ServiceConfigRepository, ServiceConfigResolverService],
})
export class ServiceConfigModule {}
