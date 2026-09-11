/**
 * T-INT-054. Proves `app.module.ts`'s own `ACTIVITY_INGEST_REST_ENABLED` gate actually changes
 * `AppModule`'s module graph, both ways — a pure metadata check (`Reflect.getMetadata('imports', ...)`,
 * the same reflection NestJS's own `@Module` decorator writes to and its dependency-injection
 * container later reads from), not a full `NestFactory.create()` boot, so this test carries none of
 * the singleton-registry risk a full DI-container rebuild across a `jest.resetModules()` boundary
 * would (see `activity-ingest-rest.e2e-spec.ts`'s own header for why that full-boot approach was
 * deliberately NOT used here).
 *
 * `jest.resetModules()` + a fresh `require('@/app.module')` is required because `app.module.ts`
 * reads `process.env.ACTIVITY_INGEST_REST_ENABLED` exactly once, at the file's own first-import
 * time (its `@Module` decorator's `imports` array literal) — a `process.env` write after that point
 * has no effect on an already-evaluated class, the same "this project's own established ordering
 * constraint" `test/health.e2e-spec.ts`'s own header already documents for the analogous
 * `ConfigModule`/`NestConfigModule.forRoot` case.
 */
import 'reflect-metadata';

const APP_MODULE_PATH = '@/app.module';
const ACTIVITY_INGEST_REST_MODULE_PATH = '@/rest/activity-ingest/activity-ingest-rest.module';
const ORIGINAL_ENV = process.env.ACTIVITY_INGEST_REST_ENABLED;

afterEach(() => {
  if (ORIGINAL_ENV === undefined) {
    delete process.env.ACTIVITY_INGEST_REST_ENABLED;
  } else {
    process.env.ACTIVITY_INGEST_REST_ENABLED = ORIGINAL_ENV;
  }
  jest.resetModules();
});

/**
 * Re-requires BOTH `AppModule` and `ActivityIngestRestModule` fresh, from the SAME
 * `jest.resetModules()` registry snapshot — comparing a freshly re-required `AppModule`'s own
 * `imports` array against a STATICALLY imported (i.e. pre-reset, different object identity)
 * `ActivityIngestRestModule` class reference would never match even when the gate is correctly
 * "on", since `jest.resetModules()` gives every path a brand-new module instance.
 */
function loadFresh(): { AppModule: unknown; ActivityIngestRestModule: unknown } {
  jest.resetModules();
  return {
    // T-INT-054: deliberate dynamic re-require (see this file's own header) — a static import
    // cannot observe a process.env change made after Jest hoists it.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    AppModule: require(APP_MODULE_PATH).AppModule,
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ActivityIngestRestModule: require(ACTIVITY_INGEST_REST_MODULE_PATH).ActivityIngestRestModule,
  };
}

describe('T-INT-054 — AppModule ACTIVITY_INGEST_REST_ENABLED gate', () => {
  it("unset (this repo's own default): ActivityIngestRestModule is NOT part of the module graph", () => {
    delete process.env.ACTIVITY_INGEST_REST_ENABLED;
    const { AppModule, ActivityIngestRestModule } = loadFresh();

    const imports = Reflect.getMetadata('imports', AppModule as object) as unknown[];
    expect(imports).not.toContain(ActivityIngestRestModule);
  });

  it('"false": ActivityIngestRestModule is NOT part of the module graph', () => {
    process.env.ACTIVITY_INGEST_REST_ENABLED = 'false';
    const { AppModule, ActivityIngestRestModule } = loadFresh();

    const imports = Reflect.getMetadata('imports', AppModule as object) as unknown[];
    expect(imports).not.toContain(ActivityIngestRestModule);
  });

  it('"true": ActivityIngestRestModule IS part of the module graph', () => {
    process.env.ACTIVITY_INGEST_REST_ENABLED = 'true';
    const { AppModule, ActivityIngestRestModule } = loadFresh();

    const imports = Reflect.getMetadata('imports', AppModule as object) as unknown[];
    expect(imports).toContain(ActivityIngestRestModule);
  });
});
