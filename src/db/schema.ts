import { pgTable, text, timestamp, boolean, jsonb, uuid, integer } from "drizzle-orm/pg-core";

// --- Auth Tables ---
export const users = pgTable("users", {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull().unique(),
    passwordHash: text("password_hash").notNull(),
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
    role: text("role").notNull().default("owner"), // Only "owner" for V1
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
});

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
    status: text("status").notNull(),
    kpiTargetsJson: jsonb("kpi_targets_json"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
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

export const agents = pgTable("agents", {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: 'cascade' }),
    name: text("name").notNull(),
    role: text("role"),
    avatarUrl: text("avatar_url"),
    skillsJson: jsonb("skills_json"),
    modelPolicyJson: jsonb("model_policy_json"),
    concurrencyLimit: integer("concurrency_limit").default(1).notNull(),
    status: text("status").notNull().default('offline'),
    lastSeenAt: timestamp("last_seen_at"),
    currentLoad: integer("current_load").default(0).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    deletedAt: timestamp("deleted_at"),
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

export const tasks = pgTable("tasks", {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: 'cascade' }),
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: 'cascade' }),
    taskType: text("task_type").notNull(),
    templateVersion: text("template_version"),
    contractVersion: text("contract_version"),
    state: text("state").notNull().default('queued'),
    priority: integer("priority").default(0).notNull(),
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
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: 'cascade' }),
    taskId: uuid("task_id").notNull().references(() => tasks.id, { onDelete: 'cascade' }),
    kind: text("kind").notNull(),
    contentType: text("content_type").notNull(),
    contentText: text("content_text"),
    storageUrl: text("storage_url"),
    sha256: text("sha256").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    createdByType: text("created_by_type").notNull(),
    createdById: uuid("created_by_id"),
    visibility: text("visibility").default('private').notNull(),
    retentionPolicy: text("retention_policy"),
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

export const idempotencyKeys = pgTable("idempotency_keys", {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: 'cascade' }),
    endpoint: text("endpoint").notNull(),
    requestHash: text("request_hash").notNull(),
    responseSnapshot: jsonb("response_snapshot"),
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
