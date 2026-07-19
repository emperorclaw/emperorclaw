"use client";

import { useState } from "react";
import { IconFileText, IconPlus, IconTrash, IconDeviceFloppy, IconPencil } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

type DoctrineFile = {
    name: string;
    content: string;
};

type Props = {
    agentId: string;
    initialDoctrine: Record<string, string>;
};

const BUILT_IN_FILES = ["SOUL.md", "AGENTS.md", "BOOTSTRAP.md", "IDENTITY.md", "TOOLS.md", "HEARTBEAT.md"];

export function AgentInstructionsTab({ agentId, initialDoctrine }: Props) {
    const [files, setFiles] = useState<DoctrineFile[]>(() =>
        Object.entries(initialDoctrine).map(([name, content]) => ({ name, content }))
    );
    const [editingFile, setEditingFile] = useState<string | null>(null);
    const [editContent, setEditContent] = useState("");
    const [newFileName, setNewFileName] = useState("");
    const [showNewFile, setShowNewFile] = useState(false);
    const [saving, setSaving] = useState(false);

    const handleEdit = (fileName: string) => {
        const file = files.find((f) => f.name === fileName);
        if (file) {
            setEditingFile(fileName);
            setEditContent(file.content);
        }
    };

    const handleSave = async () => {
        if (!editingFile) return;
        setSaving(true);

        const updated = files.map((f) =>
            f.name === editingFile ? { ...f, content: editContent } : f
        );
        const doctrineJson: Record<string, string> = {};
        updated.forEach((f) => { doctrineJson[f.name] = f.content; });

        try {
            const res = await fetch(`/api/agents/${agentId}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ doctrineJson }),
            });

            if (!res.ok) throw new Error("Failed to save");
            setFiles(updated);
            setEditingFile(null);
            toast.success(`${editingFile} saved`);
        } catch {
            toast.error("Failed to save changes");
        } finally {
            setSaving(false);
        }
    };

    const handleAddFile = async () => {
        const name = newFileName.trim();
        if (!name || files.some((f) => f.name === name)) return;

        const updated = [...files, { name, content: "" }];
        const doctrineJson: Record<string, string> = {};
        updated.forEach((f) => { doctrineJson[f.name] = f.content; });

        try {
            const res = await fetch(`/api/agents/${agentId}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ doctrineJson }),
            });

            if (!res.ok) throw new Error("Failed to add file");
            setFiles(updated);
            setNewFileName("");
            setShowNewFile(false);
            setEditingFile(name);
            setEditContent("");
            toast.success(`${name} added`);
        } catch {
            toast.error("Failed to add file");
        }
    };

    const handleDeleteFile = async (fileName: string) => {
        const updated = files.filter((f) => f.name !== fileName);
        const doctrineJson: Record<string, string> = {};
        updated.forEach((f) => { doctrineJson[f.name] = f.content; });

        try {
            const res = await fetch(`/api/agents/${agentId}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ doctrineJson }),
            });

            if (!res.ok) throw new Error("Failed to delete");
            setFiles(updated);
            if (editingFile === fileName) setEditingFile(null);
            toast.success(`${fileName} removed`);
        } catch {
            toast.error("Failed to delete file");
        }
    };

    return (
        <div className="grid grid-cols-1 lg:grid-cols-[220px_minmax(0,1fr)] gap-4">
            {/* File list sidebar */}
            <div className="border border-zinc-800 rounded-xl bg-zinc-900/50 p-3 space-y-1">
                <div className="flex items-center justify-between mb-2">
                    <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">Files</span>
                    <button
                        type="button"
                        onClick={() => setShowNewFile(!showNewFile)}
                        className="text-zinc-500 hover:text-zinc-300 transition-colors"
                        title="Add file"
                    >
                        <IconPlus className="h-4 w-4" />
                    </button>
                </div>

                {showNewFile && (
                    <div className="flex gap-1 mb-2">
                        <input
                            className="flex-1 bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 outline-none focus:border-cyan-500/50"
                            placeholder="filename.md"
                            value={newFileName}
                            onChange={(e) => setNewFileName(e.target.value)}
                            onKeyDown={(e) => e.key === "Enter" && handleAddFile()}
                            autoFocus
                        />
                        <button
                            type="button"
                            onClick={handleAddFile}
                            disabled={!newFileName.trim()}
                            className="text-cyan-400 hover:text-cyan-300 disabled:opacity-30"
                        >
                            <IconPlus className="h-4 w-4" />
                        </button>
                    </div>
                )}

                {files.map((file) => (
                    <button
                        key={file.name}
                        type="button"
                        onClick={() => handleEdit(file.name)}
                        className={`flex items-center justify-between w-full rounded-lg px-2.5 py-1.5 text-xs text-left transition-colors ${
                            editingFile === file.name
                                ? "bg-cyan-400/10 text-cyan-200 border border-cyan-400/20"
                                : "text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200"
                        }`}
                    >
                        <span className="flex items-center gap-2 truncate">
                            <IconFileText className="h-3.5 w-3.5 shrink-0" />
                            <span className="truncate">{file.name}</span>
                        </span>
                        {BUILT_IN_FILES.includes(file.name) && (
                            <span className="text-[9px] text-cyan-600 ml-1 shrink-0">built-in</span>
                        )}
                    </button>
                ))}

                {files.length === 0 && (
                    <p className="text-[11px] text-zinc-600 text-center py-4">
                        No instruction files yet. Add one to get started.
                    </p>
                )}
            </div>

            {/* Editor */}
            <div className="border border-zinc-800 rounded-xl bg-zinc-900/50 overflow-hidden">
                {editingFile ? (
                    <div className="flex flex-col h-full min-h-[320px]">
                        <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-800 bg-zinc-900/80">
                            <div className="flex items-center gap-2">
                                <IconPencil className="h-3.5 w-3.5 text-cyan-400" />
                                <span className="text-sm font-medium text-zinc-200">{editingFile}</span>
                                {BUILT_IN_FILES.includes(editingFile) && (
                                    <span className="text-[10px] text-cyan-600 bg-cyan-500/10 px-1.5 py-0.5 rounded">built-in</span>
                                )}
                            </div>
                            <div className="flex items-center gap-1">
                                <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={handleSave}
                                    disabled={saving}
                                    className="h-7 text-xs border-zinc-700 text-zinc-300 hover:bg-zinc-800"
                                >
                                    <IconDeviceFloppy className="h-3 w-3 mr-1" />
                                    {saving ? "Saving..." : "Save"}
                                </Button>
                                {!BUILT_IN_FILES.includes(editingFile) && (
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() => handleDeleteFile(editingFile)}
                                        className="h-7 text-xs border-zinc-700 text-rose-400 hover:bg-rose-500/10 hover:border-rose-500/30"
                                    >
                                        <IconTrash className="h-3 w-3" />
                                    </Button>
                                )}
                            </div>
                        </div>
                        <textarea
                            className="flex-1 w-full bg-transparent text-zinc-300 font-mono text-xs leading-relaxed p-4 outline-none resize-none"
                            value={editContent}
                            onChange={(e) => setEditContent(e.target.value)}
                            placeholder="Write your instructions here..."
                            spellCheck={false}
                        />
                    </div>
                ) : (
                    <div className="flex items-center justify-center min-h-[320px] text-zinc-500 text-sm">
                        <div className="text-center">
                            <IconFileText className="mx-auto h-8 w-8 mb-2 text-zinc-600" />
                            <p>Select a file to edit, or add a new one.</p>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
