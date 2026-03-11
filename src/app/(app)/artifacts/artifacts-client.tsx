"use client";

import { useState, useEffect, useMemo } from "react";
import { FileBox, FileJson, Clock, Target, CalendarDays, ExternalLink, Activity, ScanLine, X, Folder, ChevronRight, File, ArrowLeft } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { MarkdownRenderer } from "@/components/markdown-renderer";

type PathNode = {
    type: 'customer' | 'project' | 'kind';
    id: string;
    name: string;
};

export default function ArtifactsClient({
    initialArtifacts,
    projects,
    customers
}: {
    initialArtifacts: any[],
    projects: any[],
    customers: any[]
}) {
    const [artifacts, setArtifacts] = useState(initialArtifacts);
    const [selectedArtifact, setSelectedArtifact] = useState<any | null>(null);
    const [viewMode, setViewMode] = useState<'preview' | 'raw'>('preview');
    const [currentPath, setCurrentPath] = useState<PathNode[]>([]);

    const handleDownload = (content: string, contentType: string, artifactId: string) => {
        const blob = new Blob([content], { type: contentType || 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;

        let extension = "txt";
        if (contentType?.includes("json") || content.trim().startsWith("{")) extension = "json";
        if (contentType?.includes("markdown") || contentType?.includes("md")) extension = "md";
        if (contentType?.includes("csv")) extension = "csv";

        a.download = `artifact_${artifactId.split('-')[0]}.${extension}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    // Polling loop for real-time updates
    useEffect(() => {
        const intervalId = setInterval(async () => {
            try {
                const res = await fetch("/api/artifacts");
                if (res.ok) {
                    const data = await res.json();
                    if (data.artifacts) {
                        setArtifacts(data.artifacts);
                    }
                }
            } catch (err) {
                console.error("Artifacts polling error", err);
            }
        }, 5000); // 5 seconds

        return () => clearInterval(intervalId);
    }, []);

    const formatBytes = (bytes: number) => {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    };

    // Navigation helpers
    const navigateTo = (node: PathNode) => setCurrentPath(prev => [...prev, node]);
    const navigateBack = () => setCurrentPath(prev => prev.slice(0, -1));
    const navigateToCrumb = (index: number) => setCurrentPath(prev => prev.slice(0, index + 1));
    const navigateHome = () => setCurrentPath([]);

    // Derived view data
    const viewData = useMemo(() => {
        let items: any[] = [];
        let viewType: 'folders' | 'files' = 'folders';

        if (currentPath.length === 0) {
            // Root Level: Group by Customer
            const customerMap = new Map();
            artifacts.forEach(a => {
                const cId = a.customerId || 'unassigned';
                const cName = a.customerName || 'Unassigned Customer';
                if (!customerMap.has(cId)) {
                    customerMap.set(cId, { id: cId, name: cName, count: 0, type: 'customer' });
                }
                customerMap.get(cId).count++;
            });
            items = Array.from(customerMap.values()).sort((a, b) => a.name.localeCompare(b.name));
            viewType = 'folders';

        } else if (currentPath.length === 1) {
            // Customer Level: Group by Project
            const customerId = currentPath[0].id;
            const projMap = new Map();
            artifacts.filter(a => (a.customerId || 'unassigned') === customerId).forEach(a => {
                const pId = a.projectId || 'unassigned';
                const pName = a.projectGoal || 'Unassigned Project';
                if (!projMap.has(pId)) {
                    projMap.set(pId, { id: pId, name: pName, count: 0, type: 'project' });
                }
                projMap.get(pId).count++;
            });
            items = Array.from(projMap.values()).sort((a, b) => a.name.localeCompare(b.name));
            viewType = 'folders';

        } else if (currentPath.length === 2) {
            // Project Level: Group by Kind
            const customerId = currentPath[0].id;
            const projectId = currentPath[1].id;
            const kindMap = new Map();
            artifacts
                .filter(a => (a.customerId || 'unassigned') === customerId && (a.projectId || 'unassigned') === projectId)
                .forEach(a => {
                    const kId = a.kind || 'data';
                    const kName = kId.charAt(0).toUpperCase() + kId.slice(1);
                    if (!kindMap.has(kId)) {
                        kindMap.set(kId, { id: kId, name: kName, count: 0, type: 'kind' });
                    }
                    kindMap.get(kId).count++;
                });
            items = Array.from(kindMap.values()).sort((a, b) => a.name.localeCompare(b.name));
            viewType = 'folders';

        } else if (currentPath.length >= 3) {
            // Kind Level: Show Files
            const customerId = currentPath[0].id;
            const projectId = currentPath[1].id;
            const kindId = currentPath[2].id;
            items = artifacts.filter(a =>
                (a.customerId || 'unassigned') === customerId &&
                (a.projectId || 'unassigned') === projectId &&
                (a.kind || 'data') === kindId
            ).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
            viewType = 'files';
        }

        return { items, viewType };
    }, [artifacts, currentPath]);

    return (
        <div className="flex-1 overflow-auto bg-zinc-950/30 p-8 h-full">
            <div className="max-w-7xl mx-auto space-y-6">

                {/* Header */}
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div>
                        <h1 className="text-3xl font-semibold tracking-tight text-zinc-100 flex items-center gap-3">
                            <FileBox className="w-8 h-8 text-indigo-400" />
                            Workforce Artifacts
                        </h1>
                        <p className="text-zinc-400 mt-2">
                            A centralized repository of deliverables, reports, and data outputs generated by OpenClaw agents.
                        </p>
                    </div>
                </div>

                {/* Breadcrumb Navigation */}
                <div className="flex items-center gap-2 text-sm text-zinc-400 bg-zinc-900/40 p-3.5 rounded-xl border border-zinc-800/80 shadow-sm backdrop-blur-sm overflow-x-auto">
                    {currentPath.length > 0 && (
                        <button onClick={navigateBack} className="p-1 hover:bg-zinc-800 rounded-md transition-colors mr-2 cursor-pointer" title="Go back">
                            <ArrowLeft className="w-4 h-4 text-zinc-300" />
                        </button>
                    )}
                    <button onClick={navigateHome} className={`flex items-center gap-1.5 transition-colors whitespace-nowrap px-2 py-1 rounded-md ${currentPath.length === 0 ? 'text-indigo-400 bg-indigo-500/10 font-medium' : 'hover:text-zinc-100 hover:bg-zinc-800'}`}>
                        <FileBox className="w-4 h-4" /> Root
                    </button>
                    {currentPath.map((node, i) => (
                        <div key={node.id} className="flex items-center gap-2 whitespace-nowrap">
                            <ChevronRight className="w-4 h-4 text-zinc-600" />
                            <button
                                onClick={() => navigateToCrumb(i)}
                                className={`px-2 py-1 rounded-md transition-colors truncate max-w-[200px] ${i === currentPath.length - 1 ? 'text-indigo-400 bg-indigo-500/10 font-medium' : 'hover:text-zinc-100 hover:bg-zinc-800'}`}
                            >
                                {node.name}
                            </button>
                        </div>
                    ))}
                </div>

                {/* Main Content Area */}
                <Card className="bg-zinc-900/50 border-zinc-800/80 backdrop-blur-sm overflow-hidden min-h-[500px] flex flex-col">
                    <CardHeader className="border-b border-zinc-800/80 bg-zinc-900/40 px-6 py-5 flex flex-row items-center justify-between">
                        <div>
                            <CardTitle className="text-lg font-medium text-zinc-100 flex items-center gap-2">
                                {viewData.viewType === 'folders' ? (
                                    <><Folder className="w-5 h-5 text-indigo-400" /> Folders ({viewData.items.length})</>
                                ) : (
                                    <><FileJson className="w-5 h-5 text-indigo-400" /> Files ({viewData.items.length})</>
                                )}
                            </CardTitle>
                            <CardDescription className="text-zinc-400 mt-1">Live polling for new deliverables.</CardDescription>
                        </div>
                        <div className="flex items-center gap-2">
                            <Activity className="w-4 h-4 text-emerald-400 animate-pulse" />
                            <span className="text-xs text-emerald-500/80 font-medium">Auto-Sync Active</span>
                        </div>
                    </CardHeader>

                    <CardContent className="p-0 flex-1 relative">
                        {viewData.items.length === 0 ? (
                            <div className="absolute inset-0 flex flex-col items-center justify-center text-zinc-500">
                                <ScanLine className="w-10 h-10 mb-4 text-zinc-700 animate-pulse" />
                                <p>No items found in this location.</p>
                                {viewData.viewType === 'folders' && <p className="text-sm mt-2">Outputs generated by Agents will appear here naturally.</p>}
                            </div>
                        ) : (
                            <ScrollArea className="h-[600px] w-full">
                                {viewData.viewType === 'folders' ? (
                                    <div className="p-6 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                                        {viewData.items.map((folder: any) => (
                                            <div
                                                key={folder.id}
                                                onClick={() => navigateTo({ type: folder.type, id: folder.id, name: folder.name })}
                                                className="flex items-center gap-4 p-5 bg-zinc-950/50 hover:bg-zinc-800 border border-zinc-800/80 hover:border-indigo-500/50 rounded-xl cursor-pointer transition-all duration-200 group"
                                            >
                                                <div className="p-3 bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 rounded-lg group-hover:scale-110 group-hover:bg-indigo-500/20 transition-all duration-300">
                                                    <Folder className="w-6 h-6 fill-indigo-500/20 group-hover:fill-indigo-500/40 transition-colors" />
                                                </div>
                                                <div className="flex flex-col min-w-0">
                                                    <span className="text-zinc-200 font-medium truncate" title={folder.name}>{folder.name}</span>
                                                    <span className="text-xs text-zinc-500 mt-0.5">{folder.count} item{folder.count !== 1 ? 's' : ''}</span>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                ) : (
                                    <div className="min-w-max">
                                        <table className="w-full text-sm text-left">
                                            <thead className="text-xs text-zinc-400 uppercase bg-zinc-900/80 border-b border-zinc-800/50 sticky top-0 z-10 backdrop-blur-md">
                                                <tr>
                                                    <th className="px-6 py-4 font-medium tracking-wider w-[20%]">Artifact Kind</th>
                                                    <th className="px-6 py-4 font-medium tracking-wider w-[35%]">Context Task</th>
                                                    <th className="px-6 py-4 font-medium tracking-wider w-[10%]">Size</th>
                                                    <th className="px-6 py-4 font-medium tracking-wider w-[20%]">Date Created</th>
                                                    <th className="px-6 py-4 font-medium tracking-wider w-[15%] text-right">Actions</th>
                                                </tr>
                                            </thead>
                                            <tbody className="divide-y divide-zinc-800/50 text-zinc-300">
                                                {viewData.items.map((artifact: any) => (
                                                    <tr key={artifact.id} className="hover:bg-zinc-800/30 transition-colors group">
                                                        <td className="px-6 py-4 font-medium flex items-center gap-3">
                                                            <File className="w-5 h-5 text-indigo-500/70" />
                                                            <div className="flex flex-col">
                                                                <span className="text-zinc-200 capitalize">{artifact.kind || "Data"}</span>
                                                                <span className="text-xs text-zinc-500 font-mono mt-0.5 max-w-[150px] truncate" title={artifact.contentType}>{artifact.contentType || "text/plain"}</span>
                                                            </div>
                                                        </td>
                                                        <td className="px-6 py-4">
                                                            <span className="text-zinc-300 flex items-center gap-2" title={artifact.taskType || "unknown task"}>
                                                                <Target className="w-4 h-4 text-zinc-500" />
                                                                {artifact.taskType || "unknown task"}
                                                            </span>
                                                        </td>
                                                        <td className="px-6 py-4 text-zinc-400 font-mono text-xs">
                                                            {formatBytes(artifact.sizeBytes || 0)}
                                                        </td>
                                                        <td className="px-6 py-4 whitespace-nowrap text-zinc-400 flex items-center gap-2">
                                                            <CalendarDays className="w-4 h-4 text-zinc-500" />
                                                            {new Date(artifact.createdAt).toLocaleString(undefined, {
                                                                month: 'short', day: 'numeric',
                                                                hour: '2-digit', minute: '2-digit'
                                                            })}
                                                        </td>
                                                        <td className="px-6 py-4 text-right flex justify-end gap-2">
                                                            {artifact.storageUrl ? (
                                                                <Button variant="outline" size="sm" asChild className="opacity-0 group-hover:opacity-100 transition-opacity border-indigo-500/30 hover:bg-indigo-500/10 hover:text-indigo-300 text-indigo-400 bg-transparent h-8">
                                                                    <a href={artifact.storageUrl} target="_blank" rel="noopener noreferrer">
                                                                        Open Link <ExternalLink className="w-3 h-3 ml-2" />
                                                                    </a>
                                                                </Button>
                                                            ) : artifact.contentText ? (
                                                                <>
                                                                    <Button onClick={() => handleDownload(artifact.contentText!, artifact.contentType!, artifact.id)} variant="outline" size="sm" className="opacity-0 group-hover:opacity-100 transition-opacity border-zinc-500/30 hover:bg-zinc-500/10 hover:text-zinc-300 text-zinc-400 bg-transparent h-8">
                                                                        Download
                                                                    </Button>
                                                                    <Button onClick={() => setSelectedArtifact(artifact)} variant="outline" size="sm" className="opacity-0 group-hover:opacity-100 transition-opacity border-emerald-500/30 hover:bg-emerald-500/10 hover:text-emerald-300 text-emerald-400 bg-transparent h-8">
                                                                        View
                                                                    </Button>
                                                                </>
                                                            ) : (
                                                                <span className="text-xs text-zinc-600 italic">No Payload</span>
                                                            )}
                                                        </td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                )}
                            </ScrollArea>
                        )}
                    </CardContent>
                </Card>

            </div>

            {/* Content View Modal */}
            <Dialog open={!!selectedArtifact} onOpenChange={(open: boolean) => {
                if (!open) {
                    setSelectedArtifact(null);
                    setViewMode('preview');
                }
            }}>
                <DialogContent className="sm:max-w-[800px] bg-zinc-950 border-zinc-800 text-zinc-200 shadow-2xl p-0 gap-0 flex flex-col max-h-[90vh]">
                    <DialogHeader className="px-6 py-4 border-b border-zinc-800/80 bg-zinc-900/50 flex flex-row items-center justify-between shrink-0">
                        <div className="flex flex-col">
                            <DialogTitle className="text-lg font-semibold tracking-tight">Artifact Payload</DialogTitle>
                            <DialogDescription className="text-zinc-400 mt-1">
                                {selectedArtifact?.kind || "Data"} — {selectedArtifact?.contentType || "text/plain"}
                            </DialogDescription>
                        </div>
                        <div className="flex items-center gap-2 mr-6">
                            <div className="bg-zinc-900 p-0.5 rounded-lg border border-zinc-800 flex">
                                <button
                                    onClick={() => setViewMode('preview')}
                                    className={`px-3 py-1 text-xs font-medium rounded-md transition-all ${viewMode === 'preview' ? 'bg-indigo-600 text-white shadow-sm' : 'text-zinc-400 hover:text-zinc-200'}`}
                                >
                                    Preview
                                </button>
                                <button
                                    onClick={() => setViewMode('raw')}
                                    className={`px-3 py-1 text-xs font-medium rounded-md transition-all ${viewMode === 'raw' ? 'bg-indigo-600 text-white shadow-sm' : 'text-zinc-400 hover:text-zinc-200'}`}
                                >
                                    Raw
                                </button>
                            </div>
                        </div>
                    </DialogHeader>

                    <div className="p-6 bg-zinc-950 overflow-y-auto flex-1">
                        {viewMode === 'preview' ? (
                            <MarkdownRenderer content={selectedArtifact?.contentText || ""} />
                        ) : (
                            <pre className="text-sm font-mono text-zinc-300 whitespace-pre-wrap bg-zinc-900/50 p-4 border border-zinc-800/50 rounded-lg">
                                {selectedArtifact?.contentText}
                            </pre>
                        )}
                    </div>
                </DialogContent>
            </Dialog>

        </div>
    );
}
