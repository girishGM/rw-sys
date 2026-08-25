/**
 * T-003 unit-test support — builds a `Sequelize` instance with every `reward_portal` and
 * `reward_config` model registered (mirroring `sequelize.provider.ts`'s `models:` array)
 * but **never connects**: no `.authenticate()`/`.sync()`/query is ever called against it.
 * `sequelize-typescript`'s `addModels()` (invoked by the constructor's `models:` option)
 * runs the model layer's own definition-time code — `@Table`/`@Column`/`@ForeignKey`/
 * `@BelongsTo`/`@DefaultScope` decorators, association wiring, scope registration — for
 * real, the same code path production boots through, just without a live socket. Model
 * instances built from the result (`Model.build(...)`) exercise getters/setters exactly as
 * a real row would, entirely in memory.
 *
 * Deliberately lives under `src/database/models/` (not `test/`) so it participates in the
 * `test:cov` unit run (`jest.config.js`'s `rootDir: 'src'` / `testRegex: '.*\.spec\.ts$'`
 * never collects anything under `test/` — see prior T-003 report's documented convention).
 */
import { Sequelize } from 'sequelize-typescript';
import { PORTAL_MODELS } from '../portal-models';
import { REWARD_CONFIG_MODELS } from './index';

let cached: Sequelize | undefined;

/**
 * Returns a shared, never-connected `Sequelize` instance with the full production model
 * set registered. Cached across calls within a test file — model registration itself is
 * pure/definition-time work with no per-test state, and Sequelize does not support
 * re-registering the same model class on a second instance cleanly.
 */
export function buildTestSequelize(): Sequelize {
  if (!cached) {
    cached = new Sequelize({
      dialect: 'postgres',
      host: 'unit-test-no-connection',
      port: 5432,
      database: 'unit-test-no-connection',
      username: 'unit-test-no-connection',
      password: 'unit-test-no-connection',
      logging: false,
      define: { underscored: true, timestamps: true },
      models: [...PORTAL_MODELS, ...REWARD_CONFIG_MODELS],
    });
  }
  return cached;
}
