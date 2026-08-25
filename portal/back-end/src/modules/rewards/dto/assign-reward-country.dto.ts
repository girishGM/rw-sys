/**
 * T-032 — `POST /rewards/:id/countries`. `super_admin` only. `assignedBy` is never here — the
 * service writes it from `@CurrentUser()` (implementation note, AGENT-PROTOCOL R3).
 */
import { IsInt } from 'class-validator';

export class AssignRewardCountryDto {
  @IsInt()
  countryId!: number;
}
