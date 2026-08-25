import type { Sequelize } from 'sequelize-typescript';
import { QueryTypes } from 'sequelize';

/**
 * Seeds `reward_config.system_messages` — the error/notice catalogue keyed by code
 * (01-DATABASE.md §5.4/§5.5, gap G7). The API returns only the `code`; the SPA looks up the
 * localised `message_text` from this table client-side, so no internal detail ever escapes
 * a response (02-SECURITY.md, ARCHITECTURE §6 step 12).
 *
 * 01-DATABASE.md §5.4 names five codes explicitly and says "…" for the rest — this seed
 * adds every other code actually named as a literal `code` value somewhere in the design
 * docs (grepped from `project-plan/*.md`, not invented): `PASSWORD_CHANGE_REQUIRED`
 * (02-SECURITY.md), `BUDGET_EXCEEDS_TENANT_CEILING` (03-API-CONTRACT.md,
 * 11-BUDGETS-AND-LIMITS.md), `CANNOT_LOCK_OUT_SUPER_ADMIN`, `ROLE_CREATION_NOT_PERMITTED`,
 * `SELF_APPROVAL_FORBIDDEN` (03-API-CONTRACT.md), `MFA_PENDING` (02-SECURITY.md). Message
 * text is this task's own reasonable wording (the docs give exact text for exactly one,
 * `PERM_DENIED` — 03-API-CONTRACT.md §1 — reused verbatim below); later tasks that need a
 * code not listed here add their own seed migration rather than editing this one.
 *
 * Idempotent via `ON CONFLICT (message_key) DO NOTHING`
 * (`system_messages_message_key_key UNIQUE (message_key)`, confirmed live).
 */

interface MessageRow {
  key: string;
  text: string;
}

export const SYSTEM_MESSAGES: MessageRow[] = [
  {
    key: 'AUTH_INVALID_CREDENTIALS',
    text: 'The email or password you entered is incorrect.',
  },
  {
    key: 'AUTH_ACCOUNT_LOCKED',
    text: 'This account is temporarily locked due to too many failed sign-in attempts. Please try again later.',
  },
  {
    key: 'PASSWORD_CHANGE_REQUIRED',
    text: 'You must change your password before continuing.',
  },
  {
    key: 'MFA_PENDING',
    text: 'Multi-factor authentication is required to complete sign-in.',
  },
  // Exact text from 03-API-CONTRACT.md §1's own worked example.
  {
    key: 'PERM_DENIED',
    text: 'You do not have permission to perform this action.',
  },
  {
    key: 'SCOPE_VIOLATION',
    text: 'The requested resource could not be found.',
  },
  {
    key: 'CAMPAIGN_SUBMITTED',
    text: 'Campaign submitted for approval.',
  },
  {
    key: 'BUDGET_EXCEEDS_TENANT_CEILING',
    text: "This budget exceeds the tenant's configured ceiling for this unit.",
  },
  {
    key: 'CANNOT_LOCK_OUT_SUPER_ADMIN',
    text: 'This action would leave no active Super Admin and cannot be completed.',
  },
  {
    key: 'ROLE_CREATION_NOT_PERMITTED',
    text: 'You are not permitted to create a user with this role.',
  },
  {
    key: 'SELF_APPROVAL_FORBIDDEN',
    text: 'You cannot approve, reject or return a campaign you submitted yourself.',
  },
];

export async function up({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    for (const row of SYSTEM_MESSAGES) {
      await context.query(
        `INSERT INTO reward_config.system_messages (message_key, message_text)
         VALUES (:key, :text)
         ON CONFLICT (message_key) DO NOTHING;`,
        {
          type: QueryTypes.INSERT,
          transaction: t,
          replacements: row as unknown as Record<string, unknown>,
        },
      );
    }
    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

/** Deletes exactly the rows this migration inserted, matched by `message_key` — any code a
 * later task or an operator added is untouched. */
export async function down({ context }: { context: Sequelize }): Promise<void> {
  const t = await context.transaction();
  try {
    for (const row of SYSTEM_MESSAGES) {
      await context.query(`DELETE FROM reward_config.system_messages WHERE message_key = :key;`, {
        type: QueryTypes.RAW,
        transaction: t,
        replacements: { key: row.key },
      });
    }
    await t.commit();
  } catch (err) {
    await t.rollback();
    throw err;
  }
}
