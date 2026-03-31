"use client";

import { DragEvent, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { FileText, Folder, Download, Eye, Plus, Trash2 } from "lucide-react";
import { MarkdownRenderer } from "@/components/markdown-renderer";

type FolderDto = {
    id: string;
    name: string;
    path: string;
};

type ArtifactRow = {
    id: string;
    title: string | null;
    originalFilename: string | null;
    contentType: string | null;
    artifactClass: string;
    importance: string;
    sizeBytes: number;
    createdAt: string;
    taskType: string | null;
    projectGoal: string | null;
    customerName: string | null;
    contentText: string | null;
};

interface ArtifactsManagerProps {
    projects: { id: string; name: string }[];
    tasks: { id: string; type: string }[];
    customers: { id: string; name: string }[];
}

function formatBytes(bytes: number) {
    if (!bytes) {
        return "0 B";
    }
    const units = ["B", "KB", "MB", "GB"];
    let value = bytes;
    let index = 0;
    while (value >= 1024 && index < units.length - 1) {
        value /= 1024;
        index += 1;
    }
    return `${value.toFixed(1)} ${units[index]}`;
}

function formatDate(value: string) {
    try {
        return new Date(value).toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
        });
    } catch {
        return value;
    }
}

export default function ArtifactsManager({ projects, tasks, customers }: ArtifactsManagerProps) {
    const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
    const [folders, setFolders] = useState<FolderDto[]>([]);
    const [ancestors, setAncestors] = useState<FolderDto[]>([]);
    const [currentFolder, setCurrentFolder] = useState<FolderDto | null>(null);
    const [artifacts, setArtifacts] = useState<ArtifactRow[]>([]);
    const [searchTerm, setSearchTerm] = useState("");
    const [filterProject, setFilterProject] = useState("");
    const [filterTask, setFilterTask] = useState("");
    const [filterCustomer, setFilterCustomer] = useState("");
    const [previewText, setPreviewText] = useState<string | null>(null);
    const [previewTitle, setPreviewTitle] = useState<string | null>(null);
    const [uploading, setUploading] = useState(false);
    const metadataRef = useRef<HTMLTextAreaElement | null>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const [uploadMessage, setUploadMessage] = useState<string | null>(null);

    const loadFolder = async (folderId: string | null, signal?: AbortSignal) => {
        const params = new URLSearchParams();
        if (folderId) {
            params.set("folderId", folderId);
        }
        if (searchTerm) {
            params.set("search", searchTerm);
        }
        if (filterProject) {
            params.set("projectId", filterProject);
        }
        if (filterTask) {
            params.set("taskId", filterTask);
        }
        if (filterCustomer) {
            params.set("customerId", filterCustomer);
        }
        params.set("limit", "200");
        const response = await fetch(`/api/ui/folders/contents?${params.toString()}`, {
            signal,
        });
        if (!response.ok) {
            throw new Error("Unable to fetch folder contents");
        }
        const data = await response.json();
        setCurrentFolder(data.folder);
        setAncestors(data.ancestors || []);
        setFolders(data.folders || []);
        setArtifacts(data.artifacts || []);
    };

    useEffect(() => {
        const controller = new AbortController();
        loadFolder(currentFolderId, controller.signal).catch((err) => setUploadMessage(err.message));
        return () => controller.abort();
    }, [currentFolderId, searchTerm, filterProject, filterTask, filterCustomer]);

    const workspaceName = currentFolder ? currentFolder.name : "Root";

    const previewArtifact = (artifact: ArtifactRow) => {
        if (artifact.contentText) {
            setPreviewText(artifact.contentText);
            setPreviewTitle(artifact.title || artifact.originalFilename || "Artifact");
        } else {
            setPreviewText("No inline text to preview.");
            setPreviewTitle(artifact.title || artifact.originalFilename || "Artifact");
        }
    };

    const handleDownloadArtifact = async (artifactId: string) => {
        try {
            const response = await fetch(`/api/ui/artifacts/${artifactId}/download`);
            if (!response.ok) {
                throw new Error("Download failed");
            }
            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = "artifact";
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
        } catch (err) {
            const message = err instanceof Error ? err.message : "Unable to download";
            setUploadMessage(message);
        }
    };

    const handleUpload = async (file: File) => {
        if (!projects.length || !tasks.length) {
            setUploadMessage("Projects and tasks must exist before uploading.");
            return;
        }
        setUploading(true);
        setUploadMessage(null);
        try {
            const form = new FormData();
            form.append("file", file);
            form.append("projectId", projects[0].id);
            form.append("taskId", tasks[0].id);
            form.append("kind", "working_file");
            form.append("importance", "operational");
            form.append("artifactClass", "working_file");
            form.append("title", file.name);
            if (currentFolderId) {
                form.append("folderId", currentFolderId);
            }
            const metadata = metadataRef.current?.value;
            if (metadata) {
                form.append("metadataJson", metadata);
            }
            const response = await fetch("/api/ui/artifacts/upload", {
                method: "POST",
                body: form,
            });
            if (!response.ok) {
                const body = await response.json().catch(() => null);
                throw new Error(body?.error || "Upload failed");
            }
            setUploadMessage("Upload successful");
            metadataRef.current!.value = "";
            loadFolder(currentFolderId).catch((err) => setUploadMessage(err.message));
        } catch (err) {
            const message = err instanceof Error ? err.message : "Upload failed";
            setUploadMessage(message);
        } finally {
            setUploading(false);
        }
    };

    const handleFileDrop = (event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        const file = event.dataTransfer.files?.[0];
        if (file) {
            handleUpload(file);
        }
    };

    const breadcrumbs = useMemo(() => {
        const trail: Array<{ id: string | null; name: string }> = [{ id: null, name: "Root" }];
        ancestors.forEach((folder: FolderDto) => {
            trail.push({ id: folder.id, name: folder.name });
        });
        if (currentFolder) {
            trail.push({ id: currentFolder.id, name: currentFolder.name });
        }
        return trail;
    }, [ancestors, currentFolder]);

    const handleSelectFolder = (folderId: string | null) => {
        setCurrentFolderId(folderId);
    };

    const handleInputChange = (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
        const { name, value } = event.target;
        if (name === "search") {
            setSearchTerm(value);
        } else if (name === "project") {
            setFilterProject(value);
        } else if (name === "task") {
            setFilterTask(value);
        } else if (name === "customer") {
            setFilterCustomer(value);
        }
    };

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap gap-2 text-xs text-zinc-400">
                {breadcrumbs.map((crumb, index) => (
                    <button
                        key={crumb.id ?? "root"}
                        className="text-zinc-200 hover:text-white"
                        onClick={() => setCurrentFolderId(crumb.id ?? null)}
                    >
                        {index > 0 && <span className="mx-1 text-zinc-600">/</span>}
                        {crumb.name}
                    </button>
                ))}
            </div>
            <div className="grid gap-4 md:grid-cols-[260px_1fr]">
                <Card className="bg-zinc-950 border border-zinc-800/80">
                    <CardHeader className="border-b border-zinc-800/70 px-4 py-3">
                        <CardTitle className="text-sm text-zinc-100">Folders</CardTitle>
                    </CardHeader>
                    <CardContent className="px-0 py-3">
                        <ScrollArea className="max-h-[60vh] px-2">
                            {[{ id: null, name: "Root" }, ...folders].map((folder) => (
                                <button
                                    key={folder.id ?? "root"}
                                    className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm rounded ${folder.id === currentFolder?.id ? "bg-indigo-500/10 text-indigo-200" : "text-zinc-300 hover:bg-zinc-800/60"}`}
                                    onClick={() => handleSelectFolder(folder.id ?? null)}
                                >
                                    <Folder className="w-4 h-4 text-indigo-400" />
                                    <span className="truncate">{folder.name}</span>
                                </button>
                            ))}
                        </ScrollArea>
                    </CardContent>
                </Card>
                <div className="space-y-3">
                    <Card className="bg-zinc-950 border border-zinc-800/80">
                        <CardHeader className="border-b border-zinc-800/70 px-4 py-3">
                            <CardTitle className="text-sm text-zinc-100">Filters</CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-2 px-4 py-3">
                            <div className="grid gap-2 md:grid-cols-2">
                                <Input name="search" placeholder="Search files" value={searchTerm} onChange={handleInputChange} />
                                <select name="project" value={filterProject} onChange={handleInputChange} className="rounded border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100">
                                    <option value="">All projects</option>
                                    {projects.map((project) => (
                                        <option key={project.id} value={project.id}>
                                            {project.name}
                                        </option>
                                    ))}
                                </select>
                            </div>
                            <div className="grid gap-2 md:grid-cols-2">
                                <select name="task" value={filterTask} onChange={handleInputChange} className="rounded border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100">
                                    <option value="">All tasks</option>
                                    {tasks.map((task) => (
                                        <option key={task.id} value={task.id}>
                                            {task.type}
                                        </option>
                                    ))}
                                </select>
                                <select name="customer" value={filterCustomer} onChange={handleInputChange} className="rounded border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100">
                                    <option value="">All customers</option>
                                    {customers.map((customer) => (
                                        <option key={customer.id} value={customer.id}>
                                            {customer.name}
                                        </option>
                                    ))}
                                </select>
                            </div>
                        </CardContent>
                    </Card>
                    <Card className="bg-zinc-950 border border-zinc-800/80">
                        <CardHeader className="border-b border-zinc-800/70 px-4 py-3">
                            <CardTitle className="text-base text-zinc-100">Artifacts in {workspaceName}</CardTitle>
                        </CardHeader>
                        <CardContent className="p-0">
                            <ScrollArea className="max-h-[400px]">
                                <Table className="min-w-full text-sm text-zinc-100">
                                    <TableHeader className="bg-zinc-900/70">
                                        <TableRow>
                                            <TableHead>Artifact</TableHead>
                                            <TableHead>Context</TableHead>
                                            <TableHead>Size</TableHead>
                                            <TableHead>Date</TableHead>
                                            <TableHead className="text-right">Actions</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {artifacts.map((artifact) => (
                                            <TableRow key={artifact.id} className="hover:bg-zinc-800/50 transition-colors">
                                                <TableCell>
                                                    <div className="flex items-center gap-2">
                                                        <FileText className="w-4 h-4 text-indigo-400" />
                                                        <div>
                                                            <p className="text-xs font-semibold">{artifact.title || artifact.originalFilename || "Artifact"}</p>
                                                            <div className="flex items-center gap-1 text-[11px] text-zinc-500">
                                                                <Badge variant="outline">{artifact.artifactClass}</Badge>
                                                                <Badge variant="outline">{artifact.importance}</Badge>
                                                            </div>
                                                        </div>
                                                    </div>
                                                </TableCell>
                                                <TableCell>
                                                    <p className="text-xs text-zinc-400">{artifact.taskType || "No task"}</p>
                                                    <p className="text-[11px] text-zinc-500">{artifact.projectGoal || "No project"}</p>
                                                </TableCell>
                                                <TableCell>{formatBytes(artifact.sizeBytes || 0)}</TableCell>
                                                <TableCell>{formatDate(artifact.createdAt)}</TableCell>
                                                <TableCell className="text-right">
                                                    <div className="flex items-center justify-end gap-2">
                                                        <Button size="icon" variant="ghost" onClick={() => previewArtifact(artifact)}>
                                                            <Eye className="w-4 h-4" />
                                                        </Button>
                                                        <Button size="icon" variant="ghost" onClick={() => handleDownloadArtifact(artifact.id)}>
                                                            <Download className="w-4 h-4" />
                                                        </Button>
                                                    </div>
                                                </TableCell>
                                            </TableRow>
                                        ))}
                                    </TableBody>
                                </Table>
                            </ScrollArea>
                        </CardContent>
                    </Card>
                </div>
            </div>
            {previewText && (
                <Card className="bg-zinc-950 border border-zinc-800/80">
                    <CardHeader className="border-b border-zinc-800/70 px-4 py-3 flex items-center justify-between">
                        <CardTitle className="text-sm text-zinc-100">{previewTitle}</CardTitle>
                        <Button size="icon" variant="ghost" onClick={() => setPreviewText(null)}>
                            <Trash2 className="w-4 h-4" />
                        </Button>
                    </CardHeader>
                    <CardContent className="px-4 py-3">
                        <MarkdownRenderer content={previewText} />
                    </CardContent>
                </Card>
            )}
            <Card className="bg-zinc-950 border border-zinc-800/80">
                <CardHeader className="border-b border-zinc-800/70 px-4 py-3">
                    <CardTitle className="text-sm text-zinc-100">Upload File</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3 px-4 py-4">
                    <Textarea ref={metadataRef} className="bg-zinc-900 text-zinc-100" placeholder='{"notes": "Version 1"}' rows={2} />
                    <div
                        className="rounded border-2 border-dashed border-zinc-800 px-4 py-8 text-center text-sm text-zinc-400 hover:border-indigo-500 hover:text-white"
                        onDragOver={(event) => {
                            event.preventDefault();
                        }}
                        onDrop={handleFileDrop}
                    >
                        <input ref={fileInputRef} type="file" className="hidden" onChange={(event) => {
                            const file = event.target.files?.[0];
                            if (file) {
                                handleUpload(file);
                            }
                        }} />
                        <p>Drop file or</p>
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={() => fileInputRef.current?.click()}
                            disabled={uploading}
                        >
                            <Plus className="w-4 h-4 mr-2" />
                            Select file
                        </Button>
                    </div>
                    {uploadMessage && <p className="text-xs text-zinc-400">{uploadMessage}</p>}
                </CardContent>
            </Card>
        </div>
    );
}
