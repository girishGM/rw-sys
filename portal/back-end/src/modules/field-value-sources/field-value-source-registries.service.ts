/**
 * T-121 — the two field value-source registries (`13-REWARD-MASTER-VALUE-SOURCES.md` §3).
 *
 * Reads go through `ScopedRepository.listAll` (R2), not a raw `Model.findAll`. These are
 * Super-Admin-owned, seed-managed reference data with no tenant column at all — the same shape
 * `RuleRegistriesService` (T-108) documents — so their scope strategies are `unrestricted()` and
 * every authenticated role sees the same rows. That is deliberate: every role needs to read these
 * to render a value-source dropdown.
 *
 * Writes are `super_admin` only, enforced twice: `@RequirePermission` on the controller (layer 1,
 * the runtime permission table seeded by `T121_002`) and `assertRole` here (layer 2, in the
 * service, so a future caller that reaches this method by any other route is still refused). The
 * same belt-and-braces pattern `RulesService.createCategory` uses.
 */
import { Inject, Injectable } from '@nestjs/common';
import { UniqueConstraintError } from 'sequelize';
import type { Sequelize } from 'sequelize-typescript';
import { FieldApiLookupProvider, FieldContextProvider } from '@/database/models';
import { ScopedRepository } from '@/common/scope/scoped.repository';
import { assertRole } from '@/common/rbac/assert-role';
import { AuditService } from '@/common/audit/audit.service';
import { SEQUELIZE } from '@/database/sequelize.provider';
import type { AuthenticatedUser } from '@/modules/auth/decorators/current-user.decorator';
import { FieldApiLookupConfigCrypto } from './field-api-lookup-config.crypto';
import {
  FieldApiLookupProviderCodeExistsError,
  FieldContextProviderCodeExistsError,
} from './field-value-sources.errors';
import type { CreateFieldApiLookupProviderDto } from './dto/create-field-api-lookup-provider.dto';
import type { CreateFieldContextProviderDto } from './dto/create-field-context-provider.dto';
import type { UpdateFieldApiLookupProviderDto } from './dto/update-field-api-lookup-provider.dto';
import type { UpdateFieldContextProviderDto } from './dto/update-field-context-provider.dto';
import {
  toFieldApiLookupProviderDto,
  toFieldContextProviderDto,
  type FieldApiLookupProviderDto,
  type FieldContextProviderDto,
} from './dto/field-value-source-response.dto';

@Injectable()
export class FieldValueSourceRegistriesService {
  constructor(
    private readonly scoped: ScopedRepository,
    private readonly authConfigCrypto: FieldApiLookupConfigCrypto,
    private readonly audit: AuditService,
    @Inject(SEQUELIZE) private readonly sequelize: Sequelize,
  ) {}

  // === Context providers =====================================================================

  async listContextProviders(): Promise<FieldContextProviderDto[]> {
    const rows = await this.scoped.listAll(FieldContextProvider, { order: [['name', 'ASC']] });
    return rows.map(toFieldContextProviderDto);
  }

  async createContextProvider(
    actor: AuthenticatedUser,
    dto: CreateFieldContextProviderDto,
  ): Promise<FieldContextProviderDto> {
    assertRole(actor, 'super_admin');

    // Checked first for a clean 409, and caught again below: the pre-check races with a concurrent
    // insert, so the unique constraint stays the real authority. Same reasoning
    // `RulesService.createCategory` documents.
    const duplicates = await this.scoped.count(FieldContextProvider, {
      where: { providerCode: dto.providerCode },
    });
    if (duplicates > 0) throw new FieldContextProviderCodeExistsError();

    let created: FieldContextProvider;
    try {
      created = await this.scoped.create(FieldContextProvider, {
        providerCode: dto.providerCode,
        name: dto.name.trim(),
        description: dto.description?.trim() ?? null,
        status: 'active',
      } as never);
    } catch (error) {
      if (error instanceof UniqueConstraintError) {
        throw new FieldContextProviderCodeExistsError({ cause: error });
      }
      throw error;
    }

    this.audit.annotate({ targetId: created.id, detail: { providerCode: created.providerCode } });
    return toFieldContextProviderDto(created);
  }

  async updateContextProvider(
    actor: AuthenticatedUser,
    id: number,
    dto: UpdateFieldContextProviderDto,
  ): Promise<FieldContextProviderDto> {
    assertRole(actor, 'super_admin');

    await this.scoped.findByPkOrFail(FieldContextProvider, id);

    const changes: Partial<FieldContextProvider> = {};
    if (dto.name !== undefined) changes.name = dto.name.trim();
    if (dto.description !== undefined) changes.description = dto.description.trim();
    if (dto.status !== undefined) changes.status = dto.status;

    if (Object.keys(changes).length > 0) {
      await this.scoped.update(FieldContextProvider, changes, { where: { id } });
    }

    const after = await this.scoped.findByPkOrFail(FieldContextProvider, id);
    this.audit.annotate({ targetId: id, detail: { changes } });
    return toFieldContextProviderDto(after);
  }

  // === API lookup providers ==================================================================

  async listApiLookupProviders(): Promise<FieldApiLookupProviderDto[]> {
    const rows = await this.scoped.listAll(FieldApiLookupProvider, { order: [['name', 'ASC']] });
    return rows.map(toFieldApiLookupProviderDto);
  }

  /**
   * `POST /field-api-lookup-providers`.
   *
   * The two-phase encrypt/insert/rebind dance exists because `FieldCryptoService` binds the row's
   * identity into the ciphertext as AAD and `id` is only known after the `INSERT` — see
   * `field-api-lookup-config.crypto.ts`'s header. Both statements run in one transaction, so a
   * failure between them cannot leave a row whose ciphertext is bound to the provisional AAD and
   * therefore undecryptable forever.
   */
  async createApiLookupProvider(
    actor: AuthenticatedUser,
    dto: CreateFieldApiLookupProviderDto,
  ): Promise<FieldApiLookupProviderDto> {
    assertRole(actor, 'super_admin');

    const duplicates = await this.scoped.count(FieldApiLookupProvider, {
      where: { providerCode: dto.providerCode },
    });
    if (duplicates > 0) throw new FieldApiLookupProviderCodeExistsError();

    const created = await this.sequelize
      .transaction(async (transaction) => {
        const row = await this.scoped.create(
          FieldApiLookupProvider,
          {
            providerCode: dto.providerCode,
            name: dto.name.trim(),
            description: dto.description?.trim() ?? null,
            endpointUrl: dto.endpointUrl.trim(),
            httpMethod: dto.httpMethod ?? 'GET',
            authType: dto.authType ?? 'none',
            authConfigEnc: this.authConfigCrypto.encryptForNewRow(dto.authConfig),
            responseValueKey: dto.responseValueKey.trim(),
            responseLabelKey: dto.responseLabelKey.trim(),
            // Defaults to `planned`, not `active` — a provider nobody has confirmed must make
            // T-123 decline rather than call an unverified endpoint. See the DTO header.
            status: dto.status ?? 'planned',
          } as never,
          { transaction },
        );

        // Only when there is actually a credential to rebind. `rebindToRow` returns null for a
        // null input, so the guard is about avoiding a pointless UPDATE, not about correctness.
        if (row.authConfigEnc !== null) {
          const rebound = this.authConfigCrypto.rebindToRow(row.id, row.authConfigEnc);
          await this.scoped.update(FieldApiLookupProvider, { authConfigEnc: rebound } as never, {
            where: { id: row.id },
            transaction,
          });
          row.authConfigEnc = rebound;
        }

        return row;
      })
      .catch((error: unknown) => {
        if (error instanceof UniqueConstraintError) {
          throw new FieldApiLookupProviderCodeExistsError({ cause: error });
        }
        throw error;
      });

    // `providerCode` only — never `authConfig`, which would put a plaintext credential into the
    // audit trail, a store with a longer retention and a wider read audience than the row itself.
    this.audit.annotate({ targetId: created.id, detail: { providerCode: created.providerCode } });
    return toFieldApiLookupProviderDto(created);
  }

  /**
   * `PATCH /field-api-lookup-providers/:id`. The row already has an id, so a supplied `authConfig`
   * is encrypted directly under the real AAD — no rebind phase, and therefore no transaction
   * needed here.
   */
  async updateApiLookupProvider(
    actor: AuthenticatedUser,
    id: number,
    dto: UpdateFieldApiLookupProviderDto,
  ): Promise<FieldApiLookupProviderDto> {
    assertRole(actor, 'super_admin');

    await this.scoped.findByPkOrFail(FieldApiLookupProvider, id);

    const changes: Partial<FieldApiLookupProvider> = {};
    if (dto.name !== undefined) changes.name = dto.name.trim();
    if (dto.description !== undefined) changes.description = dto.description.trim();
    if (dto.endpointUrl !== undefined) changes.endpointUrl = dto.endpointUrl.trim();
    if (dto.httpMethod !== undefined) changes.httpMethod = dto.httpMethod;
    if (dto.authType !== undefined) changes.authType = dto.authType;
    if (dto.responseValueKey !== undefined) changes.responseValueKey = dto.responseValueKey.trim();
    if (dto.responseLabelKey !== undefined) changes.responseLabelKey = dto.responseLabelKey.trim();
    if (dto.status !== undefined) changes.status = dto.status;
    if (dto.authConfig !== undefined) {
      changes.authConfigEnc = this.authConfigCrypto.encryptForRow(id, dto.authConfig);
    }

    if (Object.keys(changes).length > 0) {
      await this.scoped.update(FieldApiLookupProvider, changes, { where: { id } });
    }

    const after = await this.scoped.findByPkOrFail(FieldApiLookupProvider, id);

    // The audit detail lists *which* fields changed, never their values — `authConfigEnc` would
    // otherwise put ciphertext (and a clear "a credential was set here" signal) into the trail.
    this.audit.annotate({ targetId: id, detail: { changedFields: Object.keys(changes) } });
    return toFieldApiLookupProviderDto(after);
  }

  /**
   * Decrypts a provider's stored credential. **Not reachable over HTTP** — no controller calls
   * this, and no response DTO carries its result. It exists for T-123, which needs the credential
   * in-process to sign an outbound lookup request.
   *
   * Returns `null` when the provider has no credential stored, or when the stored ciphertext fails
   * authentication (tampered, or bound to a different row). A caller must treat `null` as "this
   * provider cannot be used" rather than "no auth required" — the two are indistinguishable here
   * on purpose, and declining the lookup is the safe direction to fail.
   *
   * A provider id that does not exist **throws** `ScopeViolationError` (surfacing as a 404) rather
   * than returning `null`, via `findByPkOrFail`. That is the deliberate distinction: "no such
   * provider" is a caller bug, while "provider exists, no usable credential" is an ordinary state
   * T-123 must handle. `findByPkOrFail` is also the accessor R2's lint rule leaves available —
   * `ScopedRepository.findByPk` is itself caught by the `findByPk` selector, the same known
   * consequence that made `listAll` exist as an alias for `findAll` (see `scoped.repository.ts`).
   * Reaching for an `eslint-disable` here would violate R2's "do not disable this rule".
   */
  async getAuthConfigForLookup(id: number): Promise<Record<string, unknown> | null> {
    const row = await this.scoped.findByPkOrFail(FieldApiLookupProvider, id);
    return this.authConfigCrypto.decryptForRow(row.id, row.authConfigEnc);
  }
}
