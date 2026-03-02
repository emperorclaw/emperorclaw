"use client";

import { useState, useEffect } from "react";
import { Repeat, FileJson, Clock, Target, CalendarDays, Activity, Plus, X, Send } from "lucide-react";

export default function PipelinesClient({
    initialPlaybooks,
    initialSchedules,
    projectsMap
}: {
    initialPlaybooks: any[],
    initialSchedules: any[],
    projectsMap: Record<string, string>
}) {
    const [playbooks, setPlaybooks] = useState(initialPlaybooks);
    const [schedules, setSchedules] = useState(initialSchedules);
    const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);

    // Playbook Form
    const [pbName, setPbName] = useState("");
    const [pbDesc, setPbDesc] = useState("");
    const [pbInstructions, setPbInstructions] = useState("");
    const [isSending, setIsSending] = useState(false);

    useEffect(() => {
        const fetchPipelines = async () => {
            try {
                const res = await fetch("/api/pipelines");
                if (res.ok) {
                    const data = await res.json();
                    setPlaybooks(data.playbooks);
                    setSchedules(data.schedules);
                }
            } catch (error) {
                console.error("Error polling pipelines", error);
            }
        };

        const interval = setInterval(fetchPipelines, 5000);
        return () => clearInterval(interval);
    }, []);

    const handleCreatePlaybook = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!pbName.trim()) return;
        setIsSending(true);

        const prompt = `Please create a new playbook named "${pbName.trim()}".\n\nDescription: ${pbDesc.trim() || 'None'}\n\nInstructions (JSON format expected):\n${pbInstructions.trim()}`;

        try {
            await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: prompt })
            });

            setIsCreateModalOpen(false);
            setPbName("");
            setPbDesc("");
            setPbInstructions("");
        } catch (error) {
            console.error("Failed to send playbook creation request", error);
        } finally {
            setIsSending(false);
        }
    };

    return (
        <div className="max-w-6xl mx-auto space-y-8 animate-in fade-in duration-500">
            <div className="flex flex-col space-y-2">
                <h1 className="text-3xl font-semibold tracking-tight text-white flex items-center">
                    <Repeat className="w-8 h-8 mr-3 text-emerald-400" />
                    Automated Pipelines
                </h1>
                <p className="text-zinc-400 font-medium">Read-only visibility into OpenClaw's registered cron schedules and global playbook templates.</p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                {/* Schedulers */}
                <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl overflow-hidden flex flex-col">
                    <div className="p-6 border-b border-zinc-800 bg-zinc-900/80 flex items-center justify-between">
                        <div className="flex items-center space-x-2">
                            <Clock className="w-5 h-5 text-indigo-400" />
                            <h2 className="text-lg font-medium text-white">OpenClaw Schedules</h2>
                        </div>
                        <span className="text-xs font-semibold px-2.5 py-1 bg-indigo-500/20 text-indigo-300 rounded-full border border-indigo-500/30">
                            {schedules.length} Active
                        </span>
                    </div>

                    <div className="divide-y divide-zinc-800/60 overflow-y-auto max-h-[600px]">
                        {schedules.length === 0 ? (
                            <div className="p-8 text-center text-zinc-500">
                                <Activity className="w-8 h-8 mx-auto mb-3 opacity-20" />
                                No schedules pushed from OpenClaw yet.
                            </div>
                        ) : (
                            schedules.map((s: any) => (
                                <div key={s.id} className="p-5 hover:bg-zinc-800/30 transition-colors group">
                                    <div className="flex justify-between items-start mb-2">
                                        <h3 className="font-semibold text-zinc-200">{s.name}</h3>
                                        <span className={`text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded border ${s.status === 'active' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20'}`}>
                                            {s.status}
                                        </span>
                                    </div>
                                    <p className="text-xs text-zinc-400 mb-3 space-x-4">
                                        <span className="inline-flex items-center"><Repeat className="w-3 h-3 mr-1" /> {s.cronExpression}</span>
                                        {s.nextRunAt && <span className="inline-flex items-center"><CalendarDays className="w-3 h-3 mr-1" /> Next: {new Date(s.nextRunAt).toLocaleString()}</span>}
                                    </p>

                                    {s.targetProjectId && (
                                        <div className="mt-3 bg-zinc-950 rounded border border-zinc-800 p-2 text-xs flex items-center">
                                            <Target className="w-3 h-3 text-amber-500 mr-2" />
                                            <span className="text-zinc-500 mr-1">Bound to Project:</span>
                                            <span className="text-zinc-300 truncate">{projectsMap[s.targetProjectId] || "Unknown Project"}</span>
                                        </div>
                                    )}
                                </div>
                            ))
                        )}
                    </div>
                </div>

                {/* Templates */}
                <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl overflow-hidden flex flex-col">
                    <div className="p-6 border-b border-zinc-800 bg-zinc-900/80 flex items-center justify-between">
                        <div className="flex items-center space-x-2">
                            <FileJson className="w-5 h-5 text-amber-400" />
                            <h2 className="text-lg font-medium text-white">Registered Playbooks</h2>
                        </div>
                        <div className="flex items-center space-x-3">
                            <span className="text-xs font-semibold px-2.5 py-1 bg-amber-500/20 text-amber-300 rounded-full border border-amber-500/30">
                                {playbooks.length} Templates
                            </span>
                            <button
                                onClick={() => setIsCreateModalOpen(true)}
                                className="bg-amber-500 hover:bg-amber-400 text-amber-950 px-3 py-1.5 rounded-md text-xs font-bold tracking-tight flex items-center transition-colors"
                            >
                                <Plus className="w-3.5 h-3.5 mr-1" />
                                Create Playbook
                            </button>
                        </div>
                    </div>

                    <div className="divide-y divide-zinc-800/60 overflow-y-auto max-h-[600px]">
                        {playbooks.length === 0 ? (
                            <div className="p-8 text-center text-zinc-500">
                                <FileJson className="w-8 h-8 mx-auto mb-3 opacity-20" />
                                No global playbooks defined yet.
                            </div>
                        ) : (
                            playbooks.map((pb: any) => (
                                <div key={pb.id} className="p-5 hover:bg-zinc-800/30 transition-colors">
                                    <h3 className="font-semibold text-zinc-200 mb-1">{pb.name}</h3>
                                    {pb.description && <p className="text-sm text-zinc-400 mb-3">{pb.description}</p>}

                                    <div className="flex flex-wrap gap-2 mt-2">
                                        {Array.isArray(pb.requiredSkillsJson) && pb.requiredSkillsJson.length > 0 ? (
                                            pb.requiredSkillsJson.map((skill: string, idx: number) => (
                                                <span key={idx} className="text-xs px-2 py-0.5 bg-zinc-800 text-zinc-400 rounded-sm border border-zinc-700">
                                                    {skill}
                                                </span>
                                            ))
                                        ) : (
                                            <span className="text-xs text-zinc-600">No specific skills required</span>
                                        )}
                                    </div>

                                    <div className="mt-4 pt-3 border-t border-zinc-800/50">
                                        <p className="text-xs text-zinc-500 mb-2">Instructions Preview:</p>
                                        <div className="bg-zinc-950 p-3 rounded border border-zinc-800 text-xs font-mono text-zinc-400 overflow-hidden line-clamp-3">
                                            {JSON.stringify(pb.instructionsJson)}
                                        </div>
                                    </div>
                                </div>
                            ))
                        )}
                    </div>
                </div>
            </div>

            {isCreateModalOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
                    <div className="bg-zinc-950 border border-zinc-800 shadow-2xl rounded-2xl w-full max-w-lg overflow-hidden animate-in zoom-in-95 duration-200">
                        <div className="flex items-center justify-between p-4 border-b border-zinc-800 bg-zinc-900/50">
                            <h3 className="text-lg font-semibold text-zinc-100 flex items-center">
                                <FileJson className="w-5 h-5 text-amber-400 mr-2" />
                                Draft New Playbook
                            </h3>
                            <button
                                onClick={() => setIsCreateModalOpen(false)}
                                className="p-1.5 rounded-md hover:bg-zinc-800 text-zinc-500 transition-colors"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        </div>
                        <form onSubmit={handleCreatePlaybook} className="p-5 space-y-4">
                            <div className="space-y-1.5">
                                <label className="text-sm font-medium text-zinc-400">Playbook Name <span className="text-rose-500">*</span></label>
                                <input
                                    type="text"
                                    required
                                    value={pbName}
                                    onChange={(e) => setPbName(e.target.value)}
                                    placeholder="e.g. daily-lead-generation"
                                    className="w-full bg-zinc-900 border border-zinc-800 rounded-md p-2.5 text-sm text-zinc-200 focus:outline-none focus:ring-1 focus:ring-amber-500"
                                />
                            </div>
                            <div className="space-y-1.5">
                                <label className="text-sm font-medium text-zinc-400">Description</label>
                                <input
                                    type="text"
                                    value={pbDesc}
                                    onChange={(e) => setPbDesc(e.target.value)}
                                    placeholder="Brief overview of the process"
                                    className="w-full bg-zinc-900 border border-zinc-800 rounded-md p-2.5 text-sm text-zinc-200 focus:outline-none focus:ring-1 focus:ring-amber-500"
                                />
                            </div>
                            <div className="space-y-1.5">
                                <label className="text-sm font-medium text-zinc-400">Instructions</label>
                                <p className="text-xs text-zinc-500 mb-1">Describe the steps in natural language. OpenClaw will formalize this into a structured playbook schema automatically.</p>
                                <textarea
                                    required
                                    value={pbInstructions}
                                    onChange={(e) => setPbInstructions(e.target.value)}
                                    placeholder={'1. Go to this URL\n2. Extract the emails\n3. Save to a CSV'}
                                    className="w-full bg-zinc-900 border border-zinc-800 rounded-md p-2.5 text-sm font-sans text-zinc-300 focus:outline-none focus:ring-1 focus:ring-amber-500 min-h-[140px] resize-y"
                                />
                            </div>

                            <div className="pt-4 flex justify-end items-center border-t border-zinc-800/80">
                                <button
                                    type="submit"
                                    disabled={!pbName.trim() || !pbInstructions.trim() || isSending}
                                    className="bg-amber-500 hover:bg-amber-400 text-amber-950 px-4 py-2 rounded-md text-sm font-bold tracking-tight flex items-center transition-colors disabled:opacity-50"
                                >
                                    <Send className="w-4 h-4 mr-2" />
                                    {isSending ? "Sending..." : "Send Request to OpenClaw"}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
}
