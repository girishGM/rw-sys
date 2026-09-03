/**
 * T-RAP-012. `LogRedactor` — config-driven, first-match-wins resolution of "must this field be
 * redacted before it appears in a log line" (`06-CONFIGURABILITY-AND-OBSERVABILITY.md` §1), read
 * from `field_encryption_config` (`01-DATABASE.md` §10) via `FieldEncryptionConfigRepository`.
 *
 * **Out of this task's scope:** wiring this into every actual log call site — each later task
 * that logs customer-adjacent data calls `redact`/`resolve` itself, per its own module's needs.
 *
 * The in-memory rule map is (re)built by `refresh()`, called once at process start
 * (`onModuleInit`) and re-callable by whatever cache-refresh trigger T-RAP-011 wires up later
 * (same "piggybacks on the same refresh trigger as campaign config" trigger this task's own spec
 * describes) — this task only builds and tests the hook itself, not that trigger.
 */
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { ConfigScopeLevel } from '@/database/models/field-encryption-config.model';
import { FieldEncryptionConfigRepository } from './field-encryption-config.repository';

export interface LogRedactorContext {
  campaignCode?: string;
  tenantId?: number;
  countryCode?: string;
}

function placeholderFor(fieldName: string): string {
  return `[REDACTED:${fieldName}]`;
}

function ruleKey(scopeLevel: ConfigScopeLevel, scopeRef: string | null, fieldName: string): string {
  return `${scopeLevel}::${scopeRef ?? ''}::${fieldName}`;
}

@Injectable()
export class LogRedactorService implements OnModuleInit {
  private readonly logger = new Logger(LogRedactorService.name);
  private rules = new Map<string, boolean>();

  constructor(private readonly repository: FieldEncryptionConfigRepository) {}

  async onModuleInit(): Promise<void> {
    await this.refresh();
  }

  /** Reloads the in-memory rule set from `field_encryption_config` in full — a small, config-sized
   * table (never per-tenant/per-activity scaled), so a full reload is simpler and cheap enough to
   * not need an incremental diff. */
  async refresh(): Promise<void> {
    const rows = await this.repository.findAll();
    const next = new Map<string, boolean>();
    for (const row of rows) {
      next.set(ruleKey(row.scope_level, row.scope_ref, row.field_name), row.is_encrypted);
    }
    this.rules = next;
    this.logger.log(`field_encryption_config reloaded: ${next.size} rule(s)`);
  }

  /**
   * First-match-wins precedence, exactly `06-CONFIGURABILITY-AND-OBSERVABILITY.md` §1's order:
   * campaign-scoped → tenant-scoped → country-scoped → global. Degrades gracefully when part of
   * `context` is unavailable (implementation note 4) — a level with no context value to check is
   * simply skipped, falling through to the next. Defaults to `false` (not sensitive) when nothing
   * matches at any level: only fields explicitly marked sensitive are ever redacted.
   */
  resolve(fieldName: string, context: LogRedactorContext = {}): boolean {
    if (context.campaignCode !== undefined) {
      const match = this.rules.get(ruleKey('campaign', context.campaignCode, fieldName));
      if (match !== undefined) {
        return match;
      }
    }
    if (context.tenantId !== undefined) {
      const match = this.rules.get(ruleKey('tenant', String(context.tenantId), fieldName));
      if (match !== undefined) {
        return match;
      }
    }
    if (context.countryCode !== undefined) {
      const match = this.rules.get(ruleKey('country', context.countryCode, fieldName));
      if (match !== undefined) {
        return match;
      }
    }
    return this.rules.get(ruleKey('global', null, fieldName)) ?? false;
  }

  /**
   * Applies `resolve` and returns either `value` unchanged or a fixed placeholder token — **never
   * the ciphertext** (`06-CONFIGURABILITY-AND-OBSERVABILITY.md` §1's explicit reasoning:
   * ciphertext in a log line is still a correlation risk to anyone with log access). Callers must
   * never pass `correlationId` here — `05-PROCESSING-PIPELINE.md` §1's own "never redacted, in
   * logs or anywhere else" is a caller-side rule this generic method has no way to special-case
   * for one literal field name.
   */
  redact(fieldName: string, value: string, context: LogRedactorContext = {}): string {
    return this.resolve(fieldName, context) ? placeholderFor(fieldName) : value;
  }
}
