/**
 * T-048 — `/campaign-agent` (10-AI-CAMPAIGN-AGENT.md §4).
 *
 * Thin by design, the same shape `campaigns.controller.ts` establishes: read the request, call the
 * service, shape the response. 03-API-CONTRACT.md defines no agent routes — this is a surface the
 * contract does not cover — so the paths follow the conventions §1 of that document sets out
 * (plural resource, nested sub-resources, action verbs as `POST` sub-paths) rather than inventing
 * a shape of their own.
 *
 * ### Three authorisation layers, and the reason every one of them is here (TC-20)
 *
 * | Layer | Where | What it stops |
 * |---|---|---|
 * | `@Roles('maker')` | this file, class level | any other role reaching the route at all |
 * | `@RequirePermission('campaign','create')` | this file, class level | a maker whose `campaign:create` was revoked |
 * | `assertRole(actor,'maker')` | `agent.service.ts` | a `role_entity_permissions` row that says otherwise (T-013 TC-19) |
 *
 * A `checker` fails the first two independently: it is not `maker`, and T004_001 grants it
 * `view`/`approve`/`reject`/`return` on `campaign` but **not** `create`. TC-20's *"403 — makers
 * only"* therefore holds even if one of the three is misconfigured.
 *
 * The permission is `campaign:create` rather than a new `agent` entity on purpose — see
 * `agent.constants.ts#CAMPAIGN_ENTITY`.
 *
 * ### Why the class-level guards are decorators and not `@UseGuards`
 *
 * `RolesGuard` and `PermissionsGuard` are already registered globally (T-013, `RbacModule`); these
 * decorators only supply their metadata. Adding `@UseGuards` here would run them twice.
 *
 * ### Audit
 *
 * Only `confirm` carries `@Audit`. Starting a conversation and talking in it are not portal events
 * — they are recorded in the session's own append-only transcript (§7), which is both richer and
 * scoped to the maker. What *is* a portal event is a campaign coming into existence, and that is
 * audited twice over: here, and in `portal_campaign_audit_trail` with `created_via: 'ai_agent'`
 * plus the session id (TC-3).
 */
import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { Audit } from '@/common/audit/decorators/audit.decorator';
import { Roles } from '@/common/rbac/decorators/roles.decorator';
import { RequirePermission } from '@/common/rbac/decorators/require-permission.decorator';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '@/modules/auth/decorators/current-user.decorator';
import type {
  AgentCreatedCampaign,
  AgentSession,
  AgentSessionDetail,
  AgentTurn,
} from '@reward-portal/shared';
import { CAMPAIGN_ENTITY } from './agent.constants';
import { AgentService } from './agent.service';
import { ConfirmAgentPlanDto, SendAgentMessageDto } from './dto/agent.dto';

/** The `{ data: … }` envelope 03-API-CONTRACT.md §1 fixes for every non-list response. */
interface DataEnvelope<T> {
  readonly data: T;
}

function envelope<T>(data: T): DataEnvelope<T> {
  return { data };
}

@Controller('campaign-agent')
@Roles('maker')
@RequirePermission(CAMPAIGN_ENTITY, 'create')
export class AgentController {
  constructor(private readonly agent: AgentService) {}

  /** `POST /campaign-agent/sessions` — opens a conversation and returns the greeting. */
  @Post('sessions')
  async start(@CurrentUser() actor: AuthenticatedUser): Promise<DataEnvelope<AgentTurn>> {
    return envelope(await this.agent.start(actor));
  }

  /** `GET /campaign-agent/sessions` — the maker's own sessions, for the resume picker (TC-21). */
  @Get('sessions')
  async list(
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<DataEnvelope<readonly AgentSession[]>> {
    return envelope(await this.agent.listOwn(actor));
  }

  /**
   * `GET /campaign-agent/sessions/:id` — resume, transcript included (TC-21, TC-22).
   *
   * `:id` is a uuid and is passed through as a string with **no `ParseUUIDPipe`**, deliberately: a
   * pipe would answer 400 for a malformed id and 404 for a well-formed one belonging to somebody
   * else, and telling those two apart is exactly what 02-SECURITY.md §5.1 exists to prevent. The
   * shape check lives in `agent-session.repository.ts` instead, where a malformed id takes the same
   * 404 path as a stranger's — see `UUID_PATTERN` there for why the check has to exist at all
   * (Postgres *errors* on a bad uuid literal rather than matching nothing).
   */
  @Get('sessions/:id')
  async resume(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<DataEnvelope<AgentSessionDetail>> {
    return envelope(await this.agent.resume(actor, id));
  }

  /** `POST /campaign-agent/sessions/:id/messages` — one turn. 200 rather than 201: nothing
   * addressable is created for the caller. */
  @Post('sessions/:id/messages')
  @HttpCode(200)
  async sendMessage(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: SendAgentMessageDto,
  ): Promise<DataEnvelope<AgentTurn>> {
    return envelope(await this.agent.sendMessage(actor, id, dto.message));
  }

  /** `POST /campaign-agent/sessions/:id/plan` — §4 step 9, the review panel and its hash. */
  @Post('sessions/:id/plan')
  @HttpCode(200)
  async buildPlan(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<DataEnvelope<AgentTurn>> {
    return envelope(await this.agent.buildPlan(actor, id));
  }

  /**
   * `POST /campaign-agent/sessions/:id/confirm` — §4 step 10. **The only route that creates
   * anything.**
   *
   * 201, because it does create an addressable resource — the draft campaign, whose id is in the
   * response. The `@Audit` event is `campaign_created` with `targetType: 'campaign'`, the same
   * pair `POST /campaigns` uses, because it is the same event: a checker looking at the portal
   * audit log should not have to know which of the two surfaces produced a campaign, and the
   * campaign audit trail is where the `created_via: 'ai_agent'` distinction is recorded (§7).
   */
  @Post('sessions/:id/confirm')
  @Audit({ event: 'campaign_created', targetType: 'campaign' })
  async confirm(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ConfirmAgentPlanDto,
  ): Promise<DataEnvelope<AgentCreatedCampaign>> {
    return envelope(await this.agent.confirm(actor, id, dto.planHash));
  }

  /** `POST /campaign-agent/sessions/:id/abandon`. */
  @Post('sessions/:id/abandon')
  @HttpCode(200)
  async abandon(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<DataEnvelope<AgentSession>> {
    return envelope(await this.agent.abandon(actor, id));
  }
}
