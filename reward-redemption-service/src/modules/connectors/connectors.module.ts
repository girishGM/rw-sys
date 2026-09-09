/**
 * T-RR-030. Exposes `ConnectorRegistry` for T-RR-031/T-RR-032's own connector modules to import
 * and populate (each calling `register()` from its own module's `onModuleInit`, implementation
 * note 3) and for the pipeline (Wave 2) to import and query.
 *
 * Not wired into `AppModule` by this task — the same "registration into `AppModule` is the
 * eventual real-caller's own job" convention `DispatchModule`'s own header already documents
 * (`src/modules/dispatch/dispatch.module.ts`): `AppModule` is not in this task's "Files owned"
 * list (R3), and neither connector implementation exists yet for this registry to usefully serve
 * requests through. Wiring `ConnectorsModule` into `AppModule` alongside a real connector's own
 * module is a follow-on concern for whichever of T-RR-031/T-RR-032 lands first, or the task that
 * next wires the pipeline's own resolution step to call through this registry for real.
 */
import { Module } from '@nestjs/common';
import { ConnectorRegistry } from './connector-registry';

@Module({
  providers: [ConnectorRegistry],
  exports: [ConnectorRegistry],
})
export class ConnectorsModule {}
