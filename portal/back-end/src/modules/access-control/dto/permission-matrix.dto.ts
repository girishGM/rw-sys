/**
 * T-033 — `GET`/`PUT /admin/access-control/permissions/:role`. Full replace of
 * `role_entity_permissions` for the role — implementation note 5.
 */
import { IsInt, Min } from 'class-validator';
import { IsPermissionsMatrix } from './access-control-validators.decorators';

export class PutPermissionsDto {
  @IsInt()
  @Min(0)
  expectedVersion!: number;

  /** `{ entity: action[] }` — the exact shape `bootstrapPermissionsSchema` gives a client on
   * `GET /me/bootstrap`, so a Super Admin edits the same object shape the SPA already renders.
   * Validated cell-by-cell against the entity catalogue (TC-23); an empty object is accepted
   * (TC-24) — a role may legitimately have no permissions at all. */
  @IsPermissionsMatrix()
  permissions!: Record<string, string[]>;
}
