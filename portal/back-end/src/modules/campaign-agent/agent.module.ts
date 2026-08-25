/**
 * T-048 — DI wiring for `/campaign-agent`.
 *
 * Follows `campaigns.module.ts` exactly: `RbacModule` brings `ScopedRepository` and the
 * already-global `RolesGuard`/`PermissionsGuard`/`TenancyScopeInterceptor`; `AuditModule` brings
 * `@Audit()`; `DatabaseModule` supplies `SEQUELIZE`. Nothing here registers a guard, interceptor or
 * filter of its own.
 *
 * ### `CampaignsModule` is the important import
 *
 * It is what makes Zone 3 real (§2): `PortalApiClient` injects `CampaignsService`,
 * `JourneyService`, `BindingsService` and `CapsService` — the four services that module exports
 * for, among others, exactly this consumer. Its own header says so: *"the AI agent must go through
 * `CampaignsService` rather than reaching the database itself"*. There is deliberately **no**
 * import of `@/database/models` for writing anywhere in this module, and no `SEQUELIZE`
 * transaction opened around a campaign write — both would be the beginnings of a second write
 * path.
 *
 * ### The LLM provider is bound by token
 *
 * §8 keeps the provider behind an interface so *"a hosted model is a configuration change"*. The
 * factory below reads `AGENT_LLM_PROVIDER` and returns the one implementation that exists; an
 * unknown value fails the boot rather than degrading to something (02-SECURITY.md §9: no silent
 * defaults for security values). The same token is what a unit test replaces with a deterministic
 * stub, which is how TC-7, TC-10, TC-12 and TC-13 are provable without a model.
 *
 * ### There is no feature flag, on purpose
 *
 * The controller is registered unconditionally. A conditional registration would make the same
 * request 404 in one environment and 403 in another for the same caller — a difference support
 * staff would have to learn — whereas an unconfigured or stopped model produces one consistent 503
 * carrying `AGENT_LLM_UNAVAILABLE`, which the SPA renders as *"the assistant is unavailable — you
 * can still create this campaign in the wizard"* (§9). This module opens no port and makes no
 * outbound call until a maker sends a message, so "registered" costs nothing.
 *
 * The rollback is therefore this one import line plus T-049's nav entry, and the wizard remains the
 * full-capability path throughout (§9: *"the AI chat is an accelerator, never the only path"*).
 */
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditModule } from '@/common/audit/audit.module';
import { RbacModule } from '@/common/rbac/rbac.module';
import { DatabaseModule } from '@/database/database.module';
import { CampaignsModule } from '@/modules/campaigns/campaigns.module';
import type { Env } from '@/config/env.schema';
import { AgentController } from './agent.controller';
import { AgentService } from './agent.service';
import { AgentOrchestrator } from './agent.orchestrator';
import { AgentSessionRepository } from './agent-session.repository';
import { OptionResolverService } from './option-resolver.service';
import { PolicyEngineService } from './policy-engine.service';
import { PlanHashService } from './plan-hash.service';
import { PortalApiClient } from './portal-api.client';
import { ArchetypeRegistry } from './archetypes/archetype.registry';
import { LookupTool } from './tools/lookup.tool';
import { PlanTool } from './tools/plan.tool';
import { LLM_PROVIDER, OllamaLlmProvider, type LlmProvider } from './llm.provider';

@Module({
  imports: [RbacModule, AuditModule, DatabaseModule, CampaignsModule],
  controllers: [AgentController],
  providers: [
    AgentService,
    AgentOrchestrator,
    AgentSessionRepository,
    OptionResolverService,
    PolicyEngineService,
    PlanHashService,
    PortalApiClient,
    ArchetypeRegistry,
    LookupTool,
    PlanTool,
    {
      provide: LLM_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): LlmProvider => {
        const provider = config.get('AGENT_LLM_PROVIDER', { infer: true }) ?? 'ollama';
        if (provider !== 'ollama') {
          // Unreachable while `envSchema` types the key as `z.enum(['ollama'])`; kept because the
          // enum is the kind of thing that grows, and the failure mode of forgetting this branch
          // would be a silent fallback to a provider the operator did not choose.
          throw new Error(`Unsupported AGENT_LLM_PROVIDER "${String(provider)}".`);
        }
        return new OllamaLlmProvider(config);
      },
    },
  ],
  // Nothing outside this module consumes the agent today. `AgentService` is exported so T-049's
  // own e2e harness — and any future surface that wants to open a session on a maker's behalf —
  // goes through the service rather than reconstructing the flow.
  exports: [AgentService],
})
export class CampaignAgentModule {}
