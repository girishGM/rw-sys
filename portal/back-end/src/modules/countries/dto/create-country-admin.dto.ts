/**
 * T-030 — the body of `POST /countries/:id/admins`, and the nested `admin` field of
 * `POST /countries` (implementation note 5: "Country creation and Country Admin creation happen
 * in one transaction when the admin details are supplied").
 *
 * Deliberately two fields and no more: no `password` (BACKLOG.md B-01 — the server generates
 * it), no `role` (always `country_admin`, never client-supplied — AGENT-PROTOCOL R3), no
 * `countryId` (taken from the route param / the just-created row, never from the body).
 */
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';
import {
  COUNTRY_ADMIN_DISPLAY_NAME_MAX_LENGTH,
  COUNTRY_ADMIN_EMAIL_MAX_LENGTH,
} from '../countries.constants';

export class CreateCountryAdminDto {
  @IsEmail()
  @MaxLength(COUNTRY_ADMIN_EMAIL_MAX_LENGTH)
  email!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(COUNTRY_ADMIN_DISPLAY_NAME_MAX_LENGTH)
  displayName!: string;
}
