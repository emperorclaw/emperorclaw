"use client";

import { Repeat, FileJson, Clock, Target, CalendarDays, Activity } from "lucide-react";

export default function PipelinesClient({
    initialPlaybooks,
    initialSchedules,
    projectsMap
}: {
    initialPlaybooks: any[],
    initialSchedules: any[],
    projectsMap: Record<string, string>
}) {

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
                            {initialSchedules.length} Active
                        </span>
                    </div>

                    <div className="divide-y divide-zinc-800/60 overflow-y-auto max-h-[600px]">
                        {initialSchedules.length === 0 ? (
                            <div className="p-8 text-center text-zinc-500">
                                <Activity className="w-8 h-8 mx-auto mb-3 opacity-20" />
                                No schedules pushed from OpenClaw yet.
                            </div>
                        ) : (
                            initialSchedules.map((s) => (
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
                        <span className="text-xs font-semibold px-2.5 py-1 bg-amber-500/20 text-amber-300 rounded-full border border-amber-500/30">
                            {initialPlaybooks.length} Templates
                        </span>
                    </div>

                    <div className="divide-y divide-zinc-800/60 overflow-y-auto max-h-[600px]">
                        {initialPlaybooks.length === 0 ? (
                            <div className="p-8 text-center text-zinc-500">
                                <FileJson className="w-8 h-8 mx-auto mb-3 opacity-20" />
                                No global playbooks defined yet.
                            </div>
                        ) : (
                            initialPlaybooks.map((pb) => (
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
        </div>
    );
}
