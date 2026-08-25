/**
 * T-033 — `GET`/`PUT /admin/access-control/widgets/:role`. Full replace, same shape as
 * `nav-config.dto.ts` — see that file's header.
 */
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { IsWidgetConfig } from './access-control-validators.decorators';

const WIDGET_KEY_PATTERN = /^[a-z][a-z0-9_]{0,79}$/;

export class WidgetConfigItemDto {
  @IsString()
  @Matches(WIDGET_KEY_PATTERN, {
    message: 'widgetKey must be lower_snake_case, starting with a letter',
  })
  widgetKey!: string;

  @IsString()
  @MinLength(1)
  label!: string;

  /** `role_dashboard_widgets.widget_config` — free-form per widget key (T-023 interprets it).
   * `@IsOptional()` so an absent `config` is simply omitted rather than failing validation;
   * the service defaults it to `{}`, same as `toWidgetConfig` on the read side. */
  @IsOptional()
  @IsWidgetConfig()
  config?: Record<string, unknown>;

  @IsInt()
  @Min(0)
  sortOrder!: number;

  @IsBoolean()
  enabled!: boolean;
}

export class PutWidgetConfigDto {
  @IsInt()
  @Min(0)
  expectedVersion!: number;

  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => WidgetConfigItemDto)
  items!: WidgetConfigItemDto[];
}
