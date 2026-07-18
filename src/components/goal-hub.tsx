"use client";

import { useState } from "react";
import { IconTarget, IconSparkles, IconArrowRight, IconLoader2, IconCircleCheck, IconListCheck, IconRobot, IconUser, IconBrain } from "@tabler/icons-react";
import { cn } from "@/lib/utils";

type TaskSuggestion = {
    title: string;
    description: string;
    agentRole: string;
};

type MissionSuggestion = {
    projectName: string;
    projectDescription: string;
    tasks: TaskSuggestion[];
};

export function GoalHub() {
    const [goal, setGoal] = useState("");
    const [isThinking, setIsThinking] = useState(false);
    const [suggestion, setSuggestion] = useState<MissionSuggestion | null>(null);
    const [isExecuting, setIsExecuting] = useState(false);
    const [isDone, setIsDone] = useState(false);

    const handleBrainstorm = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!goal.trim() || isThinking) return;

        setIsThinking(true);
        setSuggestion(null);

        try {
            const res = await fetch("/api/chat/orchestrate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ goal }),
            });

            if (!res.ok) throw new Error("Failed to orchestrate mission");

            const data = await res.json();
            setSuggestion(data.suggestion);
        } catch (error) {
            console.error("Orchestration error", error);
        } finally {
            setIsThinking(false);
        }
    };

    const handleExecute = async () => {
        if (!suggestion || isExecuting) return;
        setIsExecuting(true);

        try {
            const res = await fetch("/api/chat/orchestrate/execute", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(suggestion),
            });

            if (!res.ok) throw new Error("Execution failed");

            setIsDone(true);
            setTimeout(() => {
                setSuggestion(null);
                setIsDone(false);
                setGoal("");
            }, 3000);
        } catch (error) {
            console.error("Execution error", error);
        } finally {
            setIsExecuting(false);
        }
    };

    return (
        <div className="relative group">
            <div className="absolute -inset-1 bg-gradient-to-r from-indigo-500/20 via-emerald-500/20 to-purple-500/20 rounded-2xl blur-lg opacity-75 group-hover:opacity-100 transition duration-1000 group-hover:duration-200" />
            
            <div className="relative bg-zinc-950 border border-zinc-800 rounded-2xl overflow-hidden shadow-2xl">
                <div className="p-1 px-4 bg-zinc-900/50 border-b border-zinc-800 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <IconSparkles className="w-3 h-3 text-amber-500 animate-pulse" />
                        <span className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">Autonomous Mission Control</span>
                    </div>
                </div>

                <div className="p-8">
                    {!suggestion ? (
                        <div className="space-y-6">
                            <div className="space-y-2">
                                <h2 className="text-xl font-semibold text-white tracking-tight">What is the mission for today?</h2>
                                <p className="text-sm text-zinc-500">Describe your high-level goal. The Emperor Claw Orchestrator will break it down into projects, tasks, and assign them to the best-suited agents.</p>
                            </div>

                            <form onSubmit={handleBrainstorm} className="relative">
                                <input
                                    type="text"
                                    value={goal}
                                    onChange={(e) => setGoal(e.target.value)}
                                    placeholder="e.g. Audit our main landing page for SEO and launch a basic Twitter campaign"
                                    className="w-full bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-4 pr-32 text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 transition-all font-medium"
                                />
                                <div className="absolute right-2 top-2 bottom-2">
                                    <button
                                        type="submit"
                                        disabled={!goal.trim() || isThinking}
                                        className="h-full bg-indigo-600 hover:bg-indigo-500 text-white px-4 rounded-lg text-sm font-bold flex items-center gap-2 transition-all disabled:opacity-50"
                                    >
                                        {isThinking ? (
                                            <>
                                                <IconLoader2 className="w-4 h-4 animate-spin" />
                                                Thinking
                                            </>
                                        ) : (
                                            <>
                                                Break Down
                                                <IconArrowRight className="w-4 h-4" />
                                            </>
                                        )}
                                    </button>
                                </div>
                            </form>
                        </div>
                    ) : (
                        <div className="animate-in fade-in zoom-in-95 duration-500">
                            <div className="flex items-center justify-between mb-8">
                                <div className="flex items-center gap-4">
                                    <div className="w-12 h-12 rounded-2xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center">
                                        <IconBrain className="w-6 h-6 text-indigo-400" />
                                    </div>
                                    <div>
                                        <h3 className="text-lg font-bold text-white uppercase tracking-tight">{suggestion.projectName}</h3>
                                        <p className="text-sm text-zinc-500">{suggestion.projectDescription}</p>
                                    </div>
                                </div>
                                <button 
                                    onClick={() => setSuggestion(null)}
                                    className="text-xs font-bold text-zinc-500 hover:text-zinc-300 transition-colors uppercase tracking-widest"
                                >
                                    Cancel
                                </button>
                            </div>

                            <div className="bg-zinc-900/40 border border-zinc-800 rounded-xl overflow-hidden divide-y divide-zinc-800/50 mb-8">
                                {suggestion.tasks.map((task, idx) => (
                                    <div key={idx} className="p-4 flex items-start gap-4 group/item hover:bg-zinc-800/30 transition-colors">
                                        <div className="mt-0.5 w-5 h-5 rounded-full border border-zinc-700 flex items-center justify-center text-[10px] font-bold text-zinc-500 group-hover/item:border-indigo-500/50 group-hover/item:text-indigo-400 transition-colors">
                                            {idx + 1}
                                        </div>
                                        <div className="flex-1 space-y-1">
                                            <div className="flex items-center justify-between">
                                                <h4 className="text-sm font-semibold text-zinc-200">{task.title}</h4>
                                                <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-indigo-500/10 border border-indigo-500/20">
                                                    <IconRobot className="w-3 h-3 text-indigo-400" />
                                                    <span className="text-[10px] font-bold text-indigo-300 uppercase leading-none">{task.agentRole}</span>
                                                </div>
                                            </div>
                                            <p className="text-xs text-zinc-500 leading-relaxed">{task.description}</p>
                                        </div>
                                    </div>
                                ))}
                            </div>

                            <div className="flex items-center gap-4">
                                <button
                                    onClick={handleExecute}
                                    disabled={isExecuting || isDone}
                                    className="flex-1 bg-emerald-500 hover:bg-emerald-400 text-emerald-950 h-12 rounded-xl text-sm font-bold flex items-center justify-center gap-2 transition-all disabled:opacity-50 shadow-lg shadow-emerald-500/20"
                                >
                                    {isExecuting ? (
                                        <>
                                            <IconLoader2 className="w-5 h-5 animate-spin" />
                                            Provisioning Infrastructure...
                                        </>
                                    ) : isDone ? (
                                        <>
                                            <IconCircleCheck className="w-5 h-5" />
                                            Mission Initiated
                                        </>
                                    ) : (
                                        <>
                                            <IconSparkles className="w-5 h-5" />
                                            Execute Mission Plan
                                        </>
                                    )}
                                </button>
                            </div>
                        </div>
                    )}
                </div>

                <div className="px-6 py-3 bg-zinc-900/20 border-t border-zinc-800 flex items-center justify-between">
                    <div className="flex items-center gap-4">
                        <div className="flex items-center gap-1.5">
                            <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]" />
                            <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">Orchestrator Online</span>
                        </div>
                    </div>
                    <div className="text-[10px] text-zinc-600 font-medium italic">
                        Powered by OpenClaw Autonomous Logic
                    </div>
                </div>
            </div>
        </div>
    );
}
