-- Converted from MS SQL Server (T-SQL) to PostgreSQL
-- Source: REWARDCONFIG-schema-DDL-extracted-from-reward-system-seedsql.md
-- Foreign keys are added after all tables exist to avoid forward-reference ordering issues.

CREATE SCHEMA IF NOT EXISTS reward_config;

-- ============ TABLES ============
CREATE TABLE IF NOT EXISTS reward_config.countries (
    id              int generated always as identity primary key,
    code            char(2)         not null,
    name            varchar(100)   not null,
    timezone        varchar(50)    not null,
    currency_code   char(3)         not null,
    dialing_code    varchar(5)      not null,
    is_hq           boolean             not null default false,
    status          varchar(20)     not null default 'active',
    created_at      timestamptz  not null default now(),
    updated_at      timestamptz  not null default now(),
    constraint uq_countries_code    unique (code),
    constraint ck_countries_status  check  (status in ('active','inactive'))
);

CREATE TABLE IF NOT EXISTS reward_config.tenants (
    id              int generated always as identity primary key,
    code            varchar(20)     not null,
    name            varchar(100)   not null,
    country_id      int             not null,
    schema_prefix   varchar(10)     null,
    contact_email   varchar(255)   null,
    contact_phone   varchar(20)     null,
    status          varchar(20)     not null default 'pending_provisioning',
    created_at      timestamptz  not null default now(),
    updated_at      timestamptz  not null default now(),
    deleted_at      timestamptz  null,
    constraint uq_tenants_code          unique (code),
    constraint uq_tenants_schema_prefix unique (schema_prefix),
    constraint ck_tenants_status        check (status in ('pending_provisioning','active','inactive','suspended'))
);

CREATE TABLE IF NOT EXISTS reward_config.services (
    service_code                varchar(30)     not null,
    service_name                varchar(100)   not null,
    schema_suffix               varchar(10)     null,
    requires_dedicated_schema   boolean             not null default true,
    description                 varchar(500)   null,
    status                      varchar(20)     not null default 'active',
    created_at                  timestamptz  not null default now(),
    updated_at                  timestamptz  not null default now(),
    constraint pk_services          primary key (service_code),
    constraint ck_services_status   check (status in ('active','inactive'))
);

CREATE TABLE IF NOT EXISTS reward_config.applications (
    application_code            varchar(50)     not null,
    application_name            varchar(100)   not null,
    service_code                varchar(30)     not null,
    requires_dedicated_schema   boolean             not null default true,
    description                 varchar(500)   null,
    status                      varchar(20)     not null default 'active',
    created_at                  timestamptz  not null default now(),
    updated_at                  timestamptz  not null default now(),
    constraint pk_applications          primary key (application_code),
    constraint ck_applications_status   check (status in ('active','inactive'))
);

CREATE TABLE IF NOT EXISTS reward_config.tenant_applications (
    tenant_id           int             not null,
    application_code    varchar(50)     not null,
    status              varchar(30)     not null default 'pending_provisioning',
    subscribed_at       timestamptz  not null default now(),
    activated_at        timestamptz  null,
    suspended_at        timestamptz  null,
    created_at          timestamptz  not null default now(),
    updated_at          timestamptz  not null default now(),
    constraint pk_tenant_applications           primary key (tenant_id, application_code),
    constraint ck_ta_status                     check (status in ('pending_provisioning','active','suspended'))
);

CREATE TABLE IF NOT EXISTS reward_config.tenant_notification_config (
    tenant_id           int             not null,
    notification_mode   varchar(10)     not null default 'shared',
    channel_email       boolean             not null default true,
    channel_sms         boolean             not null default true,
    channel_push        boolean             not null default false,
    max_daily_emails    int             null,
    max_daily_sms       int             null,
    created_at          timestamptz  not null default now(),
    updated_at          timestamptz  not null default now(),
    constraint pk_tenant_notification_config    primary key (tenant_id),
    constraint ck_tnc_mode                      check (notification_mode in ('shared','dedicated'))
);

CREATE TABLE IF NOT EXISTS reward_config.service_schema_mappings (
    id              int generated always as identity primary key,
    tenant_id       int             not null,
    service_code    varchar(30)     not null,
    database_name   varchar(100)    not null,
    schema_name     varchar(50)     not null,
    schema_alias    varchar(100)   null,
    is_shared       boolean             not null default false,
    is_active       boolean             not null default true,
    created_at      timestamptz  not null default now(),
    updated_at      timestamptz  not null default now(),
    constraint uq_ssm_tenant_service    unique (tenant_id, service_code)
);

CREATE TABLE IF NOT EXISTS reward_config.tenant_provisioning_requests (
    id                  int generated always as identity primary key,
    tenant_id           int             not null,
    service_code        varchar(30)     not null,
    target_schema       varchar(50)     not null,
    target_database     varchar(100)    not null,
    status              varchar(30)     not null default 'pending_approval',
    requested_by        varchar(100)   not null,
    approved_by         varchar(100)   null,
    approved_at         timestamptz  null,
    completed_at        timestamptz  null,
    script_path         varchar(500)   null,
    error_message       text   null,
    retry_count         int             not null default 0,
    created_at          timestamptz  not null default now(),
    updated_at          timestamptz  not null default now(),
    constraint ck_tpr_status    check (status in ('pending_approval','approved','provisioning','script_ready','completed','failed'))
);

CREATE TABLE IF NOT EXISTS reward_config.system_configs (
    id                  int generated always as identity primary key,
    config_key          varchar(100)    not null,
    config_value        text   not null,
    scope               varchar(20)     not null default 'global',
    scope_identifier    varchar(50)     null,
    is_mutable          boolean             not null default true,
    description         varchar(500)   null,
    created_at          timestamptz  not null default now(),
    updated_at          timestamptz  not null default now(),
    constraint uq_system_configs_key_scope  unique (config_key, scope, scope_identifier),
    constraint ck_system_configs_scope      check (scope in ('global','tenant','service'))
);

CREATE TABLE IF NOT EXISTS reward_config.tenant_api_keys (
    id                  int generated always as identity primary key,
    tenant_id           int             not null,
    key_prefix          varchar(10)     not null,
    key_hash            varchar(128)    not null,
    status              varchar(20)     not null default 'active',
    expires_at          timestamptz  not null,
    grace_period_end    timestamptz  null,
    replaced_by_key_id  int             null,
    issued_at           timestamptz  not null default now(),
    last_used_at        timestamptz  null,
    activated_at        timestamptz  null,
    created_at          timestamptz  not null default now(),
    updated_at          timestamptz  not null default now(),
    constraint ck_tak_status        check (status in ('active','expired','revoked','rotating'))
);

CREATE TABLE IF NOT EXISTS reward_config.tenant_key_rotation_configs (
    id                      int generated always as identity primary key,
    tenant_id               int             not null,
    rotation_frequency_days int             not null default 90,
    reminder_before_days    int             not null default 14,
    grace_period_days       int             not null default 7,
    auto_rotate             boolean             not null default false,
    notification_emails     varchar(500)   null,
    created_at              timestamptz  not null default now(),
    updated_at              timestamptz  not null default now(),
    constraint uq_tkrc_tenant   unique (tenant_id)
);

CREATE TABLE IF NOT EXISTS reward_config.api_endpoints (
    id              int generated always as identity primary key,
    service_code    varchar(30)     not null,
    method          varchar(10)     not null,
    path            varchar(200)   not null,
    endpoint_code   varchar(50)     not null,
    description     varchar(500)   null,
    status          varchar(20)     not null default 'active',
    created_at      timestamptz  not null default now(),
    updated_at      timestamptz  not null default now(),
    constraint uq_api_endpoints_code        unique (endpoint_code),
    constraint ck_api_endpoints_method      check (method in ('get','post','put','patch','delete'))
);

CREATE TABLE IF NOT EXISTS reward_config.tenant_api_endpoints (
    id              int generated always as identity primary key,
    tenant_id       int             not null,
    endpoint_id     int             not null,
    status          varchar(20)     not null default 'active',
    created_at      timestamptz  not null default now(),
    updated_at      timestamptz  not null default now(),
    constraint uq_tae_tenant_endpoint unique (tenant_id, endpoint_id)
);

CREATE TABLE IF NOT EXISTS reward_config.rate_limit_policies (
    id                      int generated always as identity primary key,
    policy_code             varchar(50)     not null,
    tier                    varchar(30)     not null,
    requests_per_window     int             not null,
    window_size_seconds     int             not null,
    throttle_strategy       varchar(20)     not null default 'reject',
    burst_limit             int             null,
    status                  varchar(20)     not null default 'active',
    created_at              timestamptz  not null default now(),
    updated_at              timestamptz  not null default now(),
    constraint uq_rlp_policy_code   unique (policy_code),
    constraint ck_rlp_tier          check (tier in ('tenant','endpoint','campaign_endpoint')),
    constraint ck_rlp_strategy      check (throttle_strategy in ('reject','queue','degrade'))
);

CREATE TABLE IF NOT EXISTS reward_config.tenant_rate_limits (
    id          int generated always as identity primary key,
    tenant_id   int             not null,
    policy_id   int             not null,
    status      varchar(20)     not null default 'active',
    created_at  timestamptz  not null default now(),
    updated_at  timestamptz  not null default now(),
    constraint uq_trl_tenant_policy unique (tenant_id, policy_id)
);

CREATE TABLE IF NOT EXISTS reward_config.tenant_endpoint_rate_limits (
    id          int generated always as identity primary key,
    tenant_id   int             not null,
    endpoint_id int             not null,
    policy_id   int             not null,
    status      varchar(20)     not null default 'active',
    created_at  timestamptz  not null default now(),
    updated_at  timestamptz  not null default now(),
    constraint uq_terl_tenant_endpoint unique (tenant_id, endpoint_id)
);

CREATE TABLE IF NOT EXISTS reward_config.rate_limit_counters (
    id              bigint generated always as identity primary key,
    tenant_id       int             not null,
    policy_id       int             not null,
    endpoint_id     int             null,
    campaign_id     int             null,
    window_start    timestamptz  not null,
    window_end      timestamptz  not null,
    request_count   int             not null default 0,
    last_request_at timestamptz  null,
    created_at      timestamptz  not null default now(),
    updated_at      timestamptz  not null default now()
);

CREATE TABLE IF NOT EXISTS reward_config.activity_categories (
    id              int generated always as identity primary key,
    tenant_id       int             not null,
    category_code   varchar(50)     not null,
    name            varchar(100)   not null,
    description     varchar(500)   null,
    status          varchar(20)     not null default 'active',
    created_at      timestamptz  not null default now(),
    updated_at      timestamptz  not null default now(),
    constraint uq_ac_tenant_code    unique (tenant_id, category_code)
);

CREATE TABLE IF NOT EXISTS reward_config.activity_types (
    id              int generated always as identity primary key,
    tenant_id       int             not null,
    category_id     int             not null,
    type_code       varchar(50)     not null,
    name            varchar(100)   not null,
    description     varchar(500)   null,
    status          varchar(20)     not null default 'active',
    created_at      timestamptz  not null default now(),
    updated_at      timestamptz  not null default now(),
    constraint uq_at_tenant_code    unique (tenant_id, type_code)
);

CREATE TABLE IF NOT EXISTS reward_config.activities (
    id              int generated always as identity primary key,
    tenant_id       int             not null,
    type_id         int             not null,
    activity_code   varchar(50)     not null,
    name            varchar(200)   not null,
    description     varchar(500)   null,
    metadata        text   null,
    status          varchar(20)     not null default 'active',
    created_at      timestamptz  not null default now(),
    updated_at      timestamptz  not null default now(),
    constraint uq_a_tenant_code     unique (tenant_id, activity_code)
);

CREATE TABLE IF NOT EXISTS reward_config.merchants (
    id              int generated always as identity primary key,
    tenant_id       int             not null,
    merchant_code   varchar(50)     not null,
    name            varchar(200)   not null,
    description     varchar(500)   null,
    contact_email   varchar(255)   null,
    contact_phone   varchar(20)     null,
    website         varchar(500)   null,
    country_code    char(2)         not null,
    status          varchar(20)     not null default 'active',
    created_at      timestamptz  not null default now(),
    updated_at      timestamptz  not null default now(),
    deleted_at      timestamptz  null,
    constraint uq_m_tenant_code     unique (tenant_id, merchant_code),
    constraint ck_m_status          check (status in ('active','inactive','suspended'))
);

CREATE TABLE IF NOT EXISTS reward_config.merchant_stores (
    id              int generated always as identity primary key,
    tenant_id       int             not null,
    merchant_id     int             not null,
    store_code      varchar(50)     not null,
    name            varchar(200)   not null,
    address         varchar(500)   null,
    city            varchar(100)   null,
    state           varchar(100)   null,
    postal_code     varchar(20)     null,
    region          varchar(50)     null,
    latitude        decimal(10,7)   null,
    longitude       decimal(10,7)   null,
    status          varchar(20)     not null default 'active',
    created_at      timestamptz  not null default now(),
    updated_at      timestamptz  not null default now(),
    deleted_at      timestamptz  null,
    constraint uq_ms_tenant_code    unique (tenant_id, store_code)
);

CREATE TABLE IF NOT EXISTS reward_config.merchant_activities (
    id              int generated always as identity primary key,
    tenant_id       int             not null,
    merchant_id     int             not null,
    activity_id     int             not null,
    store_id        int             null,
    commission_rate decimal(5,2)    null,
    status          varchar(20)     not null default 'active',
    created_at      timestamptz  not null default now(),
    updated_at      timestamptz  not null default now(),
    constraint uq_ma_merchant_activity_store unique (merchant_id, activity_id, store_id)
);

CREATE TABLE IF NOT EXISTS reward_config.tracker_components (
    id                  int generated always as identity primary key,
    tenant_id           int             not null,
    component_code      varchar(50)     not null,
    name                varchar(200)   not null,
    description         varchar(500)   null,
    activity_id         int             null,
    completion_criteria text   null,
    status              varchar(20)     not null default 'active',
    created_at          timestamptz  not null default now(),
    updated_at          timestamptz  not null default now(),
    constraint uq_tcomp_tenant_code unique (tenant_id, component_code)
);

CREATE TABLE IF NOT EXISTS reward_config.trackers (
    id                   int generated always as identity primary key,
    tenant_id            int             not null,
    tracker_code         varchar(50)     not null,
    name                 varchar(200)   not null,
    description          varchar(500)   null,
    completion_logic     varchar(10)     not null default 'all',
    completion_threshold int             null,
    status               varchar(20)     not null default 'active',
    created_at           timestamptz  not null default now(),
    updated_at           timestamptz  not null default now(),
    constraint uq_trk_tenant_code       unique (tenant_id, tracker_code),
    constraint ck_trk_logic             check (completion_logic in ('all','any','n_of'))
);

CREATE TABLE IF NOT EXISTS reward_config.tracker_tracker_components (
    id              int generated always as identity primary key,
    tracker_id      int             not null,
    component_id    int             not null,
    sequence_order  int             not null default 1,
    is_mandatory    boolean             not null default true,
    created_at      timestamptz  not null default now(),
    constraint uq_ttc_tracker_component unique (tracker_id, component_id)
);

CREATE TABLE IF NOT EXISTS reward_config.tenant_campaigns (
    id               int generated always as identity primary key,
    tenant_id        int             not null,
    campaign_code    varchar(50)     not null,
    name             varchar(200)   not null,
    description      text   null,
    region           varchar(50)     null,
    start_date       timestamptz  not null,
    end_date         timestamptz  not null,
    status           varchar(20)     not null default 'draft',
    metadata         text   null,
    max_participants int             null,
    budget_amount    decimal(18,2)   null,
    budget_currency  char(3)         null,
    created_by       varchar(100)   not null,
    approved_by      varchar(100)   null,
    approved_at      timestamptz  null,
    created_at       timestamptz  not null default now(),
    updated_at       timestamptz  not null default now(),
    deleted_at       timestamptz  null,
    constraint uq_tc_tenant_code    unique (tenant_id, campaign_code),
    constraint ck_tc_status         check (status in ('draft','pending_approval','active','paused','completed','archived'))
);

CREATE TABLE IF NOT EXISTS reward_config.tenant_campaign_api_endpoints (
    id          int generated always as identity primary key,
    tenant_id   int             not null,
    campaign_id int             not null,
    endpoint_id int             not null,
    status      varchar(20)     not null default 'active',
    created_at  timestamptz  not null default now(),
    updated_at  timestamptz  not null default now(),
    constraint uq_tcae_campaign_endpoint unique (campaign_id, endpoint_id)
);

CREATE TABLE IF NOT EXISTS reward_config.tenant_campaign_trackers (
    id          int generated always as identity primary key,
    tenant_id   int             not null,
    campaign_id int             not null,
    tracker_id  int             not null,
    is_primary  boolean             not null default false,
    status      varchar(20)     not null default 'active',
    created_at  timestamptz  not null default now(),
    updated_at  timestamptz  not null default now(),
    constraint uq_tct_campaign_tracker unique (campaign_id, tracker_id)
);

CREATE TABLE IF NOT EXISTS reward_config.tenant_campaign_endpoint_rate_limits (
    id          int generated always as identity primary key,
    tenant_id   int             not null,
    campaign_id int             not null,
    endpoint_id int             not null,
    policy_id   int             not null,
    status      varchar(20)     not null default 'active',
    created_at  timestamptz  not null default now(),
    updated_at  timestamptz  not null default now(),
    constraint uq_tcerl_tenant_camp_ep unique (tenant_id, campaign_id, endpoint_id)
);

CREATE TABLE IF NOT EXISTS reward_config.admin_users (
    id                   int           generated always as identity not null primary key,
    api_key_id           int           not null,
    role                 varchar(20)  not null,
    display_name         varchar(100) not null,
    email                varchar(200) not null,
    country_id           int           null,
    tenant_id            int           null,
    merchant_id          int           null,
    preferred_timezone   varchar(60)  null,
    preferred_locale     varchar(10)  null,
    status               varchar(20)  not null default 'active',
    created_by           int           null,
    last_login_at        timestamptz     null,
    created_at           timestamptz     not null default now(),
    updated_at           timestamptz     not null default now(),
    constraint ck_admin_users_role check (role in ('super_admin','country_admin','tenant_admin','merchant')),
    constraint uq_admin_users_api_key   unique (api_key_id)
);

CREATE TABLE IF NOT EXISTS reward_config.role_nav_configs (
    id             int generated always as identity primary key,
    role           varchar(20)   not null,
    nav_key        varchar(50)   not null,
    label          varchar(80)  not null,
    icon           varchar(50)   null,
    path           varchar(200)  not null,
    parent_nav_key varchar(50)   null,
    sort_order     int           not null default 0,
    enabled        boolean           not null default true,
    created_at     timestamptz not null default now(),
    updated_at     timestamptz not null default now(),
    constraint uq_role_nav_configs_role_key unique (role, nav_key),
    constraint ck_role_nav_configs_role check (role in (
                'super_admin','country_admin','tenant_admin','maker','checker','merchant'
            ))
);

CREATE TABLE IF NOT EXISTS reward_config.role_entity_permissions (
    id         int generated always as identity primary key,
    role       varchar(20)   not null,
    entity     varchar(50)   not null,
    actions    varchar(500) not null default '["view"]',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint uq_role_entity_perms_role_entity unique (role, entity),
    constraint ck_role_entity_perms_role check (role in (
                'super_admin','country_admin','tenant_admin','maker','checker','merchant'
            ))
);

CREATE TABLE IF NOT EXISTS reward_config.role_dashboard_widgets (
    id            int generated always as identity primary key,
    role          varchar(20)    not null,
    widget_key    varchar(80)    not null,
    label         varchar(100)  not null,
    widget_config text  null,
    sort_order    int            not null default 0,
    enabled       boolean            not null default true,
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now(),
    constraint uq_role_dashboard_widgets_role_key unique (role, widget_key),
    constraint ck_role_dashboard_widgets_role check (role in (
                'super_admin','country_admin','tenant_admin','maker','checker','merchant'
            ))
);

CREATE TABLE IF NOT EXISTS reward_config.system_messages (
    id           int generated always as identity primary key,
    message_key  varchar(80)    not null unique,
    message_text varchar(1000) not null,
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now()
);

CREATE TABLE IF NOT EXISTS reward_config.rbac_cache_config (
    id           int generated always as identity primary key,
    config_key   varchar(100)   not null unique,
    config_value varchar(500)  not null,
    updated_at   timestamptz not null default now()
);

CREATE TABLE IF NOT EXISTS reward_config.rule_country_assignments (
    id          int generated always as identity primary key,
    rule_id     int            not null,
    country_id  int            not null,
    assigned_at timestamptz not null default now(),
    assigned_by int            null,
    constraint uq_rule_country_assignments unique (rule_id, country_id)
);

CREATE TABLE IF NOT EXISTS reward_config.reward_country_assignments (
    id          int generated always as identity primary key,
    reward_id   int            not null,
    country_id  int            not null,
    assigned_at timestamptz not null default now(),
    assigned_by int            null,
    constraint uq_rewa_country_assignments unique (reward_id, country_id)
);

CREATE TABLE IF NOT EXISTS reward_config.approval_policies (
    id                  int generated always as identity   not null,
    entity_type         varchar(50)         not null,
    creator_role        varchar(20)         not null,
    requires_approval   boolean                 not null default true,
    approver_role       varchar(20)         null,
    tenant_id           int                 null,
    status              varchar(20)         not null default 'active',
    created_at          timestamptz      not null default now(),
    updated_at          timestamptz      not null default now(),
    constraint pk_approval_policies primary key (id),
    constraint ck_ap_creator_role check (creator_role in ('maker','checker','tenant_admin'))
);

CREATE TABLE IF NOT EXISTS reward_config.approval_requests (
    id              int generated always as identity   not null,
    tenant_id       int                 not null,
    entity_type     varchar(50)         not null,
    entity_id       int                 null,
    action          varchar(20)         not null,
    status          varchar(20)         not null default 'pending',
    payload         text       null,
    requested_by    int                 not null,
    requested_at    timestamptz      not null default now(),
    reviewed_by     int                 null,
    reviewed_at     timestamptz      null,
    review_comment  varchar(500)       null,
    expires_at      timestamptz      not null,
    created_at      timestamptz      not null default now(),
    updated_at      timestamptz      not null default now(),
    constraint pk_approval_requests     primary key (id),
    constraint ck_ar_status             check (status in ('pending','approved','rejected','expired','returned')),
    constraint ck_ar_action             check (action in ('create','update','delete'))
);

CREATE TABLE IF NOT EXISTS reward_config.reward_assignment_cap_overrides (
    id                          int generated always as identity   not null,
    tenant_id                   int                 not null,
    assignment_level            varchar(20)         not null,
    assignment_id               int                 not null,
    reward_policy_cap_id        int                 not null,
    override_frequency_value    int                 null,
    override_frequency_unit     varchar(10)         null,
    override_max_occurrences    int                 null,
    override_max_total_amount   decimal(18,4)       null,
    status                      varchar(20)         not null default 'active',
    created_at                  timestamptz      not null default now(),
    updated_at                  timestamptz      not null default now(),
    constraint pk_reward_assignment_cap_overrides   primary key (id),
    constraint ck_raco_level                        check (assignment_level in ('component','tracker','campaign')),
    constraint ck_raco_freq_unit                    check (override_frequency_unit is null or override_frequency_unit in ('hours','days','months')),
    constraint ck_raco_status                       check (status in ('active','inactive'))
);

CREATE TABLE IF NOT EXISTS reward_config.entity_assignments (
    id                      int generated always as identity   not null,
    tenant_id               int                 not null,
    entity_type             varchar(30)         not null,
    entity_id               int                 not null,
    assigned_to_user_id     int                 not null,
    assigned_by_user_id     int                 not null,
    assigned_at             timestamptz      not null default now(),
    revoked_at              timestamptz      null,
    revoked_by_user_id      int                 null,
    status                  varchar(20)         not null default 'active',
    created_at              timestamptz      not null default now(),
    updated_at              timestamptz      not null default now(),
    constraint pk_entity_assignments    primary key (id),
    constraint ck_ea_entity_type        check (entity_type in ('campaign','tracker','tracker_component')),
    constraint ck_ea_status             check (status in ('active','revoked'))
);

CREATE TABLE IF NOT EXISTS reward_config.audit_retention_config (
    id              int generated always as identity   not null,
    tenant_id       int                 null,
    entity_scope    varchar(30)         not null default 'all',
    retention_years int                 not null default 7,
    status          varchar(20)         not null default 'active',
    created_at      timestamptz      not null default now(),
    updated_at      timestamptz      not null default now(),
    constraint pk_audit_retention_config    primary key (id),
    constraint ck_arc_years                 check (retention_years between 1 and 30),
    constraint ck_arc_status                check (status in ('active','inactive'))
);

CREATE TABLE IF NOT EXISTS reward_config.campaign_audit_trail (
    id                      int generated always as identity   not null,
    tenant_id               int                 not null,
    campaign_id             int                 not null,
    entity_type             varchar(40)         not null,
    entity_id               int                 null,
    action                  varchar(20)         not null,
    field_changes           text       null,
    performed_by            int                 not null,
    performed_at            timestamptz      not null default now(),
    approved_by             int                 null,
    approved_at             timestamptz      null,
    approval_request_id     int                 null,
    comment                 varchar(500)       null,
    retention_expires_at    timestamptz      not null default (now() + interval '7 years'),
    constraint pk_campaign_audit_trail  primary key (id),
    constraint ck_cat_action            check (action in (
                        'created','updated','deleted','submitted','approved','rejected','assigned','unassigned','status_changed'
                )),
    constraint ck_cat_entity_type       check (entity_type in (
                        'campaign','tracker','tracker_component','rule_assignment','reward_assignment','cap_override','entity_assignment','campaign_submit','campaign_approval'
                ))
);

CREATE TABLE IF NOT EXISTS reward_config.user_notifications (
    id                  int generated always as identity   not null,
    tenant_id           int                 not null,
    user_id             int                 not null,
    notification_type   varchar(30)         not null,
    title               varchar(200)        not null,
    message             varchar(500)       not null,
    entity_type         varchar(30)         null,
    entity_id           int                 null,
    entity_label        varchar(200)        null,
    is_read             boolean                 not null default false,
    read_at             timestamptz      null,
    created_at          timestamptz      not null default now(),
    constraint pk_user_notifications    primary key (id)
);

CREATE TABLE IF NOT EXISTS reward_config.tenant_setup_audit_logs (
    id           int generated always as identity not null,
    tenant_id    int              not null,
    action       varchar(50)      not null,
    entity_type  varchar(30)      null,
    entity_id    int              null,
    details      text    null,
    performed_by int              not null,
    performed_at timestamptz   not null default now(),
    constraint pk_tenant_setup_audit_logs primary key (id)
);

CREATE TABLE IF NOT EXISTS reward_config.campaign_merchants (
    id          int           generated always as identity not null primary key,
    tenant_id   int           not null,
    campaign_id int           not null,
    merchant_id int           not null,
    status      varchar(20)   not null default 'active',
    created_at  timestamptz     not null default now(),
    updated_at  timestamptz     not null default now(),
    constraint uq_cm_campaign_merchant unique (campaign_id, merchant_id)
);

CREATE TABLE IF NOT EXISTS reward_config.tracker_component_groups (
    id             int         generated always as identity not null primary key,
    tenant_id      int         not null,
    tracker_id     int         not null,
    group_code     varchar(10) not null,
    component_id   int         not null,
    sequence_order int         not null default 1,
    created_at     timestamptz   not null default now(),
    updated_at     timestamptz   not null default now(),
    constraint uq_tcg_tracker_component unique (tracker_id, component_id)
);

CREATE TABLE IF NOT EXISTS reward_config.reward_systems (
    id                          int generated always as identity primary key,
    tenant_id                   int             not null,
    merchant_id                 int             null,
    system_code                 varchar(50)    not null,
    name                        varchar(200)   not null,
    description                 varchar(500)   null,
    reward_type                 varchar(30)    not null,
    delivery_mode               varchar(20)    not null default 'realtime',
    connector_type              varchar(20)    not null,
    connector_config            text   null,
    maintenance_window_enabled  boolean             not null default false,
    maintenance_schedule        text   null,
    retry_enabled               boolean             not null default true,
    retry_config                text   null,
    status                      varchar(20)    not null default 'active',
    created_at                  timestamptz       not null default now(),
    updated_at                  timestamptz       not null default now(),
    deleted_at                  timestamptz       null,
    constraint uc_reward_system_code unique (tenant_id, system_code)
);

CREATE TABLE IF NOT EXISTS reward_config.reward_policies (
    id              int generated always as identity primary key,
    reward_system_id int            not null,
    policy_code     varchar(80)     not null,
    name            varchar(200)   not null,
    description     varchar(500)   null,
    config          text   null,
    status          varchar(20)     not null default 'active',
    created_at      timestamptz  not null default now(),
    updated_at      timestamptz  not null default now(),
    constraint uq_rp_system_code unique (reward_system_id, policy_code),
    constraint ck_rp_status       check (status in ('active','inactive'))
);

CREATE TABLE IF NOT EXISTS reward_config.reward_policy_caps (
    id                    int generated always as identity primary key,
    reward_policy_id      int             not null,
    cap_type              varchar(30)    not null,
    frequency_value       int             null,
    frequency_unit        varchar(10)     null,
    max_occurrences       int             null,
    max_total_amount      decimal(18,4)   null,
    status                varchar(20)     not null default 'active',
    created_at            timestamptz  not null default now(),
    updated_at            timestamptz  not null default now(),
    constraint ck_rpc_status check (status in ('active','inactive'))
);

CREATE TABLE IF NOT EXISTS reward_config.reward_component_assignments (
    id                 int generated always as identity primary key,
    tenant_id          int             not null,
    reward_policy_id   int             not null,
    component_id       int             not null,
    assigned_at        timestamptz  not null default now(),
    status             varchar(20)     not null default 'active',
    created_at         timestamptz  not null default now(),
    updated_at         timestamptz  not null default now(),
    constraint uq_rca_unique    unique (tenant_id, reward_policy_id, component_id),
    constraint ck_rca_status    check (status in ('active','inactive'))
);

CREATE TABLE IF NOT EXISTS reward_config.reward_tracker_assignments (
    id                 int generated always as identity primary key,
    tenant_id          int             not null,
    reward_policy_id   int             not null,
    tracker_id         int             not null,
    assigned_at        timestamptz  not null default now(),
    status             varchar(20)     not null default 'active',
    created_at         timestamptz  not null default now(),
    updated_at         timestamptz  not null default now(),
    constraint uq_rta_unique   unique (tenant_id, reward_policy_id, tracker_id),
    constraint ck_rta_status   check (status in ('active','inactive'))
);

CREATE TABLE IF NOT EXISTS reward_config.reward_campaign_assignments (
    id                 int generated always as identity primary key,
    tenant_id          int             not null,
    reward_policy_id   int             not null,
    campaign_id        int             not null,
    assigned_at        timestamptz  not null default now(),
    status             varchar(20)     not null default 'active',
    created_at         timestamptz  not null default now(),
    updated_at         timestamptz  not null default now(),
    constraint uq_rca_camp_unique unique (tenant_id, reward_policy_id, campaign_id),
    constraint ck_rca_camp_status check (status in ('active','inactive'))
);

CREATE TABLE IF NOT EXISTS reward_config.reward_promo_pools (
    id               int generated always as identity primary key,
    reward_system_id int             not null,
    pool_code        varchar(50)     not null,
    name             varchar(200)   not null,
    balance_amount   decimal(18,4)   null,
    currency         char(3)         null,
    status           varchar(20)     not null default 'active',
    created_at       timestamptz  not null default now(),
    updated_at       timestamptz  not null default now(),
    constraint uq_rpp_code    unique (reward_system_id, pool_code),
    constraint ck_rpp_status  check (status in ('active','inactive'))
);

CREATE TABLE IF NOT EXISTS reward_config.reward_delivery_queue (
    id                bigint generated always as identity primary key,
    reward_system_id  int             not null,
    payload           text   null,
    status            varchar(30)     not null default 'pending',
    attempts          int             not null default 0,
    next_attempt_at   timestamptz  null,
    created_at        timestamptz  not null default now(),
    updated_at        timestamptz  not null default now()
);

CREATE TABLE IF NOT EXISTS reward_config.rule_categories (
    id            int generated always as identity primary key,
    tenant_id     int             not null,
    category_code varchar(50)     not null,
    name          varchar(200)   not null,
    description   varchar(500)   null,
    status        varchar(20)     not null default 'active',
    created_at    timestamptz  not null default now(),
    updated_at    timestamptz  not null default now(),
    constraint uq_rc_tenant_code unique (tenant_id, category_code),
    constraint ck_rc_status      check (status in ('active','inactive'))
);

CREATE TABLE IF NOT EXISTS reward_config.rule_sub_categories (
    id               int generated always as identity primary key,
    category_id      int             not null,
    sub_category_code varchar(50)    not null,
    name             varchar(200)   not null,
    description      varchar(500)   null,
    status           varchar(20)     not null default 'active',
    created_at       timestamptz  not null default now(),
    updated_at       timestamptz  not null default now(),
    constraint uq_rsc_category_code unique (category_id, sub_category_code),
    constraint ck_rsc_status         check (status in ('active','inactive'))
);

CREATE TABLE IF NOT EXISTS reward_config.rule_master (
    id               int generated always as identity primary key,
    tenant_id        int             not null,
    sub_category_id  int             not null,
    rule_code        varchar(80)     not null,
    name             varchar(200)   not null,
    expression       text   null,
    parameters       text   null,
    created_by       int             null,
    status           varchar(20)     not null default 'active',
    created_at       timestamptz  not null default now(),
    updated_at       timestamptz  not null default now(),
    constraint uq_rm_tenant_code     unique (tenant_id, rule_code),
    constraint ck_rm_status          check (status in ('active','inactive'))
);

CREATE TABLE IF NOT EXISTS reward_config.tracker_component_rules (
    id                   int generated always as identity primary key,
    tenant_id            int             not null,
    tracker_component_id int             not null,
    rule_id              int             not null,
    config               text   null,
    status               varchar(20)     not null default 'active',
    created_at           timestamptz  not null default now(),
    updated_at           timestamptz  not null default now(),
    constraint ck_tcr_status               check (status in ('active','inactive'))
);

-- ============ FOREIGN KEYS ============
ALTER TABLE reward_config.tenants ADD CONSTRAINT fk_tenants_country FOREIGN KEY (country_id) REFERENCES reward_config.countries (id);
ALTER TABLE reward_config.applications ADD CONSTRAINT fk_applications_service FOREIGN KEY (service_code) REFERENCES reward_config.services (service_code);
ALTER TABLE reward_config.tenant_applications ADD CONSTRAINT fk_ta_tenant FOREIGN KEY (tenant_id) REFERENCES reward_config.tenants (id);
ALTER TABLE reward_config.tenant_applications ADD CONSTRAINT fk_ta_application FOREIGN KEY (application_code) REFERENCES reward_config.applications (application_code);
ALTER TABLE reward_config.tenant_notification_config ADD CONSTRAINT fk_tnc_tenant FOREIGN KEY (tenant_id) REFERENCES reward_config.tenants (id);
ALTER TABLE reward_config.service_schema_mappings ADD CONSTRAINT fk_ssm_tenant FOREIGN KEY (tenant_id) REFERENCES reward_config.tenants (id);
ALTER TABLE reward_config.service_schema_mappings ADD CONSTRAINT fk_ssm_service FOREIGN KEY (service_code) REFERENCES reward_config.services (service_code);
ALTER TABLE reward_config.tenant_provisioning_requests ADD CONSTRAINT fk_tpr_tenant FOREIGN KEY (tenant_id) REFERENCES reward_config.tenants (id);
ALTER TABLE reward_config.tenant_provisioning_requests ADD CONSTRAINT fk_tpr_service FOREIGN KEY (service_code) REFERENCES reward_config.services (service_code);
ALTER TABLE reward_config.tenant_api_keys ADD CONSTRAINT fk_tak_tenant FOREIGN KEY (tenant_id) REFERENCES reward_config.tenants (id);
ALTER TABLE reward_config.tenant_api_keys ADD CONSTRAINT fk_tak_replaced_by FOREIGN KEY (replaced_by_key_id) REFERENCES reward_config.tenant_api_keys (id);
ALTER TABLE reward_config.tenant_key_rotation_configs ADD CONSTRAINT fk_tkrc_tenant FOREIGN KEY (tenant_id) REFERENCES reward_config.tenants (id);
ALTER TABLE reward_config.api_endpoints ADD CONSTRAINT fk_api_endpoints_service FOREIGN KEY (service_code) REFERENCES reward_config.services (service_code);
ALTER TABLE reward_config.tenant_api_endpoints ADD CONSTRAINT fk_tae_tenant FOREIGN KEY (tenant_id) REFERENCES reward_config.tenants (id);
ALTER TABLE reward_config.tenant_api_endpoints ADD CONSTRAINT fk_tae_endpoint FOREIGN KEY (endpoint_id) REFERENCES reward_config.api_endpoints (id);
ALTER TABLE reward_config.tenant_rate_limits ADD CONSTRAINT fk_trl_tenant FOREIGN KEY (tenant_id) REFERENCES reward_config.tenants (id);
ALTER TABLE reward_config.tenant_rate_limits ADD CONSTRAINT fk_trl_policy FOREIGN KEY (policy_id) REFERENCES reward_config.rate_limit_policies (id);
ALTER TABLE reward_config.tenant_endpoint_rate_limits ADD CONSTRAINT fk_terl_tenant FOREIGN KEY (tenant_id) REFERENCES reward_config.tenants (id);
ALTER TABLE reward_config.tenant_endpoint_rate_limits ADD CONSTRAINT fk_terl_endpoint FOREIGN KEY (endpoint_id) REFERENCES reward_config.api_endpoints (id);
ALTER TABLE reward_config.tenant_endpoint_rate_limits ADD CONSTRAINT fk_terl_policy FOREIGN KEY (policy_id) REFERENCES reward_config.rate_limit_policies (id);
ALTER TABLE reward_config.rate_limit_counters ADD CONSTRAINT fk_rlc_tenant FOREIGN KEY (tenant_id) REFERENCES reward_config.tenants (id);
ALTER TABLE reward_config.rate_limit_counters ADD CONSTRAINT fk_rlc_policy FOREIGN KEY (policy_id) REFERENCES reward_config.rate_limit_policies (id);
ALTER TABLE reward_config.rate_limit_counters ADD CONSTRAINT fk_rlc_endpoint FOREIGN KEY (endpoint_id) REFERENCES reward_config.api_endpoints (id);
ALTER TABLE reward_config.activity_categories ADD CONSTRAINT fk_ac_tenant FOREIGN KEY (tenant_id) REFERENCES reward_config.tenants (id);
ALTER TABLE reward_config.activity_types ADD CONSTRAINT fk_at_tenant FOREIGN KEY (tenant_id) REFERENCES reward_config.tenants (id);
ALTER TABLE reward_config.activity_types ADD CONSTRAINT fk_at_category FOREIGN KEY (category_id) REFERENCES reward_config.activity_categories (id);
ALTER TABLE reward_config.activities ADD CONSTRAINT fk_a_tenant FOREIGN KEY (tenant_id) REFERENCES reward_config.tenants (id);
ALTER TABLE reward_config.activities ADD CONSTRAINT fk_a_type FOREIGN KEY (type_id) REFERENCES reward_config.activity_types (id);
ALTER TABLE reward_config.merchants ADD CONSTRAINT fk_m_tenant FOREIGN KEY (tenant_id) REFERENCES reward_config.tenants (id);
ALTER TABLE reward_config.merchant_stores ADD CONSTRAINT fk_ms_tenant FOREIGN KEY (tenant_id) REFERENCES reward_config.tenants (id);
ALTER TABLE reward_config.merchant_stores ADD CONSTRAINT fk_ms_merchant FOREIGN KEY (merchant_id) REFERENCES reward_config.merchants (id);
ALTER TABLE reward_config.merchant_activities ADD CONSTRAINT fk_ma_tenant FOREIGN KEY (tenant_id) REFERENCES reward_config.tenants (id);
ALTER TABLE reward_config.merchant_activities ADD CONSTRAINT fk_ma_merchant FOREIGN KEY (merchant_id) REFERENCES reward_config.merchants (id);
ALTER TABLE reward_config.merchant_activities ADD CONSTRAINT fk_ma_activity FOREIGN KEY (activity_id) REFERENCES reward_config.activities (id);
ALTER TABLE reward_config.merchant_activities ADD CONSTRAINT fk_ma_store FOREIGN KEY (store_id) REFERENCES reward_config.merchant_stores (id);
ALTER TABLE reward_config.tracker_components ADD CONSTRAINT fk_tcomp_tenant FOREIGN KEY (tenant_id) REFERENCES reward_config.tenants (id);
ALTER TABLE reward_config.tracker_components ADD CONSTRAINT fk_tcomp_activity FOREIGN KEY (activity_id) REFERENCES reward_config.activities (id);
ALTER TABLE reward_config.trackers ADD CONSTRAINT fk_trk_tenant FOREIGN KEY (tenant_id) REFERENCES reward_config.tenants (id);
ALTER TABLE reward_config.tracker_tracker_components ADD CONSTRAINT fk_ttc_tracker FOREIGN KEY (tracker_id) REFERENCES reward_config.trackers (id);
ALTER TABLE reward_config.tracker_tracker_components ADD CONSTRAINT fk_ttc_component FOREIGN KEY (component_id) REFERENCES reward_config.tracker_components (id);
ALTER TABLE reward_config.tenant_campaigns ADD CONSTRAINT fk_tc_tenant FOREIGN KEY (tenant_id) REFERENCES reward_config.tenants (id);
ALTER TABLE reward_config.tenant_campaign_api_endpoints ADD CONSTRAINT fk_tcae_tenant FOREIGN KEY (tenant_id) REFERENCES reward_config.tenants (id);
ALTER TABLE reward_config.tenant_campaign_api_endpoints ADD CONSTRAINT fk_tcae_campaign FOREIGN KEY (campaign_id) REFERENCES reward_config.tenant_campaigns (id);
ALTER TABLE reward_config.tenant_campaign_api_endpoints ADD CONSTRAINT fk_tcae_endpoint FOREIGN KEY (endpoint_id) REFERENCES reward_config.api_endpoints (id);
ALTER TABLE reward_config.tenant_campaign_trackers ADD CONSTRAINT fk_tct_tenant FOREIGN KEY (tenant_id) REFERENCES reward_config.tenants (id);
ALTER TABLE reward_config.tenant_campaign_trackers ADD CONSTRAINT fk_tct_campaign FOREIGN KEY (campaign_id) REFERENCES reward_config.tenant_campaigns (id);
ALTER TABLE reward_config.tenant_campaign_trackers ADD CONSTRAINT fk_tct_tracker FOREIGN KEY (tracker_id) REFERENCES reward_config.trackers (id);
ALTER TABLE reward_config.tenant_campaign_endpoint_rate_limits ADD CONSTRAINT fk_tcerl_tenant FOREIGN KEY (tenant_id) REFERENCES reward_config.tenants (id);
ALTER TABLE reward_config.tenant_campaign_endpoint_rate_limits ADD CONSTRAINT fk_tcerl_campaign FOREIGN KEY (campaign_id) REFERENCES reward_config.tenant_campaigns (id);
ALTER TABLE reward_config.tenant_campaign_endpoint_rate_limits ADD CONSTRAINT fk_tcerl_endpoint FOREIGN KEY (endpoint_id) REFERENCES reward_config.api_endpoints (id);
ALTER TABLE reward_config.tenant_campaign_endpoint_rate_limits ADD CONSTRAINT fk_tcerl_policy FOREIGN KEY (policy_id) REFERENCES reward_config.rate_limit_policies (id);
ALTER TABLE reward_config.admin_users ADD CONSTRAINT fk_admin_users_api_keys FOREIGN KEY (api_key_id) REFERENCES reward_config.tenant_api_keys (id);
ALTER TABLE reward_config.admin_users ADD CONSTRAINT fk_admin_users_countries FOREIGN KEY (country_id) REFERENCES reward_config.countries (id);
ALTER TABLE reward_config.admin_users ADD CONSTRAINT fk_admin_users_tenants FOREIGN KEY (tenant_id) REFERENCES reward_config.tenants (id);
ALTER TABLE reward_config.rule_country_assignments ADD CONSTRAINT fk_rca_country FOREIGN KEY (country_id) REFERENCES reward_config.countries (id);
ALTER TABLE reward_config.rule_country_assignments ADD CONSTRAINT fk_rca_admin FOREIGN KEY (assigned_by) REFERENCES reward_config.admin_users (id);
ALTER TABLE reward_config.reward_country_assignments ADD CONSTRAINT fk_rwca_country FOREIGN KEY (country_id) REFERENCES reward_config.countries (id);
ALTER TABLE reward_config.reward_country_assignments ADD CONSTRAINT fk_rwca_admin FOREIGN KEY (assigned_by) REFERENCES reward_config.admin_users (id);
ALTER TABLE reward_config.approval_policies ADD CONSTRAINT fk_ap_tenant FOREIGN KEY (tenant_id) REFERENCES reward_config.tenants (id);
ALTER TABLE reward_config.approval_requests ADD CONSTRAINT fk_ar_tenant FOREIGN KEY (tenant_id) REFERENCES reward_config.tenants (id);
ALTER TABLE reward_config.approval_requests ADD CONSTRAINT fk_ar_requested_by FOREIGN KEY (requested_by) REFERENCES reward_config.admin_users (id);
ALTER TABLE reward_config.approval_requests ADD CONSTRAINT fk_ar_reviewed_by FOREIGN KEY (reviewed_by) REFERENCES reward_config.admin_users (id);
ALTER TABLE reward_config.reward_assignment_cap_overrides ADD CONSTRAINT fk_raco_tenant FOREIGN KEY (tenant_id) REFERENCES reward_config.tenants (id);
ALTER TABLE reward_config.reward_assignment_cap_overrides ADD CONSTRAINT fk_raco_policy_cap FOREIGN KEY (reward_policy_cap_id) REFERENCES reward_config.reward_policy_caps (id);
ALTER TABLE reward_config.entity_assignments ADD CONSTRAINT fk_ea_tenant FOREIGN KEY (tenant_id) REFERENCES reward_config.tenants (id);
ALTER TABLE reward_config.entity_assignments ADD CONSTRAINT fk_ea_assigned_to FOREIGN KEY (assigned_to_user_id) REFERENCES reward_config.admin_users (id);
ALTER TABLE reward_config.entity_assignments ADD CONSTRAINT fk_ea_assigned_by FOREIGN KEY (assigned_by_user_id) REFERENCES reward_config.admin_users (id);
ALTER TABLE reward_config.entity_assignments ADD CONSTRAINT fk_ea_revoked_by FOREIGN KEY (revoked_by_user_id) REFERENCES reward_config.admin_users (id);
ALTER TABLE reward_config.audit_retention_config ADD CONSTRAINT fk_arc_tenant FOREIGN KEY (tenant_id) REFERENCES reward_config.tenants (id);
ALTER TABLE reward_config.campaign_audit_trail ADD CONSTRAINT fk_cat_tenant FOREIGN KEY (tenant_id) REFERENCES reward_config.tenants (id);
ALTER TABLE reward_config.campaign_audit_trail ADD CONSTRAINT fk_cat_campaign FOREIGN KEY (campaign_id) REFERENCES reward_config.tenant_campaigns (id);
ALTER TABLE reward_config.campaign_audit_trail ADD CONSTRAINT fk_cat_performed_by FOREIGN KEY (performed_by) REFERENCES reward_config.admin_users (id);
ALTER TABLE reward_config.campaign_audit_trail ADD CONSTRAINT fk_cat_approved_by FOREIGN KEY (approved_by) REFERENCES reward_config.admin_users (id);
ALTER TABLE reward_config.campaign_audit_trail ADD CONSTRAINT fk_cat_approval_request FOREIGN KEY (approval_request_id) REFERENCES reward_config.approval_requests (id);
ALTER TABLE reward_config.user_notifications ADD CONSTRAINT fk_un_tenant FOREIGN KEY (tenant_id) REFERENCES reward_config.tenants (id);
ALTER TABLE reward_config.user_notifications ADD CONSTRAINT fk_un_user FOREIGN KEY (user_id) REFERENCES reward_config.admin_users (id);
ALTER TABLE reward_config.tenant_setup_audit_logs ADD CONSTRAINT fk_tsaudit_tenant FOREIGN KEY (tenant_id) REFERENCES reward_config.tenants (id);
ALTER TABLE reward_config.tenant_setup_audit_logs ADD CONSTRAINT fk_tsaudit_admin FOREIGN KEY (performed_by) REFERENCES reward_config.admin_users (id);
ALTER TABLE reward_config.campaign_merchants ADD CONSTRAINT fk_cm_campaign FOREIGN KEY (campaign_id) REFERENCES reward_config.tenant_campaigns (id);
ALTER TABLE reward_config.campaign_merchants ADD CONSTRAINT fk_cm_merchant FOREIGN KEY (merchant_id) REFERENCES reward_config.merchants (id);
ALTER TABLE reward_config.tracker_component_groups ADD CONSTRAINT fk_tcg_tracker FOREIGN KEY (tracker_id) REFERENCES reward_config.trackers (id);
ALTER TABLE reward_config.tracker_component_groups ADD CONSTRAINT fk_tcg_component FOREIGN KEY (component_id) REFERENCES reward_config.tracker_components (id);
ALTER TABLE reward_config.reward_policies ADD CONSTRAINT fk_rp_system FOREIGN KEY (reward_system_id) REFERENCES reward_config.reward_systems (id);
ALTER TABLE reward_config.reward_policy_caps ADD CONSTRAINT fk_rpc_policy FOREIGN KEY (reward_policy_id) REFERENCES reward_config.reward_policies (id);
ALTER TABLE reward_config.reward_component_assignments ADD CONSTRAINT fk_rca_tenant FOREIGN KEY (tenant_id) REFERENCES reward_config.tenants (id);
ALTER TABLE reward_config.reward_component_assignments ADD CONSTRAINT fk_rca_policy FOREIGN KEY (reward_policy_id) REFERENCES reward_config.reward_policies (id);
ALTER TABLE reward_config.reward_component_assignments ADD CONSTRAINT fk_rca_component FOREIGN KEY (component_id) REFERENCES reward_config.tracker_components (id);
ALTER TABLE reward_config.reward_tracker_assignments ADD CONSTRAINT fk_rta_tenant FOREIGN KEY (tenant_id) REFERENCES reward_config.tenants (id);
ALTER TABLE reward_config.reward_tracker_assignments ADD CONSTRAINT fk_rta_policy FOREIGN KEY (reward_policy_id) REFERENCES reward_config.reward_policies (id);
ALTER TABLE reward_config.reward_tracker_assignments ADD CONSTRAINT fk_rta_tracker FOREIGN KEY (tracker_id) REFERENCES reward_config.trackers (id);
ALTER TABLE reward_config.reward_campaign_assignments ADD CONSTRAINT fk_rca_campaign FOREIGN KEY (campaign_id) REFERENCES reward_config.tenant_campaigns (id);
ALTER TABLE reward_config.reward_campaign_assignments ADD CONSTRAINT fk_rca_policy2 FOREIGN KEY (reward_policy_id) REFERENCES reward_config.reward_policies (id);
ALTER TABLE reward_config.reward_campaign_assignments ADD CONSTRAINT fk_rca_tenant2 FOREIGN KEY (tenant_id) REFERENCES reward_config.tenants (id);
ALTER TABLE reward_config.reward_promo_pools ADD CONSTRAINT fk_rpp_system FOREIGN KEY (reward_system_id) REFERENCES reward_config.reward_systems (id);
ALTER TABLE reward_config.reward_delivery_queue ADD CONSTRAINT fk_rdq_system FOREIGN KEY (reward_system_id) REFERENCES reward_config.reward_systems (id);
ALTER TABLE reward_config.rule_categories ADD CONSTRAINT fk_rc_tenant FOREIGN KEY (tenant_id) REFERENCES reward_config.tenants (id);
ALTER TABLE reward_config.rule_sub_categories ADD CONSTRAINT fk_rsc_category FOREIGN KEY (category_id) REFERENCES reward_config.rule_categories (id);
ALTER TABLE reward_config.rule_master ADD CONSTRAINT fk_rm_tenant FOREIGN KEY (tenant_id) REFERENCES reward_config.tenants (id);
ALTER TABLE reward_config.rule_master ADD CONSTRAINT fk_rm_sub_category FOREIGN KEY (sub_category_id) REFERENCES reward_config.rule_sub_categories (id);
ALTER TABLE reward_config.rule_master ADD CONSTRAINT fk_rm_created_by FOREIGN KEY (created_by) REFERENCES reward_config.admin_users (id);
ALTER TABLE reward_config.tracker_component_rules ADD CONSTRAINT fk_tcr_tenant FOREIGN KEY (tenant_id) REFERENCES reward_config.tenants (id);
ALTER TABLE reward_config.tracker_component_rules ADD CONSTRAINT fk_tcr_tracker_component FOREIGN KEY (tracker_component_id) REFERENCES reward_config.tracker_components (id);
ALTER TABLE reward_config.tracker_component_rules ADD CONSTRAINT fk_tcr_rule FOREIGN KEY (rule_id) REFERENCES reward_config.rule_master (id);

-- ============ INDEXES ============
CREATE INDEX IF NOT EXISTS ix_tenants_country_id ON reward_config.tenants (country_id);
CREATE INDEX IF NOT EXISTS ix_tenants_code ON reward_config.tenants (code);
CREATE INDEX IF NOT EXISTS ix_applications_service ON reward_config.applications (service_code);
CREATE INDEX IF NOT EXISTS ix_ta_tenant_id ON reward_config.tenant_applications (tenant_id);
CREATE INDEX IF NOT EXISTS ix_ssm_tenant_service ON reward_config.service_schema_mappings (tenant_id, service_code);
CREATE INDEX IF NOT EXISTS ix_tak_tenant_id ON reward_config.tenant_api_keys (tenant_id);
CREATE INDEX IF NOT EXISTS ix_tak_key_prefix ON reward_config.tenant_api_keys (key_prefix);
CREATE INDEX IF NOT EXISTS ix_tak_status ON reward_config.tenant_api_keys (status);
CREATE INDEX IF NOT EXISTS ix_api_endpoints_service ON reward_config.api_endpoints (service_code);
CREATE INDEX IF NOT EXISTS ix_rlc_tenant_policy_window ON reward_config.rate_limit_counters (tenant_id, policy_id, window_start);
CREATE INDEX IF NOT EXISTS ix_ac_tenant_id ON reward_config.activity_categories (tenant_id);
CREATE INDEX IF NOT EXISTS ix_m_tenant_id ON reward_config.merchants (tenant_id);
CREATE INDEX IF NOT EXISTS ix_ms_merchant ON reward_config.merchant_stores (merchant_id);
CREATE INDEX IF NOT EXISTS ix_ms_region ON reward_config.merchant_stores (tenant_id, region);
CREATE INDEX IF NOT EXISTS ix_tc_tenant_status ON reward_config.tenant_campaigns (tenant_id, status);
CREATE INDEX IF NOT EXISTS ix_tc_tenant_dates ON reward_config.tenant_campaigns (tenant_id, start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_admin_users_role ON reward_config.admin_users (role);
CREATE INDEX IF NOT EXISTS idx_admin_users_country ON reward_config.admin_users (country_id);
CREATE INDEX IF NOT EXISTS idx_admin_users_tenant ON reward_config.admin_users (tenant_id);
CREATE INDEX IF NOT EXISTS ix_rp_system ON reward_config.reward_policies (reward_system_id);
CREATE INDEX IF NOT EXISTS ix_rpc_policy ON reward_config.reward_policy_caps (reward_policy_id);
CREATE INDEX IF NOT EXISTS ix_rca_tenant_policy ON reward_config.reward_component_assignments (tenant_id, reward_policy_id);
CREATE INDEX IF NOT EXISTS ix_rta_tenant_policy ON reward_config.reward_tracker_assignments (tenant_id, reward_policy_id);
CREATE INDEX IF NOT EXISTS ix_rca_campaign ON reward_config.reward_campaign_assignments (campaign_id);
CREATE INDEX IF NOT EXISTS ix_rpp_system ON reward_config.reward_promo_pools (reward_system_id);
CREATE INDEX IF NOT EXISTS ix_rdq_status ON reward_config.reward_delivery_queue (status);
CREATE INDEX IF NOT EXISTS ix_rc_tenant_id ON reward_config.rule_categories (tenant_id);
CREATE INDEX IF NOT EXISTS ix_rsc_category_id ON reward_config.rule_sub_categories (category_id);
CREATE INDEX IF NOT EXISTS ix_rm_tenant_id ON reward_config.rule_master (tenant_id);
CREATE INDEX IF NOT EXISTS ix_tcr_tracker_component ON reward_config.tracker_component_rules (tracker_component_id);
