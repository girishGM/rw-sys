/**
 * T-PC-010. Append-only writes to `promo_code.promo_code_config_audit` (`01-DATABASE.md` §5).
 * `changed_fields` is diff-shaped — only old/new pairs for fields actually touched, never a
 * full row snapshot (implementation note 5) — the diff itself is computed by the service layer
 * (`promo-code-config.service.ts`), this repository only persists whatever diff it's handed.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Sequelize } from 'sequelize-typescript';
import type { Transaction } from 'sequelize';
import { QueryTypes } from 'sequelize';
import { PROMO_CODE_SEQUELIZE } from './promo-code-config.constants';

export type AuditAction = 'CREATE' | 'UPDATE' | 'ARCHIVE';

export type ChangedFields = Record<string, { old: unknown; new: unknown }>;

export interface AuditEntry {
  promoCodeConfigId: string;
  action: AuditAction;
  changedFields: ChangedFields;
  changedBy: string;
}

interface AuditRow {
  id: string;
  promo_code_config_id: string;
  action: AuditAction;
  changed_fields: ChangedFields;
  changed_by: string;
  changed_at: Date;
}

@Injectable()
export class PromoCodeConfigAuditRepository {
  constructor(@Inject(PROMO_CODE_SEQUELIZE) private readonly sequelize: Sequelize) {}

  async record(entry: AuditEntry, options: { transaction?: Transaction } = {}): Promise<void> {
    await this.sequelize.query(
      `INSERT INTO promo_code.promo_code_config_audit
         (promo_code_config_id, action, changed_fields, changed_by)
       VALUES (:promoCodeConfigId, :action, :changedFields, :changedBy)`,
      {
        type: QueryTypes.RAW,
        replacements: {
          promoCodeConfigId: entry.promoCodeConfigId,
          action: entry.action,
          changedFields: JSON.stringify(entry.changedFields),
          changedBy: entry.changedBy,
        },
        transaction: options.transaction,
      },
    );
  }

  /** Test/read helper — not part of any REST-facing contract, used to assert TC-14's "exactly one row per action" property against the real table. */
  async listForConfig(
    promoCodeConfigId: string,
  ): Promise<Array<{ action: AuditAction; changedFields: ChangedFields; changedBy: string }>> {
    const rows = await this.sequelize.query<AuditRow>(
      `SELECT * FROM promo_code.promo_code_config_audit
         WHERE promo_code_config_id = :promoCodeConfigId
         ORDER BY changed_at ASC`,
      { type: QueryTypes.SELECT, replacements: { promoCodeConfigId } },
    );
    return rows.map((row) => ({
      action: row.action,
      changedFields: row.changed_fields,
      changedBy: row.changed_by,
    }));
  }
}
