/**
 * T-016 — the crypto core, wired for DI.
 *
 * **Not imported by `AppModule`, deliberately.** `KeyRegistryService.onModuleInit()` fails
 * the boot when the key registry is unusable (TC-11, TC-12), which is exactly right for a
 * process that is about to encrypt something — and exactly wrong for one that isn't. So this
 * module is imported by its consumers (T-017's policy engine, T-018's transport encryption,
 * T-010's credential flows) rather than being switched on globally, and `AppModule`'s
 * append-only import list is left untouched until a task actually needs crypto. That also
 * keeps `app.module.ts`, which T-016 does not own, out of this task's diff (R9).
 *
 * The resolver list is a provider rather than a hard-coded array so a deployment can supply
 * a real KMS client without editing this file. `UnconfiguredKmsResolver` is registered on
 * purpose: a `kms:` key_ref with no resolver must fail loudly at boot, not fall back to an
 * environment variable that the deployment specifically chose not to use.
 */
import { Module } from '@nestjs/common';
import { DatabaseModule } from '@/database/database.module';
import { BlindIndexService } from './blind-index.service';
import { FieldCryptoService } from './field-crypto.service';
import {
  EnvKeyMaterialResolver,
  KEY_MATERIAL_RESOLVERS,
  type KeyMaterialResolver,
  UnconfiguredKmsResolver,
} from './key-material.resolver';
import { KeyRegistryService } from './key-registry.service';
import { RotateKeysCommand } from './rotate-keys.command';

export const keyMaterialResolversProvider = {
  provide: KEY_MATERIAL_RESOLVERS,
  useFactory: (): readonly KeyMaterialResolver[] => [
    new EnvKeyMaterialResolver(),
    new UnconfiguredKmsResolver(),
  ],
};

@Module({
  imports: [DatabaseModule],
  providers: [
    keyMaterialResolversProvider,
    KeyRegistryService,
    FieldCryptoService,
    BlindIndexService,
    RotateKeysCommand,
  ],
  exports: [KeyRegistryService, FieldCryptoService, BlindIndexService, RotateKeysCommand],
})
export class CryptoModule {}
