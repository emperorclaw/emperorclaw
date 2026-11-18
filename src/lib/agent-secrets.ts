import { createHash } from "crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { agentSecrets, auditLog } from "@/db/schema";
import { canManageSecrets, decryptSecretPayload, encryptSecretPayload } from "@/lib/secrets";

const NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
const MAX_VALUE_LENGTH = 8192;
const RESERVED_PREFIXES = [
    "EMPEROR_CLAW_",
    "EMPEROR_",
    "MCP_EMPERORCLAW_",
    "HERMES_",
    "LD_",
    "DYLD_",
    "PYTHON",
    "GIT_",
    "NODE_",
    "NPM_CONFIG_",
    "BASH_FUNC_",
];
const RESERVED_NAMES = new Set([
    "PATH",
    "HOME",
    "USER",
    "SHELL",
    "LANG",
    "TERM",
    "TMPDIR",
    "PYTHONPATH",
    "VIRTUAL_ENV",
    "PYTHONHOME",
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "NODE_OPTIONS",
    "ENV",
    "IFS",
    "BASH_ENV",
    "PS4",
    "PROMPT_COMMAND",
    "SSH_AUTH_SOCK",
    "SSH_ASKPASS",
    "EDITOR",
    "VISUAL",
    "PAGER",
    "BROWSER",
    "OPENSSL_CONF",
    "SSLKEYLOGFILE",
    "PERL5OPT",
    "RUBYOPT",
    "JAVA_TOOL_OPTIONS",
    "SHELLOPTS",
    "CDPATH",
]);
const ROUTING_NAME_RE = /(_BASE_URL|_API_BASE|_API_URL|_ENDPOINT|_PROXY|_HOST)$/;
const ROUTING_NAMES = new Set([
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "REQUESTS_CA_BUNDLE",
    "CURL_CA_BUNDLE",
    "NO_PROXY",
]);

/** A name that changes where the runtime sends requests; only admins may set it. */
export function isRuntimeRoutingName(name: string): boolean {
    return ROUTING_NAME_RE.test(name) || ROUTING_NAMES.has(name);
}

export class AgentSecretValidationError extends Error {
    readonly status = 400;
    constructor(message: string) {
        super(message);
        this.name = "AgentSecretValidationError";
    }
}

export class AgentSecretsUnavailableError extends Error {
    readonly status = 503;
    constructor() {
        super("EMPEROR_CLAW_MASTER_KEY is not configured; agent secrets cannot be stored or read.");
        this.name = "AgentSecretsUnavailableError";
    }
}

export class AgentSecretForbiddenError extends Error {
    readonly status = 403;
    constructor(message: string) {
        super(message);
        this.name = "AgentSecretForbiddenError";
    }
}

export function validateSecretName(name: unknown): { ok: true; name: string } | { ok: false; error: string } {
    if (typeof name !== "string") {
        return { ok: false, error: "The secret name must be a string." };
    }
    if (!NAME_RE.test(name)) {
        return { ok: false, error: "The secret name must match ^[A-Z][A-Z0-9_]{1,63}$." };
    }
    if (RESERVED_NAMES.has(name)) {
        return { ok: false, error: `${name} is reserved for the runtime environment.` };
    }
    if (RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix))) {
        return { ok: false, error: `Names starting with ${RESERVED_PREFIXES.find((prefix) => name.startsWith(prefix))} are reserved.` };
    }
    return { ok: true, name };
}

export function validateSecretValue(value: unknown): { ok: true; value: string } | { ok: false; error: string } {
    if (typeof value !== "string") {
        return { ok: false, error: "The secret value must be a string." };
    }
    if (value.length === 0) {
        return { ok: false, error: "The secret value cannot be empty." };
    }
    if (value.length > MAX_VALUE_LENGTH) {
        return { ok: false, error: `The secret value can have at most ${MAX_VALUE_LENGTH} characters.` };
    }
    if (/[\u0000-\u001f\u007f\u0085\u2028\u2029]/.test(value)) {
        return { ok: false, error: "The secret value cannot contain control characters or line separators." };
    }
    // The runtime writes values into a dotenv file, where "${NAME}" is expanded
    // even inside quotes, so such a value could not be delivered unchanged.
    if (value.includes("${")) {
        return { ok: false, error: "The secret value cannot contain \"${\"." };
    }
    // In a dotenv file a trailing backslash escapes the closing quote, so the
    // parser would read on into the next lines.
    if (value.endsWith("\\")) {
        return { ok: false, error: "The secret value cannot end with a backslash." };
    }
    return { ok: true, value };
}

const metadataColumns = {
    id: agentSecrets.id,
    name: agentSecrets.name,
    version: agentSecrets.version,
    exposeToTools: agentSecrets.exposeToTools,
    updatedAt: agentSecrets.updatedAt,
    createdByUserId: agentSecrets.createdByUserId,
};

/** Secret metadata only. The value and its ciphertext never leave the server. */
export async function listAgentSecrets(companyId: string, agentId: string) {
    return db.select(metadataColumns).from(agentSecrets).where(and(
        eq(agentSecrets.companyId, companyId),
        eq(agentSecrets.agentId, agentId),
        isNull(agentSecrets.deletedAt),
    )).orderBy(agentSecrets.name);
}

export async function setAgentSecret(input: {
    companyId: string;
    agentId: string;
    name: unknown;
    value: unknown;
    exposeToTools?: unknown;
    userId?: string | null;
    canSetRoutingNames: boolean;
}) {
    const checkedName = validateSecretName(input.name);
    if (!checkedName.ok) throw new AgentSecretValidationError(checkedName.error);
    if (!input.canSetRoutingNames && isRuntimeRoutingName(checkedName.name)) {
        throw new AgentSecretForbiddenError(
            "Only a company owner or admin can set this variable name, because it changes where the agent's runtime sends requests.",
        );
    }
    const checkedValue = validateSecretValue(input.value);
    if (!checkedValue.ok) throw new AgentSecretValidationError(checkedValue.error);
    if (input.exposeToTools !== undefined && typeof input.exposeToTools !== "boolean") {
        throw new AgentSecretValidationError("exposeToTools must be true or false.");
    }

    if (!canManageSecrets()) throw new AgentSecretsUnavailableError();
    const encrypted = encryptSecretPayload(checkedValue.value);
    if (!encrypted) throw new AgentSecretsUnavailableError();

    const now = new Date();
    const [secret] = await db.insert(agentSecrets).values({
        companyId: input.companyId,
        agentId: input.agentId,
        name: checkedName.name,
        valueEncrypted: encrypted.encryptedSecret,
        keyVersion: encrypted.keyVersion,
        exposeToTools: input.exposeToTools ?? false,
        createdByUserId: input.userId || null,
        updatedAt: now,
    }).onConflictDoUpdate({
        target: [agentSecrets.agentId, agentSecrets.name],
        targetWhere: sql`${agentSecrets.deletedAt} IS NULL`,
        set: {
            valueEncrypted: encrypted.encryptedSecret,
            keyVersion: encrypted.keyVersion,
            version: sql`${agentSecrets.version} + 1`,
            ...(input.exposeToTools === undefined ? {} : { exposeToTools: input.exposeToTools }),
            updatedAt: now,
        },
    }).returning(metadataColumns);

    return secret;
}

/** The live secret's name, for an audit label (never its value). */
export async function getAgentSecretName(companyId: string, agentId: string, secretId: string) {
    const [row] = await db.select({ name: agentSecrets.name }).from(agentSecrets).where(and(
        eq(agentSecrets.id, secretId),
        eq(agentSecrets.companyId, companyId),
        eq(agentSecrets.agentId, agentId),
        isNull(agentSecrets.deletedAt),
    )).limit(1);
    return row?.name ?? null;
}

/** Soft delete: the name can be created again afterwards, starting at version 1. */
export async function deleteAgentSecret(companyId: string, agentId: string, secretId: string) {
    const now = new Date();
    const [deleted] = await db.update(agentSecrets).set({
        deletedAt: now,
        updatedAt: now,
    }).where(and(
        eq(agentSecrets.id, secretId),
        eq(agentSecrets.companyId, companyId),
        eq(agentSecrets.agentId, agentId),
        isNull(agentSecrets.deletedAt),
    )).returning({ id: agentSecrets.id });

    return Boolean(deleted);
}

/**
 * The runtime bridge's view: decrypted values sorted by name plus a stable
 * ETag over ids, versions and flags (never values). One unreadable row is
 * reported in `failed` instead of failing every other secret.
 */
export async function resolveAgentSecretsForRuntime(companyId: string, agentId: string) {
    if (!canManageSecrets()) throw new AgentSecretsUnavailableError();

    const rows = await db.select({
        id: agentSecrets.id,
        name: agentSecrets.name,
        valueEncrypted: agentSecrets.valueEncrypted,
        version: agentSecrets.version,
        exposeToTools: agentSecrets.exposeToTools,
    }).from(agentSecrets).where(and(
        eq(agentSecrets.companyId, companyId),
        eq(agentSecrets.agentId, agentId),
        isNull(agentSecrets.deletedAt),
    )).orderBy(agentSecrets.name);

    const etag = createHash("sha256")
        .update(rows.map((row) => `${row.id}:${row.version}:${row.exposeToTools ? "true" : "false"}`).sort().join("\n"))
        .digest("hex");

    const secrets: { name: string; value: string; exposeToTools: boolean }[] = [];
    const failed: string[] = [];
    for (const row of rows) {
        try {
            const value = decryptSecretPayload(row.valueEncrypted);
            if (typeof value !== "string") throw new Error("Decrypted secret is not a string");
            secrets.push({ name: row.name, value, exposeToTools: row.exposeToTools });
        } catch {
            failed.push(row.name);
        }
    }

    return { etag, secrets, failed };
}

/**
 * The audit log's payload is free-form, so the read is recorded there with the
 * secret names only. The credential access log is not usable: its
 * integration_id is NOT NULL and references agent_integrations.
 */
export async function logAgentSecretsRead(input: {
    companyId: string;
    agentId: string;
    names: string[];
    failed: string[];
}) {
    try {
        await db.insert(auditLog).values({
            companyId: input.companyId,
            actorType: "agent",
            actorId: input.agentId,
            action: "agent_secrets.read",
            targetType: "agent",
            targetId: input.agentId,
            payloadJson: { names: input.names, failed: input.failed },
        });
    } catch (error) {
        console.error("Failed to record agent secret access:", error);
    }
}
