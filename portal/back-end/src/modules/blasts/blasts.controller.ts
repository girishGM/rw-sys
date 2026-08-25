/**
 * T-041 — `/blasts` (06-VERSIONING.md §6/§10). Thin by design, the shape every other Wave 3
 * controller in this codebase establishes. See `blasts.constants.ts`'s header for why every
 * route here carries `@Roles` rather than `@RequirePermission`.
 */
import { Body, Controller, Get, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { Audit } from '@/common/audit/decorators/audit.decorator';
import { Roles } from '@/common/rbac/decorators/roles.decorator';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '@/modules/auth/decorators/current-user.decorator';
import { BlastsService } from './blasts.service';
import { CreateBlastDto } from './dto/create-blast.dto';
import { PreviewBlastDto } from './dto/preview-blast.dto';
import { ListBlastsQueryDto } from './dto/list-blasts-query.dto';
import {
  envelope,
  type BlastDto,
  type BlastPreviewDto,
  type DataEnvelope,
  type DataListEnvelope,
} from './dto/blast-response.dto';

@Controller('blasts')
export class BlastsController {
  constructor(private readonly blasts: BlastsService) {}

  @Post('preview')
  @Roles('super_admin')
  async preview(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: PreviewBlastDto,
  ): Promise<DataEnvelope<BlastPreviewDto>> {
    return envelope(await this.blasts.preview(actor, dto));
  }

  @Post()
  @Roles('super_admin')
  @Audit({ event: 'version_blasted', targetType: 'version_blast' })
  async create(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: CreateBlastDto,
  ): Promise<DataEnvelope<BlastDto>> {
    return envelope(await this.blasts.create(actor, dto));
  }

  @Get()
  @Roles('super_admin', 'country_admin')
  async list(
    @CurrentUser() actor: AuthenticatedUser,
    @Query() query: ListBlastsQueryDto,
  ): Promise<DataListEnvelope<BlastDto>> {
    const { rows, meta } = await this.blasts.list(actor, query);
    return { data: rows, meta };
  }

  @Get(':id')
  @Roles('super_admin', 'country_admin')
  async findOne(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<DataEnvelope<BlastDto>> {
    return envelope(await this.blasts.getById(actor, id));
  }
}
