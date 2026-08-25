/**
 * T-016 unit-test support — a stand-in for `@/database/database.module`.
 *
 * `crypto.module.spec.ts` substitutes this for the real `DatabaseModule` so that
 * `CryptoModule`'s DI graph can be resolved without dragging in `ConfigModule`.
 * `NestConfigModule.forRoot({ validate })` runs `validateEnv` **synchronously at import
 * time** and calls `process.exit(1)` on an incomplete environment — which, in a Jest worker,
 * means the run dies with no failing test to point at, depending only on which `.env` files
 * happen to exist on the machine.
 *
 * The module exports exactly one thing, the `SEQUELIZE` token, because that is exactly what
 * `CryptoModule`'s providers inject. Anything more would be modelling a dependency the crypto
 * core does not actually have.
 */
import { Module } from '@nestjs/common';
import { SEQUELIZE } from '@/database/sequelize.provider';
import { FakeDb } from './fake-db';
import { blindKeyRow, fieldKeyRow } from './keys';

/**
 * The double the substituted module hands out. Exported so a spec can inspect the statements
 * the registry issued, or reshape `keyRows` before the module is compiled.
 */
export const cryptoModuleFakeDb = new FakeDb();
cryptoModuleFakeDb.keyRows = [fieldKeyRow(), blindKeyRow()];

@Module({
  providers: [{ provide: SEQUELIZE, useValue: cryptoModuleFakeDb.asSequelize() }],
  exports: [SEQUELIZE],
})
export class DatabaseModule {}
