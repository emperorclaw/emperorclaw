"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
    IconAlertTriangle,
    IconArrowLeft,
    IconCloudCheck,
    IconDeviceFloppy,
    IconFileSpreadsheet,
    IconFileText,
    IconLoader2,
} from "@tabler/icons-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { OfficeEditorHandle } from "@/components/artifact-editor/types";

const XlsxArtifactEditor = dynamic(() => import("@/components/artifact-editor/xlsx-artifact-editor"), {
    ssr: false,
    loading: () => <EditorLoading label="Loading spreadsheet editor…" />,
});
const DocxArtifactEditor = dynamic(() => import("@/components/artifact-editor/docx-artifact-editor"), {
    ssr: false,
    loading: () => <EditorLoading label="Loading document editor…" />,
});

type Artifact = {
    id: string;
    title: string | null;
    originalFilename: string | null;
    contentType: string;
    folderId: string | null;
    metadataJson: Record<string, unknown> | null;
    sizeBytes: number;
    updatedAt?: string;
};

type EditorKind = "xlsx" | "docx";

export default function ArtifactOfficeEditor({ artifactId }: { artifactId: string }) {
    const [artifact, setArtifact] = useState<Artifact | null>(null);
    const [bytes, setBytes] = useState<ArrayBuffer | null>(null);
    const [kind, setKind] = useState<EditorKind | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [dirty, setDirty] = useState(false);
    const [saving, setSaving] = useState(false);
    const [savedAt, setSavedAt] = useState<Date | null>(null);
    const editorHandleRef = useRef<OfficeEditorHandle | null>(null);

    useEffect(() => {
        let active = true;
        async function load() {
            try {
                const detailResponse = await fetch(`/api/ui/artifacts/${artifactId}`, { cache: "no-store" });
                if (!detailResponse.ok) throw new Error(await readError(detailResponse, "Unable to load file details"));
                const detail = await detailResponse.json() as { artifact: Artifact };
                const fileName = detail.artifact.originalFilename || detail.artifact.title || "file";
                const editorKind = getEditorKind(fileName);
                if (!editorKind) throw new Error("Emperor can edit .xlsx and .docx files here. This file type is not supported.");

                const fileResponse = await fetch(`/api/ui/artifacts/${artifactId}/download`, { cache: "no-store" });
                if (!fileResponse.ok) throw new Error(await readError(fileResponse, "Unable to download file content"));
                const fileBytes = await fileResponse.arrayBuffer();
                if (!active) return;
                setArtifact(detail.artifact);
                setKind(editorKind);
                setBytes(fileBytes);
            } catch (error) {
                if (active) setLoadError(error instanceof Error ? error.message : "Unable to open this file");
            }
        }
        void load();
        return () => { active = false; };
    }, [artifactId]);

    useEffect(() => {
        const warnBeforeUnload = (event: BeforeUnloadEvent) => {
            if (!dirty || saving) return;
            event.preventDefault();
        };
        window.addEventListener("beforeunload", warnBeforeUnload);
        return () => window.removeEventListener("beforeunload", warnBeforeUnload);
    }, [dirty, saving]);

    const onHandleChange = useCallback((handle: OfficeEditorHandle | null) => {
        editorHandleRef.current = handle;
    }, []);

    const save = useCallback(async () => {
        if (!artifact || !kind || !editorHandleRef.current || saving) return;
        setSaving(true);
        try {
            const blob = await editorHandleRef.current.exportBlob();
            const fileName = artifact.originalFilename || artifact.title || `document.${kind}`;
            const file = new File([blob], fileName, { type: mimeForKind(kind) });
            const formData = new FormData();
            formData.set("file", file);
            formData.set("name", fileName);
            formData.set("title", artifact.title || fileName);
            formData.set("contentType", mimeForKind(kind));
            formData.set("metadataJson", JSON.stringify(artifact.metadataJson || {}));
            if (artifact.folderId) formData.set("folderId", artifact.folderId);

            const response = await fetch(`/api/ui/artifacts/${artifact.id}/replace`, { method: "PATCH", body: formData });
            if (!response.ok) throw new Error(await readError(response, "Unable to save file"));
            const payload = await response.json() as { artifact: Artifact };
            setArtifact(payload.artifact);
            editorHandleRef.current.markSaved();
            setDirty(false);
            setSavedAt(new Date());
            toast.success("Saved to Storage");
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Unable to save file");
        } finally {
            setSaving(false);
        }
    }, [artifact, kind, saving]);

    useEffect(() => {
        const handleShortcut = (event: KeyboardEvent) => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
                event.preventDefault();
                if (dirty) void save();
            }
        };
        window.addEventListener("keydown", handleShortcut);
        return () => window.removeEventListener("keydown", handleShortcut);
    }, [dirty, save]);

    if (loadError) {
        return (
            <div className="flex min-h-[70vh] items-center justify-center p-6">
                <div className="max-w-lg rounded-2xl border border-rose-500/25 bg-rose-500/10 p-8 text-center">
                    <IconAlertTriangle className="mx-auto size-8 text-rose-300" />
                    <h1 className="mt-4 text-lg font-semibold text-zinc-100">Couldn’t open this file</h1>
                    <p className="mt-2 text-sm leading-6 text-zinc-400">{loadError}</p>
                    <Button asChild variant="outline" className="mt-6 border-white/10 bg-black/20"><Link href="/artifacts">Back to Storage</Link></Button>
                </div>
            </div>
        );
    }

    if (!artifact || !bytes || !kind) return <EditorLoading label="Opening file…" />;

    const fileName = artifact.originalFilename || artifact.title || `document.${kind}`;
    const FileIcon = kind === "xlsx" ? IconFileSpreadsheet : IconFileText;

    return (
        <section className="flex min-h-[680px] h-[calc(100vh-2.5rem)] flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#101114] shadow-2xl shadow-black/30">
            <header className="flex min-h-16 items-center gap-3 border-b border-white/10 bg-[#111216] px-3 sm:px-4">
                <Button asChild variant="ghost" size="icon-sm" className="shrink-0 text-zinc-400 hover:text-white"><Link href="/artifacts" aria-label="Back to Storage"><IconArrowLeft /></Link></Button>
                <div className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/5">
                    <FileIcon className={kind === "xlsx" ? "size-5 text-emerald-300" : "size-5 text-blue-300"} />
                </div>
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                        <h1 className="truncate text-sm font-semibold text-zinc-100" title={fileName}>{fileName}</h1>
                        <Badge variant="outline" className="border-cyan-400/25 bg-cyan-400/10 text-[10px] uppercase tracking-wider text-cyan-200">Beta</Badge>
                    </div>
                    <div className="mt-0.5 flex items-center gap-1.5 text-xs text-zinc-500" aria-live="polite">
                        {saving ? <><IconLoader2 className="size-3 animate-spin" />Saving…</> : dirty ? <><span className="size-1.5 rounded-full bg-amber-300" />Unsaved changes</> : <><IconCloudCheck className="size-3.5 text-emerald-400" />{savedAt ? `Saved ${formatSavedTime(savedAt)}` : "Saved in Storage"}</>}
                    </div>
                </div>
                <span className="hidden text-xs text-zinc-600 md:inline">⌘/Ctrl + S</span>
                <Button onClick={() => void save()} disabled={!dirty || saving || !editorHandleRef.current} className="min-w-24 bg-cyan-300 text-zinc-950 hover:bg-cyan-200">
                    {saving ? <IconLoader2 className="animate-spin" /> : <IconDeviceFloppy />}
                    {saving ? "Saving" : "Save"}
                </Button>
            </header>
            <div className="min-h-0 flex-1">
                {kind === "xlsx" ? (
                    <XlsxArtifactEditor bytes={bytes} fileName={fileName} onDirtyChange={setDirty} onHandleChange={onHandleChange} />
                ) : (
                    <DocxArtifactEditor bytes={bytes} fileName={fileName} onDirtyChange={setDirty} onHandleChange={onHandleChange} />
                )}
            </div>
        </section>
    );
}

function getEditorKind(fileName: string): EditorKind | null {
    const lower = fileName.toLowerCase();
    if (lower.endsWith(".xlsx")) return "xlsx";
    if (lower.endsWith(".docx")) return "docx";
    return null;
}

function mimeForKind(kind: EditorKind) {
    return kind === "xlsx"
        ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
}

async function readError(response: Response, fallback: string) {
    try {
        const body = await response.json() as { error?: string };
        return body.error || fallback;
    } catch {
        return fallback;
    }
}

function formatSavedTime(date: Date) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function EditorLoading({ label }: { label: string }) {
    return (
        <div className="flex min-h-[70vh] items-center justify-center gap-3 text-sm text-zinc-400">
            <IconLoader2 className="size-5 animate-spin text-cyan-300" />
            {label}
        </div>
    );
}

