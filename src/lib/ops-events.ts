import { db } from "@/db";
import { opsEvents } from "@/db/schema";
import { isMissingSchemaError } from "@/lib/schema-compat";

type OpsEventLevel = "info" | "warn" | "error";

type OpsEventInput = {
    level: OpsEventLevel;
    category: string;
    source: string;
    message: string;
    route?: string | null;
    method?: string | null;
    companyId?: string | null;
    userId?: string | null;
    metadata?: Record<string, unknown>;
    stack?: string | null;
};

type OpsErrorInput = Omit<OpsEventInput, "level" | "message" | "stack"> & {
    error: unknown;
    fallbackMessage: string;
};

function toPlainObject(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return {};
    }

    const normalized: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
        if (
            entry === null ||
            typeof entry === "string" ||
            typeof entry === "number" ||
            typeof entry === "boolean"
        ) {
            normalized[key] = entry;
            continue;
        }

        if (Array.isArray(entry)) {
            normalized[key] = entry.slice(0, 20).map((item) => {
                if (
                    item === null ||
                    typeof item === "string" ||
                    typeof item === "number" ||
                    typeof item === "boolean"
                ) {
                    return item;
                }

                return String(item);
            });
            continue;
        }

        normalized[key] = String(entry);
    }

    return normalized;
}

function toErrorShape(error: unknown, fallbackMessage: string) {
    if (error instanceof Error) {
        return {
            message: error.message || fallbackMessage,
            stack: error.stack || null,
            metadata: toPlainObject(error),
        };
    }

    return {
        message: typeof error === "string" ? error : fallbackMessage,
        stack: null,
        metadata: toPlainObject(error),
    };
}

export async function recordOpsEvent(input: OpsEventInput) {
    try {
        await db.insert(opsEvents).values({
            level: input.level,
            category: input.category,
            source: input.source,
            message: input.message,
            route: input.route ?? null,
            method: input.method ?? null,
            companyId: input.companyId ?? null,
            userId: input.userId ?? null,
            metadataJson: input.metadata ?? {},
            stack: input.stack ?? null,
        });
    } catch (error) {
        if (!isMissingSchemaError(error)) {
            console.error("Failed to persist ops event:", error);
        }
    }
}

export async function recordOpsError(input: OpsErrorInput) {
    const shaped = toErrorShape(input.error, input.fallbackMessage);

    await recordOpsEvent({
        level: "error",
        category: input.category,
        source: input.source,
        message: shaped.message,
        route: input.route,
        method: input.method,
        companyId: input.companyId,
        userId: input.userId,
        metadata: {
            ...shaped.metadata,
            ...(input.metadata ?? {}),
        },
        stack: shaped.stack,
    });
}
