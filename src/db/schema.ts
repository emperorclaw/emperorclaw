import { pgTable, text, timestamp, boolean, jsonb, uuid, integer, uniqueIndex, index } from "drizzle-orm/pg-core";

// --- Auth Tables ---
export const users = pgTable("users", {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull().unique(),
    passwordHash: text("password_hash").notNull(),
    displayName: text("display_name"),
    roleTitle: text("role_title"),
    emailVerifiedAt: timestamp("email_verified_at"),
    instanceRole: text("instance_role").notNull().default("member"), // 'instance_admin' | 'member'
    onboardingCompletedAt: timestamp("onboarding_completed_at"),
    onboardingDismissedAt: timestamp("onboarding_dismissed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    deletedAt: timestamp("deleted_at"),
});

export const sessions = pgTable("sessions", {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const passwordResets = pgTable("password_resets", {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const emailVerifications = pgTable("email_verifications", {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});

// --- Core SaaS Tables ---
export const companies = pgTable("companies", {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    createdByUserId: uuid("created_by_user_id").notNull().references(() => users.id),
    retentionPolicyJson: jsonb("retention_policy_json").default('{}'),
    contextNotes: text("context_notes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    deletedAt: timestamp("deleted_at"),
});

export const companyMembers = pgTable("company_members", {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: 'cascade' }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: 'cascade' }),
    role: text("role").notNull().default("member"), // 'owner' | 'admin' | 'member' | 'viewer'
    scopeJson: jsonb("scope_json").default('{}'), // { agentIds?: string[], customerIds?: string[], mode?: 'all' | 'restricted' }
    createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const companyTokens = pgTable("company_tokens", {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: 'cascade' }),
    tokenHash: text("token_hash").notNull(),
    name: text("name").notNull(),
    scope: text("scope").notNull(), // 'mcp_full', 'mcp_danger'
    lastUsedAt: timestamp("last_used_at"),
    revokedAt: timestamp("revoked_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
    // Auth hot path looks tokens up by hash; uniqueness also guarantees a
    // presented token can never resolve to more than one company.
    tokenHashUnique: uniqueIndex("company_tokens_token_hash_unique").on(table.tokenHash),
}));

export const customers = pgTable("customers", {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: 'cascade' }),
    name: text("name").notNull(),
    notes: text("notes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    deletedAt: timestamp("deleted_at"),
});

export const workflowTemplates = pgTable("workflow_templates", {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: 'cascade' }),
    name: text("name").notNull(),
    version: text("version").notNull(),
    description: text("description"),
    contractJson: jsonb("contract_json"),
    defaultsJson: jsonb("defaults_json"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    deletedAt: timestamp("deleted_at"),
});

export const playbooks = pgTable("playbooks", {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: 'cascade' }),
    name: text("name").notNull(),
    description: text("description"),
    requiredSkillsJson: jsonb("required_skills_json").default('[]'),
    instructionsJson: jsonb("instructions_json").default('[]'),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    deletedAt: timestamp("deleted_at"),
});

export const schedules = pgTable("schedules", {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: 'cascade' }),
    name: text("name").notNull(),
    playbookId: uuid("playbook_id").references(() => playbooks.id, { onDelete: 'set null' }),
    cronExpression: text("cron_expression").notNull(),
    targetProjectId: uuid("target_project_id").references(() => projects.id, { onDelete: 'set null' }),
    targetCustomerId: uuid("target_customer_id").references(() => customers.id, { onDelete: 'set null' }),
    nextRunAt: timestamp("next_run_at"),
    agentPattern: text("agent_pattern"),
    status: text("status").default('active').notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    deletedAt: timestamp("deleted_at"),
});

export const projects = pgTable("projects", {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: 'cascade' }),
    customerId: uuid("customer_id").references(() => customers.id),
    goal: text("goal").notNull(),
    templateId: uuid("template_id").references(() => workflowTemplates.id),
    leadAgentId: uuid("lead_agent_id").references(() => agents.id, { onDelete: 'set null' }),
    status: text("status").notNull(),
    kpiTargetsJson: jsonb("kpi_targets_json"),
    requireApprovalForDone: boolean("require_approval_for_done").default(false).notNull(),
    requireReviewBeforeDone: boolean("require_review_before_done").default(false).notNull(),
    commentRequiredForReview: boolean("comment_required_for_review").default(false).notNull(),
    blockStatusChangesWithPendingApproval: boolean("block_status_changes_with_pending_approval").default(false).notNull(),
    onlyLeadCanChangeStatus: boolean("only_lead_can_change_status").default(false).notNull(),
    maxActiveAgents: integer("max_active_agents").default(3).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    deletedAt: timestamp("deleted_at"),
});

export const projectRuns = pgTable("project_runs", {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: 'cascade' }),
    templateId: uuid("template_id").references(() => workflowTemplates.id),
    templateVersion: text("template_version"),
    paramsJson: jsonb("params_json"),
    status: text("status").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    deletedAt: timestamp("deleted_at"),
});

export const projectAgentProfiles = pgTable("project_agent_profiles", {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: 'cascade' }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: 'cascade' }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: 'cascade' }),
    roleType: text("role_type").default('worker').notNull(),
    displayName: text("display_name"),
    signature: text("signature"),
    memorySeed: text("memory_seed"),
    resourcePolicyJson: jsonb("resource_policy_json").default('{}').notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    deletedAt: timestamp("deleted_at"),
});

export const agents = pgTable("agents", {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: 'cascade' }),
    name: text("name").notNull(),
    role: text("role"),
    avatarUrl: text("avatar_url"),
    skillsJson: jsonb("skills_json"),
    memory: text("memory"),
    modelPolicyJson: jsonb("model_policy_json"),
    concurrencyLimit: integer("concurrency_limit").default(1).notNull(),
    provider: text("provider").notNull().default("mcp"),
    deploymentMode: text("deployment_mode").notNull().default("remote"),
    llmProvider: text("llm_provider"),
    llmModel: text("llm_model"), // specific model name (e.g. "deepseek-chat", "gpt-4o")
    doctrineJson: jsonb("doctrine_json").default("{}").$type<Record<string, string>>().notNull(),
    monthlyBudgetCents: integer("monthly_budget_cents").default(0).notNull(), // 0 = unlimited
    monthlyTokenUsage: integer("monthly_token_usage").default(0).notNull(),
    monthlyCostCents: integer("monthly_cost_cents").default(0).notNull(), // calculated spend in cents
    lastResetMonth: text("last_reset_month"), // "2026-07" — resets counters when month changes
    budgetStatus: text("budget_status").default("active").notNull(), // active | warning | paused
    status: text("status").notNull().default('offline'),
    lastSeenAt: timestamp("last_seen_at"),
    currentLoad: integer("current_load").default(0).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    deletedAt: timestamp("deleted_at"),
});

// ---- LLM Pricing & Usage Tracking ----

export const llmPricing = pgTable("llm_pricing", {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull(), // openai, anthropic, google, deepseek, openrouter, grok
    model: text("model").notNull(),       // e.g. "deepseek-chat", "gpt-4o", "claude-sonnet-4-20250514"
    label: text("label").notNull(),       // human-friendly name
    inputPricePer1k: integer("input_price_per_1k").notNull(),   // cents per 1M input tokens (14 = $0.14/1M)
    outputPricePer1k: integer("output_price_per_1k").notNull(), // cents per 1M output tokens
    active: boolean("active").default(true).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
    uniqueIndex("llm_pricing_provider_model_idx").on(t.provider, t.model),
]);

export const tokenUsageLog = pgTable("token_usage_log", {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: 'cascade' }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: 'cascade' }),
    model: text("model").notNull(),           // which model was used
    inputTokens: integer("input_tokens").default(0).notNull(),
    outputTokens: integer("output_tokens").default(0).notNull(),
    costCents: integer("cost_cents").default(0).notNull(), // calculated cost in cents × 100
    reportedAt: timestamp("reported_at").defaultNow().notNull(),
}, (t) => [
    index("token_usage_agent_date_idx").on(t.agentId, t.reportedAt),
    index("token_usage_company_date_idx").on(t.companyId, t.reportedAt),
]);

// @ts-expect-error self-referential column referencing the same table causes circular type inference.
export const artifactFolders = pgTable("artifact_folders", {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: 'cascade' }),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: 'set null' }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: 'set null' }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: 'set null' }),
    // @ts-expect-error Self-reference for parent folder requires ignoring implicit any.
    parentFolderId: uuid("parent_folder_id").references(() => artifactFolders.id, { onDelete: 'cascade' }),
    name: text("name").notNull(),
    path: text("path").notNull(),
    kind: text("kind").notNull().default("folder"),
    metadataJson: jsonb("metadata_json").default('{}').notNull(),
    createdByType: text("created_by_type").notNull(),
    createdById: uuid("created_by_id").references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    deletedAt: timestamp("deleted_at"),
});

export const runtimeNodes = pgTable("runtime_nodes", {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: 'cascade' }),
    runtimeId: text("runtime_id").notNull(),
    name: text("name").notNull(),
    hostname: text("hostname"),
    gatewayVersion: text("gateway_version"),
    capabilitiesJson: jsonb("capabilities_json").default('[]').notNull(),
    status: text("status").default('active').notNull(),
    lastSeenAt: timestamp("last_seen_at").defaultNow().notNull(),
    startedAt: timestamp("started_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    deletedAt: timestamp("deleted_at"),
});

export const agentSessions = pgTable("agent_sessions", {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: 'cascade' }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: 'cascade' }),
    runtimeNodeId: uuid("runtime_node_id").references(() => runtimeNodes.id, { onDelete: 'set null' }),
    openclawSessionId: text("openclaw_session_id").notNull(),
    sessionType: text("session_type").default('main').notNull(),
    channel: text("channel"),
    checkpointJson: jsonb("checkpoint_json"),
    syncStatus: text("sync_status").default('synced').notNull(),
    startedAt: timestamp("started_at").defaultNow().notNull(),
    lastCheckpointAt: timestamp("last_checkpoint_at"),
    lastHeartbeatAt: timestamp("last_heartbeat_at"),
    checkinDeadlineAt: timestamp("checkin_deadline_at"),
    lastWakeAt: timestamp("last_wake_at"),
    wakeAttempts: integer("wake_attempts").default(0).notNull(),
    maxWakeAttempts: integer("max_wake_attempts").default(3).notNull(),
    lifecycleGeneration: integer("lifecycle_generation").default(1).notNull(),
    lastProvisionError: text("last_provision_error"),
    endedAt: timestamp("ended_at"),
    status: text("status").default('starting').notNull(),
    summary: text("summary"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const agentMemorySnapshots = pgTable("agent_memory_snapshots", {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: 'cascade' }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: 'cascade' }),
    sessionId: uuid("session_id").references(() => agentSessions.id, { onDelete: 'set null' }),
    content: text("content").notNull(),
    summary: text("summary"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const projectMemory = pgTable("project_memory", {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: 'cascade' }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: 'cascade' }),
    content: text("content").notNull(),
    tags: jsonb("tags"),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: 'set null' }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});

// --- Pipelines Registry ---
// Agent-first: pipelines are built and executed in the agent's local runtime
// (OpenClaw / Lobster / cron). Emperor is the registry: agents register what
// they run, the system auto-generates the diagram, and runs are reported back.
export const pipelines = pgTable("pipelines", {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: 'cascade' }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: 'set null' }),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: 'set null' }),
    ownerAgentId: uuid("owner_agent_id").references(() => agents.id, { onDelete: 'set null' }),
    name: text("name").notNull(),
    purpose: text("purpose"), // one-sentence "what this does and why" — required before activation
    docMarkdown: text("doc_markdown"), // agent-written explanation — required before activation
    trigger: text("trigger").default('manual').notNull(), // 'cron' | 'event' | 'manual'
    triggerConfig: jsonb("trigger_config").default('{}').notNull(), // { cron: "0 6 * * *" } | { event: "..." }
    stepsJson: jsonb("steps_json").default('[]').notNull(), // [{ name, agentRef?, taskType?, description?, gate? }]
    diagramMermaid: text("diagram_mermaid"), // always regenerated server-side from stepsJson — never hand-written
    contextQuery: text("context_query"), // short query describing what Company Brain context this pipeline needs
    contextResourceIds: jsonb("context_resource_ids").default('[]').notNull(), // explicit Company Brain resource IDs to load
    contextTagFilters: jsonb("context_tag_filters").default('[]').notNull(), // optional normalized tags such as storage/customer/acme
    contextMaxChars: integer("context_max_chars").default(8000).notNull(),
    runtimeRef: text("runtime_ref"), // local workflow id/path in the agent's own runtime
    status: text("status").default('draft').notNull(), // 'draft' | 'active' | 'paused' | 'retired'
    runCount: integer("run_count").default(0).notNull(),
    lastRunAt: timestamp("last_run_at"),
    lastRunStatus: text("last_run_status"),
    nextRunAt: timestamp("next_run_at"),
    createdByType: text("created_by_type").default('agent').notNull(), // 'agent' | 'human'
    createdById: uuid("created_by_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    deletedAt: timestamp("deleted_at"),
});

export const pipelineRuns = pgTable("pipeline_runs", {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: 'cascade' }),
    pipelineId: uuid("pipeline_id").notNull().references(() => pipelines.id, { onDelete: 'cascade' }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: 'set null' }),
    status: text("status").default('running').notNull(), // 'running' | 'succeeded' | 'failed' | 'partial'
    summary: text("summary"),
    statsJson: jsonb("stats_json").default('{}').notNull(), // { taskIds: [], artifactIds: [], counts: {} }
    contextSourceIds: jsonb("context_source_ids").default('[]').notNull(), // Company Brain source IDs used by this run
    contextSnapshot: jsonb("context_snapshot").default('{}').notNull(), // compact context metadata; not full chain-of-thought
    startedAt: timestamp("started_at").defaultNow().notNull(),
    endedAt: timestamp("ended_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const recurringTaskDefinitions = pgTable("recurring_task_definitions", {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: 'cascade' }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: 'cascade' }),
    pipelineId: uuid("pipeline_id").references(() => pipelines.id, { onDelete: 'set null' }),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: 'set null' }),
    name: text("name").notNull(),
    taskType: text("task_type").notNull(),
    cronExpression: text("cron_expression"),
    payloadJson: jsonb("payload_json").default('{}').notNull(),
    priority: integer("priority").default(0).notNull(),
    proofRequired: boolean("proof_required").default(false).notNull(),
    humanApprovalRequired: boolean("human_approval_required").default(false).notNull(),
    proofTypesJson: jsonb("proof_types_json").default('[]').notNull(),
    active: boolean("active").default(true).notNull(),
    lastSpawnedTaskId: uuid("last_spawned_task_id"),
    lastRunAt: timestamp("last_run_at"),
    nextRunAt: timestamp("next_run_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    deletedAt: timestamp("deleted_at"),
});

export const tasks = pgTable("tasks", {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: 'cascade' }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: 'cascade' }),
    recurringTaskDefinitionId: uuid("recurring_task_definition_id").references(() => recurringTaskDefinitions.id, { onDelete: 'set null' }),
    taskKind: text("task_kind").default('standard').notNull(),
    taskType: text("task_type").notNull(),
    templateVersion: text("template_version"),
    contractVersion: text("contract_version"),
    state: text("state").notNull().default('inbox'),
    priority: integer("priority").default(0).notNull(),
    processingStartedAt: timestamp("processing_started_at"),
    assignedAgentId: uuid("assigned_agent_id").references(() => agents.id),
    leaseOwner: text("lease_owner"),
    leaseUntil: timestamp("lease_until"),
    retries: integer("retries").default(0).notNull(),
    maxRetries: integer("max_retries").default(3).notNull(),
    slaDueAt: timestamp("sla_due_at"),
    proofRequired: boolean("proof_required").default(false).notNull(),
    humanApprovalRequired: boolean("human_approval_required").default(false).notNull(),
    proofTypesJson: jsonb("proof_types_json"),
    inputJson: jsonb("input_json"),
    outputJson: jsonb("output_json"),
    blockedByTaskIds: jsonb("blocked_by_task_ids").default('[]').notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    deletedAt: timestamp("deleted_at"),
});

export const approvals = pgTable("approvals", {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: 'cascade' }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: 'cascade' }),
    requesterAgentId: uuid("requester_agent_id").references(() => agents.id, { onDelete: 'set null' }),
    resolverUserId: uuid("resolver_user_id").references(() => users.id, { onDelete: 'set null' }),
    status: text("status").default('pending').notNull(),
    actionType: text("action_type").default('task_done').notNull(),
    rationale: text("rationale"),
    resolutionNote: text("resolution_note"),
    confidence: integer("confidence").default(0).notNull(),
    metadataJson: jsonb("metadata_json").default('{}').notNull(),
    requestedAt: timestamp("requested_at").defaultNow().notNull(),
    resolvedAt: timestamp("resolved_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const approvalTaskLinks = pgTable("approval_task_links", {
    id: uuid("id").primaryKey().defaultRandom(),
    approvalId: uuid("approval_id").notNull().references(() => approvals.id, { onDelete: 'cascade' }),
    taskId: uuid("task_id").notNull().references(() => tasks.id, { onDelete: 'cascade' }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: 'cascade' }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const agentMemoryEntries = pgTable("agent_memory_entries", {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: 'cascade' }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: 'cascade' }),
    sessionId: uuid("session_id").references(() => agentSessions.id, { onDelete: 'set null' }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: 'set null' }),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: 'set null' }),
    kind: text("kind").default('context').notNull(),
    content: text("content").notNull(),
    summary: text("summary"),
    metadataJson: jsonb("metadata_json").default('{}').notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const taskEvents = pgTable("task_events", {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: 'cascade' }),
    taskId: uuid("task_id").notNull().references(() => tasks.id, { onDelete: 'cascade' }),
    eventType: text("event_type").notNull(),
    payloadJson: jsonb("payload_json"),
    actorType: text("actor_type").notNull(), // agent | human | system
    actorId: uuid("actor_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const artifacts = pgTable("artifacts", {
      id: uuid("id").primaryKey().defaultRandom(),
      companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: 'cascade' }),
      projectId: uuid("project_id").references(() => projects.id, { onDelete: 'cascade' }),
      taskId: uuid("task_id").references(() => tasks.id, { onDelete: 'cascade' }),
      folderId: uuid("folder_id").references(() => artifactFolders.id, { onDelete: 'set null' }),
      customerId: uuid("customer_id").references(() => customers.id, { onDelete: 'set null' }),
      agentId: uuid("agent_id").references(() => agents.id, { onDelete: 'set null' }),
      path: text("path"),
      title: text("title"),
      kind: text("kind").notNull(),
    artifactClass: text("artifact_class").default("working_file").notNull(),
    importance: text("importance").default("operational").notNull(),
      contentType: text("content_type").notNull(),
      contentText: text("content_text"),
      previewText: text("preview_text"),
      searchText: text("search_text"),
      storageUrl: text("storage_url"),
      storageProvider: text("storage_provider"),
    storageKey: text("storage_key"),
    originalFilename: text("original_filename"),
    sourceKind: text("source_kind"),
    sourceRef: text("source_ref"),
    sha256: text("sha256").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    createdByType: text("created_by_type").notNull(),
    createdById: uuid("created_by_id"),
    visibility: text("visibility").default('private').notNull(),
    isCanonical: boolean("is_canonical").default(false).notNull(),
    promotedAt: timestamp("promoted_at"),
    metadataJson: jsonb("metadata_json").default('{}').notNull(),
      retentionPolicy: text("retention_policy"),
      updatedAt: timestamp("updated_at").defaultNow().notNull(),
      createdAt: timestamp("created_at").defaultNow().notNull(),
      deletedAt: timestamp("deleted_at"),
  });

export const proofs = pgTable("proofs", {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: 'cascade' }),
    taskId: uuid("task_id").notNull().references(() => tasks.id, { onDelete: 'cascade' }),
    proofType: text("proof_type").notNull(),
    valueJson: jsonb("value_json"),
    artifactIdsJson: jsonb("artifact_ids_json"),
    checksum: text("checksum"),
    validatedAt: timestamp("validated_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    deletedAt: timestamp("deleted_at"),
});

export const scopedResources = pgTable("scoped_resources", {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: 'cascade' }),
    scopeType: text("scope_type").notNull(),
    scopeId: uuid("scope_id"),
    provider: text("provider").notNull(),
    resourceType: text("resource_type").notNull(),
    name: text("name").notNull(),
    displayName: text("display_name"),
    // Obsidian-style folder path, e.g. "Company/Fundraising". Empty string is
    // the vault root. Folders are implicit: the tree is derived from the
    // distinct paths at read time, so there is no folder table to keep in sync.
    path: text("path").default('').notNull(),
    configText: text("config_text").default('').notNull(),
    secretText: text("secret_text").default('').notNull(),
    status: text("status").default('active').notNull(),
    isShared: boolean("is_shared").default(false).notNull(),
    ownership: text("ownership").default('managed').notNull(),
    lastUsedAt: timestamp("last_used_at"),
    lastFailureAt: timestamp("last_failure_at"),
    lastFailureReason: text("last_failure_reason"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    deletedAt: timestamp("deleted_at"),
});

export const resourceAccessLogs = pgTable("resource_access_logs", {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: 'cascade' }),
    resourceId: uuid("resource_id").notNull().references(() => scopedResources.id, { onDelete: 'cascade' }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: 'set null' }),
    sessionId: uuid("session_id").references(() => agentSessions.id, { onDelete: 'set null' }),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: 'set null' }),
    action: text("action").default('lease').notNull(),
    status: text("status").default('success').notNull(),
    reason: text("reason"),
    metadataJson: jsonb("metadata_json").default('{}').notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const resourceLinks = pgTable("resource_links", {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: 'cascade' }),
    sourceResourceId: uuid("source_resource_id").notNull().references(() => scopedResources.id, { onDelete: 'cascade' }),
    targetResourceId: uuid("target_resource_id").references(() => scopedResources.id, { onDelete: 'set null' }),
    linkText: text("link_text").notNull(),
    linkType: text("link_type").default("wikilink").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const resourceTags = pgTable("resource_tags", {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: 'cascade' }),
    resourceId: uuid("resource_id").notNull().references(() => scopedResources.id, { onDelete: 'cascade' }),
    tag: text("tag").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const resourceVersions = pgTable("resource_versions", {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: 'cascade' }),
    resourceId: uuid("resource_id").notNull().references(() => scopedResources.id, { onDelete: 'cascade' }),
    configText: text("config_text").default("").notNull(),
    changeSummary: text("change_summary"),
    createdByType: text("created_by_type").default("system").notNull(),
    createdById: uuid("created_by_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const resourceProposals = pgTable("resource_proposals", {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: 'cascade' }),
    proposedByAgentId: uuid("proposed_by_agent_id").references(() => agents.id, { onDelete: 'set null' }),
    proposedByUserId: uuid("proposed_by_user_id").references(() => users.id, { onDelete: 'set null' }),
    scopeType: text("scope_type").notNull(),
    scopeId: uuid("scope_id"),
    targetResourceId: uuid("target_resource_id").references(() => scopedResources.id, { onDelete: 'set null' }),
    action: text("action").default("create").notNull(),
    title: text("title").notNull(),
    proposedText: text("proposed_text").default("").notNull(),
    reason: text("reason"),
    evidenceJson: jsonb("evidence_json").default('{}').notNull(),
    status: text("status").default("pending").notNull(),
    resolutionNote: text("resolution_note"),
    reviewedByUserId: uuid("reviewed_by_user_id").references(() => users.id, { onDelete: 'set null' }),
    reviewedAt: timestamp("reviewed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const incidents = pgTable("incidents", {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: 'cascade' }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: 'cascade' }),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: 'set null' }),
    severity: text("severity").notNull(),
    reasonCode: text("reason_code").notNull(),
    summary: text("summary").notNull(),
    recommendedActionJson: jsonb("recommended_action_json"),
    status: text("status").default('open').notNull(),
    resolvedAt: timestamp("resolved_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    deletedAt: timestamp("deleted_at"),
});

export const tactics = pgTable("tactics", {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: 'cascade' }),
    name: text("name").notNull(),
    intent: text("intent").notNull(),
    conditionsJson: jsonb("conditions_json"),
    requiredInputsJson: jsonb("required_inputs_json"),
    stepsJson: jsonb("steps_json"),
    successKpisJson: jsonb("success_kpis_json"),
    rollbackRulesJson: jsonb("rollback_rules_json"),
    version: text("version").notNull(),
    status: text("status").default('proposed').notNull(),
    proposedBy: uuid("proposed_by"),
    approvedBy: uuid("approved_by"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    deletedAt: timestamp("deleted_at"),
});

export const auditLog = pgTable("audit_log", {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: 'cascade' }),
    actorType: text("actor_type").notNull(),
    actorId: uuid("actor_id"),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: uuid("target_id").notNull(),
    payloadJson: jsonb("payload_json"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const opsEvents = pgTable("ops_events", {
    id: uuid("id").primaryKey().defaultRandom(),
    level: text("level").notNull(),
    category: text("category").notNull(),
    source: text("source").notNull(),
    message: text("message").notNull(),
    route: text("route"),
    method: text("method"),
    companyId: uuid("company_id"),
    userId: uuid("user_id"),
    metadataJson: jsonb("metadata_json").default('{}').notNull(),
    stack: text("stack"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const idempotencyKeys = pgTable("idempotency_keys", {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: 'cascade' }),
    endpoint: text("endpoint").notNull(),
    requestHash: text("request_hash").notNull(),
    responseSnapshot: jsonb("response_snapshot"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
    uniqueRequest: uniqueIndex("idx_idempotency_unique_request").on(table.companyId, table.requestHash),
}));

export const messageThreads = pgTable("message_threads", {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: 'cascade' }),
    type: text("type").default('team').notNull(),
    title: text("title"),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: 'set null' }),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: 'set null' }),
    incidentId: uuid("incident_id").references(() => incidents.id, { onDelete: 'set null' }),
    createdByType: text("created_by_type").default('system').notNull(),
    createdById: uuid("created_by_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    archivedAt: timestamp("archived_at"),
});

export const threadParticipants = pgTable("thread_participants", {
    id: uuid("id").primaryKey().defaultRandom(),
    threadId: uuid("thread_id").notNull().references(() => messageThreads.id, { onDelete: 'cascade' }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: 'cascade' }),
    participantType: text("participant_type").notNull(),
    participantId: uuid("participant_id"),
    participantRef: text("participant_ref"),
    role: text("role").default('member').notNull(),
    lastReadAt: timestamp("last_read_at"),
    typingUntil: timestamp("typing_until"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const threadMessages = pgTable("thread_messages", {
    id: uuid("id").primaryKey().defaultRandom(),
    threadId: uuid("thread_id").notNull().references(() => messageThreads.id, { onDelete: 'cascade' }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: 'cascade' }),
    senderType: text("sender_type").notNull(),
    senderId: text("sender_id"),
    targetAgentId: uuid("target_agent_id").references(() => agents.id, { onDelete: 'set null' }),
    text: text("text").notNull(),
    metadataJson: jsonb("metadata_json").default('{}').notNull(),
    deliveryState: text("delivery_state").default('delivered').notNull(),
    platformMessageId: text("platform_message_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const chatMessages = pgTable("chat_messages", {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: 'cascade' }),
    threadId: text("thread_id"),
    senderType: text("sender_type").notNull(), // 'human' | 'agent'
    fromUserId: text("from_user_id"),
    text: text("text").notNull(),
    platformMessageId: text("platform_message_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const actionRuns = pgTable("action_runs", {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: 'cascade' }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: 'set null' }),
    sessionId: uuid("session_id").references(() => agentSessions.id, { onDelete: 'set null' }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: 'set null' }),
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: 'set null' }),
    kind: text("kind").default('task_execution').notNull(),
    status: text("status").default('running').notNull(),
    summary: text("summary"),
    metadataJson: jsonb("metadata_json").default('{}').notNull(),
    startedAt: timestamp("started_at").defaultNow().notNull(),
    endedAt: timestamp("ended_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const actionSteps = pgTable("action_steps", {
    id: uuid("id").primaryKey().defaultRandom(),
    actionRunId: uuid("action_run_id").notNull().references(() => actionRuns.id, { onDelete: 'cascade' }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: 'cascade' }),
    stepType: text("step_type").default('tool').notNull(),
    toolName: text("tool_name"),
    status: text("status").default('running').notNull(),
    target: text("target"),
    inputSummaryJson: jsonb("input_summary_json").default('{}').notNull(),
    outputSummaryJson: jsonb("output_summary_json").default('{}').notNull(),
    errorText: text("error_text"),
    startedAt: timestamp("started_at").defaultNow().notNull(),
    endedAt: timestamp("ended_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const agentIntegrations = pgTable("agent_integrations", {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: 'cascade' }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: 'cascade' }),
    provider: text("provider").notNull(), // e.g., 'email_smtp', 'email_imap', 'github'
    name: text("name").notNull(), // Optional display name ("Support Inbox")
    ownership: text("ownership").default('managed').notNull(),
    configJson: jsonb("config_json").default('{}'), // Non-secrets: { host, port, username }
    secretJson: jsonb("secret_json").default('{}'), // Secrets: { password, apiKey }
    status: text("status").default('active').notNull(),
    lastUsedAt: timestamp("last_used_at"),
    lastFailureAt: timestamp("last_failure_at"),
    lastFailureReason: text("last_failure_reason"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const integrationSecretVersions = pgTable("integration_secret_versions", {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: 'cascade' }),
    integrationId: uuid("integration_id").notNull().references(() => agentIntegrations.id, { onDelete: 'cascade' }),
    version: integer("version").default(1).notNull(),
    encryptedSecret: text("encrypted_secret").notNull(),
    keyVersion: text("key_version").default('v1').notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    revokedAt: timestamp("revoked_at"),
});

export const credentialAccessLogs = pgTable("credential_access_logs", {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: 'cascade' }),
    integrationId: uuid("integration_id").notNull().references(() => agentIntegrations.id, { onDelete: 'cascade' }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: 'set null' }),
    sessionId: uuid("session_id").references(() => agentSessions.id, { onDelete: 'set null' }),
    action: text("action").default('lease').notNull(),
    status: text("status").default('success').notNull(),
    reason: text("reason"),
    metadataJson: jsonb("metadata_json").default('{}').notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});

// --- Team RBAC Tables ---

export const invitations = pgTable("invitations", {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull()
        .references(() => companies.id, { onDelete: "cascade" }),
    createdByUserId: uuid("created_by_user_id").notNull()
        .references(() => users.id),
    email: text("email").notNull(),
    tokenHash: text("token_hash").notNull(),
    role: text("role").notNull(), // 'admin' | 'member' | 'viewer'
    maxUses: integer("max_uses").default(1).notNull(),
    useCount: integer("use_count").default(0).notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    deletedAt: timestamp("deleted_at"),
}, (table) => ({
    tokenHashIdx: uniqueIndex("invitations_token_hash_idx").on(table.tokenHash),
    emailCompanyIdx: index("invitations_email_company_idx")
        .on(table.email, table.companyId),
}));

export const instanceSettings = pgTable("instance_settings", {
    key: text("key").primaryKey(),
    value: jsonb("value").notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
