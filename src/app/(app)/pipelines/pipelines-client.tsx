"use client";

import { useEffect, useState } from "react";
import { ArrowRight, Clock, FileJson, FolderKanban, Repeat, ShieldCheck } from "lucide-react";

type ScheduleRow = {
    id: string;
    name: string;
    status: string;
    cronExpression: string;
    nextRunAt: string | Date | null;
    agentPattern: string | null;
    targetProjectId: string | null;
    targetCustomerId: string | null;
};

type PlaybookRow = {
    id: string;
    name: string;
    description: string | null;
    requiredSkillsJson: unknown;
    instructionsJson: unknown;
};

export default function PipelinesClient({
    initialPlaybooks,
    initialSchedules,
    projectsMap,
    customersMap,
}: {
    initialPlaybooks: PlaybookRow[];
    initialSchedules: ScheduleRow[];
    projectsMap: Record<string, string>;
    customersMap: Record<string, string>;
}) {
    const [playbooks, setPlaybooks] = useState(initialPlaybooks);
    const [schedules, setSchedules] = useState(initialSchedules);

    useEffect(() => {
        const fetchPipelines = async () => {
            try {
                const res = await fetch("/api/pipelines");
                if (!res.ok) return;
                const data = await res.json();
                setPlaybooks(Array.isArray(data.playbooks) ? data.playbooks : []);
                setSchedules(Array.isArray(data.schedules) ? data.schedules : []);
            } catch (error) {
                console.error("Error polling legacy automation state", error);
            }
        };

        const interval = setInterval(fetchPipelines, 10000);
        return () => clearInterval(interval);
    }, []);

    return (
        <div className="max-w-6xl mx-auto space-y-8 animate-in fade-in duration-500">
            <div className="space-y-3">
                <div className="inline-flex items-center rounded-full border border-amber-500/20 bg-amber-500/10 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.2em] text-amber-300">
                    Legacy Surface
                </div>
                <h1 className="text-3xl font-semibold tracking-tight text-white flex items-center">
                    <Repeat className="w-8 h-8 mr-3 text-amber-400" />
                    Automation Migration
                </h1>
                <p className="max-w-3xl text-sm font-medium leading-6 text-zinc-400">
                    Pipelines are no longer the primary workflow surface. New automation should be modeled as project recurring tasks,
                    scoped resources, and project agent profiles. This page remains for read-only visibility into legacy schedules and
                    playbooks that may still exist in older deployments.
                </p>
            </div>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
                    <div className="flex items-center gap-2 text-zinc-200">
                        <FolderKanban className="h-5 w-5 text-indigo-400" />
                        <h2 className="text-base font-semibold">Use Projects</h2>
                    </div>
                    <p className="mt-2 text-sm leading-6 text-zinc-500">
                        Put recurring operational work inside the target project so it shares approvals, kanban state, storage files, and threads.
                    </p>
                </div>
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
                    <div className="flex items-center gap-2 text-zinc-200">
                        <ShieldCheck className="h-5 w-5 text-emerald-400" />
                        <h2 className="text-base font-semibold">Use Knowledge & Rules</h2>
                    </div>
                    <p className="mt-2 text-sm leading-6 text-zinc-500">
                        Customer and project credentials, identities, mailboxes, and templates should live in Knowledge & Rules, not hidden inside playbooks.
                    </p>
                </div>
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
                    <div className="flex items-center gap-2 text-zinc-200">
                        <ArrowRight className="h-5 w-5 text-rose-400" />
                        <h2 className="text-base font-semibold">Keep It Honest</h2>
                    </div>
                    <p className="mt-2 text-sm leading-6 text-zinc-500">
                        There is no natural-language playbook drafting here anymore. Emperor stores automation state; OpenClaw still executes the work.
                    </p>
                </div>
            </div>

            <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
                <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl overflow-hidden flex flex-col">
                    <div className="p-6 border-b border-zinc-800 bg-zinc-900/80 flex items-center justify-between">
                        <div className="flex items-center space-x-2">
                            <Clock className="w-5 h-5 text-indigo-400" />
                            <h2 className="text-lg font-medium text-white">Legacy Schedules</h2>
                        </div>
                        <span className="text-xs font-semibold px-2.5 py-1 bg-indigo-500/20 text-indigo-300 rounded-full border border-indigo-500/30">
                            {schedules.length} Visible
                        </span>
                    </div>

                    <div className="divide-y divide-zinc-800/60 overflow-y-auto max-h-[600px]">
                        {schedules.length === 0 ? (
                            <div className="p-8 text-center text-zinc-500">
                                <Clock className="w-8 h-8 mx-auto mb-3 opacity-20" />
                                No legacy schedules are registered.
                            </div>
                        ) : (
                            schedules.map((schedule) => (
                                <div key={schedule.id} className="p-5 hover:bg-zinc-800/30 transition-colors">
                                    <div className="flex justify-between items-start mb-2 gap-3">
                                        <h3 className="font-semibold text-zinc-200">{schedule.name}</h3>
                                        <span className={`text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded border ${schedule.status === "active" ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" : "bg-zinc-500/10 text-zinc-400 border-zinc-500/20"}`}>
                                            {schedule.status}
                                        </span>
                                    </div>
                                    <div className="text-xs text-zinc-400 space-y-2">
                                        <div className="font-mono">{schedule.cronExpression}</div>
                                        {schedule.nextRunAt && <div>Next run: {new Date(schedule.nextRunAt).toLocaleString()}</div>}
                                        {schedule.agentPattern && <div>Agent pattern: <span className="font-mono text-zinc-300">{schedule.agentPattern}</span></div>}
                                        {schedule.targetProjectId && <div>Project: <span className="text-zinc-300">{projectsMap[schedule.targetProjectId] || "Unknown project"}</span></div>}
                                        {schedule.targetCustomerId && <div>Customer: <span className="text-zinc-300">{customersMap[schedule.targetCustomerId] || "Unknown customer"}</span></div>}
                                    </div>
                                </div>
                            ))
                        )}
                    </div>
                </div>

                <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl overflow-hidden flex flex-col">
                    <div className="p-6 border-b border-zinc-800 bg-zinc-900/80 flex items-center justify-between">
                        <div className="flex items-center space-x-2">
                            <FileJson className="w-5 h-5 text-amber-400" />
                            <h2 className="text-lg font-medium text-white">Legacy Playbooks</h2>
                        </div>
                        <span className="text-xs font-semibold px-2.5 py-1 bg-amber-500/20 text-amber-300 rounded-full border border-amber-500/30">
                            {playbooks.length} Visible
                        </span>
                    </div>

                    <div className="divide-y divide-zinc-800/60 overflow-y-auto max-h-[600px]">
                        {playbooks.length === 0 ? (
                            <div className="p-8 text-center text-zinc-500">
                                <FileJson className="w-8 h-8 mx-auto mb-3 opacity-20" />
                                No legacy playbooks are registered.
                            </div>
                        ) : (
                            playbooks.map((playbook) => {
                                const requiredSkills = Array.isArray(playbook.requiredSkillsJson) ? playbook.requiredSkillsJson : [];
                                return (
                                    <div key={playbook.id} className="p-5 hover:bg-zinc-800/30 transition-colors">
                                        <h3 className="font-semibold text-zinc-200 mb-1">{playbook.name}</h3>
                                        {playbook.description && <p className="text-sm text-zinc-400 mb-3">{playbook.description}</p>}
                                        <div className="flex flex-wrap gap-2 mt-2">
                                            {requiredSkills.length > 0 ? (
                                                requiredSkills.map((skill, idx) => (
                                                    <span key={`${playbook.id}-${idx}`} className="text-xs px-2 py-0.5 bg-zinc-800 text-zinc-400 rounded-sm border border-zinc-700">
                                                        {String(skill)}
                                                    </span>
                                                ))
                                            ) : (
                                                <span className="text-xs text-zinc-600">No explicit skills listed</span>
                                            )}
                                        </div>
                                        <div className="mt-4 pt-3 border-t border-zinc-800/50">
                                            <p className="text-xs text-zinc-500 mb-2">Stored Instructions</p>
                                            <div className="bg-zinc-950 p-3 rounded border border-zinc-800 text-xs font-mono text-zinc-400 overflow-hidden line-clamp-4">
                                                {JSON.stringify(playbook.instructionsJson)}
                                            </div>
                                        </div>
                                    </div>
                                );
                            })
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
