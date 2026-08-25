/**
 * T-010 unit-test support — a stand-in for `@/database/database.module`.
 *
 * `auth.module.spec.ts` substitutes this for the real `DatabaseModule` so `AuthModule`'s DI
 * graph can be resolved without dragging in `ConfigModule`. The reason is the same one
 * `test/crypto/support/fake-database.module.ts` documents: `NestConfigModule.forRoot({
 * validate })` runs `validateEnv` **synchronously at import time** and calls
 * `process.exit(1)` on an incomplete environment — in a Jest worker that kills the run with
 * no failing test to point at, depending only on which `.env` files happen to exist on the
 * machine.
 *
 * It exports exactly one thing, the `SEQUELIZE` token, because that is exactly what
 * `CredentialRepository` injects. The `query`/`transaction` stubs are never reached by the
 * module spec, which only resolves the graph; the repository's own behaviour is covered in
 * `credential.repository.spec.ts`.
 */
import { Module } from '@nestjs/common';
import type { Sequelize } from 'sequelize-typescript';
import { SEQUELIZE } from '@/database/sequelize.provider';

const inertSequelize = {
  async query(): Promise<unknown[]> {
    return [];
  },
  async transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    return fn({});
  },
} as unknown as Sequelize;

@Module({
  providers: [{ provide: SEQUELIZE, useValue: inertSequelize }],
  exports: [SEQUELIZE],
})
export class DatabaseModule {}
