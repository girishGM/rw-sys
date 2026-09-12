/**
 * T-RAP-064 (Phase 2). The one resolver actually seeded on the portal today
 * (`rule_resolvers[5] = SCHEDULE_CONTEXT`, diagnosis doc §3 row set B) — makes
 * `RULE_ACTIVITY_WINDOW_001` (`rule_master.expression = "currentTime within the :windowType
 * window"`) evaluate for real, instead of Phase 1's (`T-RAP-063`) safe-but-inert "unresolved"
 * fallback.
 *
 * **Dispatch is by expression shape, not by `resolver_id`** — see `rule-resolver.interface.ts`'s
 * own header for why the wire doesn't carry `resolver_id`/`resolver_config` to this codebase yet.
 * `canHandle()` recognizes the literal `"<field> within the :windowType window"` template shape;
 * `resolve()` maps the captured `<field>` token to a known `activity_logs` column (today, only
 * `currentTime` → `activity_performed_date`) and reads `windowType`/`windowStart`/`windowEnd` out
 * of `rule.boundValuesJson` — already on the wire, no `resolverConfig` needed for this one case.
 *
 * **Only `windowType: "DAILY_HOURS"` is implemented** — the one value confirmed live (diagnosis
 * doc §3). Per this task's own scope note ("don't invent behavior for a `windowType` value never
 * actually seen; escalate if the full enum isn't documented anywhere retrievable"), any other
 * `windowType` — or a missing/malformed one — is reported as `resolved: false`, never guessed.
 *
 * **Timezone**: `05-PROCESSING-PIPELINE.md` documents no per-rule timezone convention for this
 * new resolver type (it predates this task), and `BoundRule` carries no timezone field the way
 * `CampaignCapProto.periodTimezone` does for caps. This resolver compares `windowStart`/
 * `windowEnd` against `activity_performed_date`'s own UTC time-of-day — a deliberate, documented
 * choice (not a default that silently fell out of `Date`'s own local-time methods; `getUTCHours`/
 * `getUTCMinutes` are used explicitly below). Flagged in this task's own completion report as a
 * design gap for the architect: a real per-tenant/per-rule timezone is a plausible future need,
 * but nothing today's live data (`windowStart: "00:00"`, `windowEnd: "23:59"` — a full calendar
 * day either way) can distinguish from UTC.
 */
import { Injectable, Logger } from '@nestjs/common';
import type { ActivityLogRow } from '@/database/models/activity-log.model';
import type {
  RuleResolver,
  RuleResolverContext,
  RuleResolverOutcome,
} from './rule-resolver.interface';

export const SCHEDULE_CONTEXT_RESOLVER_CODE = 'SCHEDULE_CONTEXT';

// Matches the one real template shape (diagnosis doc §3 row set B), tolerant of surrounding
// whitespace. Captures the field token so a not-yet-supported field name (anything other than
// "currentTime") is reported as unresolved rather than silently assumed to mean "now".
const SCHEDULE_CONTEXT_CLAUSE_PATTERN =
  /^([a-zA-Z_][a-zA-Z0-9_]*)\s+within\s+the\s+:windowType\s+window$/i;

/** The only field token this resolver knows how to map today, per this file's own header. A
 * future second field name arriving in this same clause shape is reported unresolved, never
 * guessed — see `resolve()` below. */
const FIELD_TO_ACTIVITY_COLUMN: Readonly<Record<string, keyof ActivityLogRow>> = Object.freeze({
  currentTime: 'activity_performed_date',
});

/** Only value confirmed live (diagnosis doc §3) — see this file's own header. */
const SUPPORTED_WINDOW_TYPES: ReadonlySet<string> = new Set(['DAILY_HOURS']);

interface TimeOfDay {
  hours: number;
  minutes: number;
}

function parseHhMm(raw: unknown): TimeOfDay | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!match) {
    return undefined;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return undefined;
  }
  return { hours, minutes };
}

function minutesSinceMidnightUtc(date: Date): number {
  return date.getUTCHours() * 60 + date.getUTCMinutes();
}

function toMinutes(time: TimeOfDay): number {
  return time.hours * 60 + time.minutes;
}

@Injectable()
export class ScheduleContextResolver implements RuleResolver {
  private readonly logger = new Logger(ScheduleContextResolver.name);
  readonly resolverCode = SCHEDULE_CONTEXT_RESOLVER_CODE;

  canHandle(clause: string): boolean {
    return SCHEDULE_CONTEXT_CLAUSE_PATTERN.test(clause.trim());
  }

  resolve(context: RuleResolverContext): RuleResolverOutcome {
    const match = SCHEDULE_CONTEXT_CLAUSE_PATTERN.exec(context.clause.trim());
    if (!match) {
      // Defensive only — the registry never calls resolve() for a clause whose own canHandle()
      // returned false. Never throw regardless (this file's own header).
      return {
        resolved: false,
        reason: `clause "${context.clause}" is not a recognized SCHEDULE_CONTEXT shape`,
      };
    }

    const fieldToken = match[1];
    const activityColumn = FIELD_TO_ACTIVITY_COLUMN[fieldToken];
    if (!activityColumn) {
      const reason =
        `SCHEDULE_CONTEXT cannot resolve field "${fieldToken}" — only ` +
        `${Object.keys(FIELD_TO_ACTIVITY_COLUMN).join(', ')} is supported today`;
      this.logger.warn(reason);
      return { resolved: false, reason };
    }

    const windowType = context.boundValues.windowType;
    if (typeof windowType !== 'string' || !SUPPORTED_WINDOW_TYPES.has(windowType)) {
      const reason =
        `SCHEDULE_CONTEXT cannot resolve windowType ${JSON.stringify(windowType)} — only ` +
        `${Array.from(SUPPORTED_WINDOW_TYPES).join(', ')} is supported today`;
      this.logger.warn(reason);
      return { resolved: false, reason };
    }

    const windowStart = parseHhMm(context.boundValues.windowStart);
    const windowEnd = parseHhMm(context.boundValues.windowEnd);
    if (!windowStart || !windowEnd) {
      const reason =
        'SCHEDULE_CONTEXT cannot resolve a DAILY_HOURS window: windowStart=' +
        `${JSON.stringify(context.boundValues.windowStart)} windowEnd=` +
        `${JSON.stringify(context.boundValues.windowEnd)} must both be "HH:MM"`;
      this.logger.warn(reason);
      return { resolved: false, reason };
    }

    const activityTimestamp = context.row[activityColumn];
    if (!(activityTimestamp instanceof Date)) {
      const reason = `SCHEDULE_CONTEXT cannot resolve: activity_logs.${activityColumn} is not a Date`;
      this.logger.warn(reason);
      return { resolved: false, reason };
    }

    const nowMinutes = minutesSinceMidnightUtc(activityTimestamp);
    const startMinutes = toMinutes(windowStart);
    const endMinutes = toMinutes(windowEnd);
    const passed =
      startMinutes <= endMinutes
        ? nowMinutes >= startMinutes && nowMinutes <= endMinutes
        : // Overnight window (e.g. 22:00-06:00) — never seen in real data, supported defensively
          // rather than mis-evaluating every activity as outside the window.
          nowMinutes >= startMinutes || nowMinutes <= endMinutes;

    return { resolved: true, passed };
  }
}
