import { promises as fs } from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNull, like, or } from "drizzle-orm";
import { db } from "@/db";
import { artifactFolders, artifacts } from "@/db/schema";
import { requireCompanyFromSession } from "@/lib/company-session";
import { storageAdapter } from "@/lib/storage";
import { enqueueDriveMirrorDeletion } from "@/lib/storage/drive-deletion-queue";
import { isStorageDiscoveryEnabled } from "@/lib/storage/discovery";
import { getLocalStorageRoot } from "@/lib/storage/local";
import { sanitizeLogicalPath } from "@/lib/storage/path-sanitizer";

export async function DELETE(req: NextRequest) {
    try {
        const { companyId } = await requireCompanyFromSession();
        if (!isStorageDiscoveryEnabled()) {
            return NextResponse.json({ error: "Storage discovery is not enabled" }, { status: 400 });
        }

        const body = await req.json();
        const logicalPath = sanitizeLogicalPath(String(body.logicalPath || ""));
        const requestedType = body.entryType === "folder" ? "folder" : "file";
        const prefix = `${logicalPath}/%`;

        const [activeArtifact] = await db.select({ id: artifacts.id }).from(artifacts).where(and(
            eq(artifacts.companyId, companyId),
            requestedType === "folder"
                ? or(eq(artifacts.path, logicalPath), like(artifacts.path, prefix))
                : eq(artifacts.path, logicalPath),
            isNull(artifacts.deletedAt),
        )).limit(1);
        const [activeFolder] = await db.select({ id: artifactFolders.id }).from(artifactFolders).where(and(
            eq(artifactFolders.companyId, companyId),
            requestedType === "folder"
                ? or(eq(artifactFolders.path, logicalPath), like(artifactFolders.path, prefix))
                : eq(artifactFolders.path, logicalPath),
            isNull(artifactFolders.deletedAt),
        )).limit(1);
        if (activeArtifact || activeFolder) {
            return NextResponse.json({ error: "This path contains tracked Storage data and cannot be removed as untracked" }, { status: 409 });
        }

        const companyRoot = path.resolve(getLocalStorageRoot(), "companies", companyId, "artifacts");
        const targetPath = path.resolve(companyRoot, logicalPath);
        if (!targetPath.startsWith(companyRoot + path.sep)) {
            return NextResponse.json({ error: "Storage path escaped the company root" }, { status: 400 });
        }

        try {
            const stat = await fs.lstat(targetPath);
            if (requestedType === "folder" && !stat.isDirectory()) {
                return NextResponse.json({ error: "Storage entry is not a folder" }, { status: 409 });
            }
            if (requestedType === "file" && !stat.isFile()) {
                return NextResponse.json({ error: "Storage entry is not a file" }, { status: 409 });
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }

        if (requestedType === "folder") {
            await fs.rm(targetPath, { recursive: true, force: true });
            await enqueueDriveMirrorDeletion({ companyId, logicalPath, entryType: "directory" });
        } else {
            await storageAdapter.delete({ companyId, logicalPath });
        }

        return NextResponse.json({ success: true });
    } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to remove untracked Storage entry";
        return NextResponse.json({ error: message }, { status: message === "Unauthorized" ? 401 : 500 });
    }
}
