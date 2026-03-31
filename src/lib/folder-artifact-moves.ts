import { relocateArtifactBlob, rebaseArtifactPath } from "@/lib/artifact-storage";

type FolderArtifactMoveRecord = {
    id: string;
    path: string | null;
    storageKey: string | null;
    storageUrl: string | null;
    contentType: string;
    sizeBytes: number;
    sha256: string;
};

export type MovedFolderArtifact = {
    id: string;
    previousLogicalPath: string;
    nextLogicalPath: string;
    storageKey: string | null;
    storageUrl: string | null;
    sizeBytes: number;
    sha256: string;
    contentType: string;
};

export async function moveFolderArtifactBlobs(params: {
    companyId: string;
    artifacts: FolderArtifactMoveRecord[];
    fromPrefix: string;
    toPrefix: string;
}) {
    const movedArtifacts: MovedFolderArtifact[] = [];

    try {
        for (const artifact of params.artifacts) {
            const nextLogicalPath = rebaseArtifactPath(artifact.path || "", params.fromPrefix, params.toPrefix);
            const { previousLogicalPath, uploadResult } = await relocateArtifactBlob({
                companyId: params.companyId,
                artifact,
                nextLogicalPath,
            });

            movedArtifacts.push({
                id: artifact.id,
                previousLogicalPath,
                nextLogicalPath,
                storageKey: uploadResult?.storageKey ?? artifact.storageKey,
                storageUrl: uploadResult?.storageUrl ?? artifact.storageUrl,
                sizeBytes: uploadResult?.sizeBytes ?? artifact.sizeBytes,
                sha256: uploadResult?.checksum ?? artifact.sha256,
                contentType: uploadResult?.contentType ?? artifact.contentType,
            });
        }

        return movedArtifacts;
    } catch (error) {
        for (const movedArtifact of movedArtifacts.slice().reverse()) {
            try {
                await relocateArtifactBlob({
                    companyId: params.companyId,
                    artifact: {
                        path: movedArtifact.nextLogicalPath,
                        storageKey: movedArtifact.storageKey,
                        contentType: movedArtifact.contentType,
                    },
                    nextLogicalPath: movedArtifact.previousLogicalPath,
                });
            } catch (rollbackError) {
                console.error("Failed to roll back moved artifact blob", rollbackError);
            }
        }

        throw error;
    }
}
