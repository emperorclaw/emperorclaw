import { storageAdapter } from "@/lib/storage";
import type { StorageUploadResult } from "@/lib/storage/types";
import { deriveArtifactLogicalPath } from "@/lib/path-utils";

type ArtifactBlobRecord = {
    path?: string | null;
    storageKey?: string | null;
    contentType?: string | null;
};

export async function relocateArtifactBlob(params: {
    companyId: string;
    artifact: ArtifactBlobRecord;
    nextLogicalPath: string;
}): Promise<{
    previousLogicalPath: string;
    uploadResult: StorageUploadResult | null;
}> {
    const previousLogicalPath = deriveArtifactLogicalPath(params.artifact, params.companyId);
    if (previousLogicalPath === params.nextLogicalPath) {
        return {
            previousLogicalPath,
            uploadResult: null,
        };
    }

    if (!params.artifact.storageKey) {
        return {
            previousLogicalPath,
            uploadResult: null,
        };
    }

    const download = await storageAdapter.download({
        companyId: params.companyId,
        logicalPath: previousLogicalPath,
    });

    const uploadResult = await storageAdapter.upload({
        companyId: params.companyId,
        logicalPath: params.nextLogicalPath,
        data: download.buffer,
        contentType:
            (typeof params.artifact.contentType === "string" && params.artifact.contentType) ||
            download.contentType ||
            "application/octet-stream",
    });

    await storageAdapter.delete({
        companyId: params.companyId,
        logicalPath: previousLogicalPath,
    });

    return {
        previousLogicalPath,
        uploadResult,
    };
}

export function rebaseArtifactPath(path: string, fromPrefix: string, toPrefix: string) {
    if (path === fromPrefix) {
        return toPrefix;
    }
    const normalizedPrefix = `${fromPrefix}/`;
    if (!path.startsWith(normalizedPrefix)) {
        throw new Error(`Path ${path} is not inside ${fromPrefix}`);
    }
    return `${toPrefix}${path.slice(fromPrefix.length)}`;
}
