/**
 * T-042 — `POST /definition-requests/:id/fulfil`. `super_admin` only. Links a **published**
 * `rule_versions`/`reward_versions` row (implementation note 5) — `versionId` is the only input;
 * the entity type (`rule` vs `reward`) is derived server-side from the request's own
 * `request_type`, never accepted from the client.
 */
import { IsInt } from 'class-validator';

export class FulfilDefinitionRequestDto {
  @IsInt()
  versionId!: number;
}
