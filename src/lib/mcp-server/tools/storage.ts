import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { and, desc, eq, ilike, isNull, ne, or } from "drizzle-orm";
import { db } from "@/db";
import { artifacts } from "@/db/schema";
import { jsonResult, errorResult } from "../result";

export function registerStorageTools(server: McpServer, companyId: string) {
    server.registerTool("list_storage_files", {
        title: "List Storage Files",
        description: "Find uploaded files, reports, and photos to present in chat. Returns real IDs and shareUrl; send a standalone [label](shareUrl) in message text for an Open/Download card and image preview. Does not grant access or expose private human uploads. Upload local files through /artifacts/upload before sharing.",
        inputSchema: {
            search: z.string().max(200).optional(),
            limit: z.number().int().min(1).max(100).default(30),
        },
    }, async ({ search, limit }) => {
        try {
            const files = await db.select({
                id: artifacts.id, title: artifacts.title, name: artifacts.originalFilename,
                contentType: artifacts.contentType, sizeBytes: artifacts.sizeBytes,
            }).from(artifacts).where(and(
                eq(artifacts.companyId, companyId), isNull(artifacts.deletedAt),
                or(ne(artifacts.visibility, "private"), ne(artifacts.createdByType, "human")),
                search ? or(ilike(artifacts.title, `%${search}%`), ilike(artifacts.originalFilename, `%${search}%`)) : undefined,
            )).orderBy(desc(artifacts.updatedAt)).limit(limit);
            return jsonResult({ files: files.map(file => ({ ...file, shareUrl: `emperor://artifact/${file.id}` })) });
        } catch (error) {
            return errorResult(error);
        }
    });
}
