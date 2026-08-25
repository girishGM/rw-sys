/**
 * T-031 — `POST /rules/:id/countries`. `super_admin` only. `assignedBy` is never here — the
 * service writes it from `@CurrentUser()` (implementation note 6, AGENT-PROTOCOL R3).
 */
import { IsInt } from 'class-validator';

export class AssignRuleCountryDto {
  @IsInt()
  countryId!: number;
}
