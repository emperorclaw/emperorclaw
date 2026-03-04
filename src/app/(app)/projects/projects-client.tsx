"use client";

import { useState, useEffect } from "react";
import { Search, Filter, MoreHorizontal, Clock, AlertCircle, CheckCircle2, ChevronRight, Send } from "lucide-react";

export default function ProjectsClient({ initialTasks, projects, agents, customers, artifacts, taskEvents = [] }: any) {
    const [selectedTask, setSelectedTask] = useState<any | null>(null);
    const [projectFilter, setProjectFilter] = useState("All Projects");
    const [agentFilter, setAgentFilter] = useState("All Agents");
    const [comment, setComment] = useState("");
    const [events, setEvents] = useState<any[]>(taskEvents);

    // Data auto-refresh is now handled globally
    // We update local events state after sending a comment for immediate feedback
    useEffect(() => {
        setEvents(taskEvents);
    }, [taskEvents]);

    const handleSendComment = async () => {
        if (!comment.trim() || !selectedTask) return;

        try {
            // Send note to task timeline
            const res = await fetch(`/api/tasks/${selectedTask.id}/notes`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ comment })
            });

            if (res.ok) {
                const data = await res.json();
                if (data.event) {
                    setEvents([...events, data.event]);
                }
            }

            // Also broadcast to Agent Team Chat
            await fetch('/api/mcp/messages/send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: 'human_manager',
                    text: `Task Directive for TASK-${selectedTask.id}:\n${comment}`,
                })
            });
            setComment("");
        } catch (e) {
            console.error("Failed to send task context", e);
        }
    };

    const filteredTasks = initialTasks.filter((t: any) => {
        if (projectFilter !== "All Projects" && t.projectId !== projectFilter) return false;
        if (agentFilter !== "All Agents" && t.assignedAgentId !== agentFilter) return false;
        return true;
    });

    const tasksByState = {
        queued: filteredTasks.filter((t: any) => t.state === "queued"),
        running: filteredTasks.filter((t: any) => t.state === "in_progress"),
        review: filteredTasks.filter((t: any) => t.state === "review"),
        failed: filteredTasks.filter((t: any) => t.state === "failed"),
        done: filteredTasks.filter((t: any) => t.state === "done"),
    };

    const getProjectName = (id: string) => projects.find((p: any) => p.id === id)?.goal || "Unknown Project";
    const getCustomerName = (projectId: string) => {
        const project = projects.find((p: any) => p.id === projectId);
        if (!project) return "Unknown Customer";
        return customers.find((c: any) => c.id === project.customerId)?.name || "Unknown Customer";
    };
    const getAgentName = (id: string) => agents.find((a: any) => a.id === id)?.name || "Unassigned";

    const artifactsForTask = (taskId: string) => (artifacts || []).filter((a: any) => a.taskId === taskId);

    const getTaskEvents = (taskId: string) => events.filter((e: any) => e.taskId === taskId).sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    return (
        <div className="h-full flex flex-col space-y-6 animate-in fade-in duration-500 relative">
            <div className="flex items-center justify-between">
                <div className="flex flex-col space-y-1">
                    <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">Projects Board</h1>
                    <p className="text-sm text-zinc-500 font-medium">Task orchestration and human oversight.</p>
                </div>

                <div className="flex items-center space-x-3">
                    <div className="relative">
                        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
                        <input
                            type="text"
                            placeholder="Search tasks..."
                            className="pl-9 pr-4 py-2 bg-zinc-900/50 border border-zinc-800 rounded-lg text-sm text-zinc-200 focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 w-64 transition-all"
                        />
                    </div>
                    <select
                        className="bg-zinc-900 border border-zinc-800 text-zinc-300 text-sm rounded-lg focus:ring-indigo-500 focus:border-indigo-500 block w-full p-2 h-10 outline-none"
                        value={projectFilter}
                        onChange={(e) => setProjectFilter(e.target.value)}
                    >
                        <option value="All Projects">All Projects</option>
                        {projects.map((p: any) => <option key={p.id} value={p.id}>{p.goal}</option>)}
                    </select>
                    <select
                        className="bg-zinc-900 border border-zinc-800 text-zinc-300 text-sm rounded-lg focus:ring-indigo-500 focus:border-indigo-500 block w-full p-2 h-10 outline-none"
                        value={agentFilter}
                        onChange={(e) => setAgentFilter(e.target.value)}
                    >
                        <option value="All Agents">All Agents</option>
                        {agents.map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>
                    <button className="p-2 h-10 bg-zinc-900/50 border border-zinc-800 rounded-lg hover:bg-zinc-800 transition-colors text-zinc-400 hover:text-zinc-200">
                        <Filter className="w-4 h-4" />
                    </button>
                </div>
            </div>

            <div className="flex-1 overflow-x-auto pb-4 mt-4">
                <div className="flex space-x-6 min-w-max h-full">
                    <BoardColumn title="Queued" count={tasksByState.queued.length} color="text-zinc-400">
                        {tasksByState.queued.map((t: any) => (
                            <TaskCard key={t.id} id={t.id} title={t.taskType} project={getProjectName(t.projectId)} customer={getCustomerName(t.projectId)} priority="high" onClick={() => setSelectedTask(t)} />
                        ))}
                    </BoardColumn>

                    <BoardColumn title="Running" count={tasksByState.running.length} color="text-indigo-400">
                        {tasksByState.running.map((t: any) => (
                            <TaskCard key={t.id} id={t.id} title={t.taskType} project={getProjectName(t.projectId)} customer={getCustomerName(t.projectId)} priority="medium" active onClick={() => setSelectedTask(t)} />
                        ))}
                    </BoardColumn>

                    <BoardColumn title="Needs Review" count={tasksByState.review.length} color="text-amber-400">
                        {tasksByState.review.map((t: any) => (
                            <TaskCard key={t.id} id={t.id} title={t.taskType} project={getProjectName(t.projectId)} customer={getCustomerName(t.projectId)} priority="high" review onClick={() => setSelectedTask(t)} />
                        ))}
                    </BoardColumn>

                    <BoardColumn title="Failed" count={tasksByState.failed.length} color="text-red-400">
                        {tasksByState.failed.map((t: any) => (
                            <TaskCard key={t.id} id={t.id} title={t.taskType} project={getProjectName(t.projectId)} customer={getCustomerName(t.projectId)} priority="high" review onClick={() => setSelectedTask(t)} />
                        ))}
                    </BoardColumn>

                    <BoardColumn title="Done" count={tasksByState.done.length} color="text-emerald-400">
                        {tasksByState.done.map((t: any) => (
                            <TaskCard key={t.id} id={t.id} title={t.taskType} project={getProjectName(t.projectId)} customer={getCustomerName(t.projectId)} priority="low" done onClick={() => setSelectedTask(t)} />
                        ))}
                    </BoardColumn>
                </div>
            </div>

            {/* Slide-out Task Drawer */}
            {selectedTask && (
                <div className="absolute top-0 right-0 w-[40%] h-full bg-zinc-900/95 border-l border-zinc-800 shadow-2xl backdrop-blur-3xl animate-in slide-in-from-right-8 duration-300 p-6 flex flex-col z-50 rounded-xl">
                    <div className="flex items-center justify-between mb-8">
                        <div className="text-xs font-mono text-zinc-500 bg-zinc-950 px-2 py-1 rounded border border-zinc-800">TASK-{selectedTask.id.substring(0, 8).toUpperCase()}</div>
                        <button onClick={() => setSelectedTask(null)} className="p-1 hover:bg-zinc-800 rounded text-zinc-500 transition-colors">
                            <ChevronRight className="w-5 h-5" />
                        </button>
                    </div>

                    <div className="flex-1 space-y-6 overflow-y-auto pr-2">
                        <div>
                            <h2 className="text-xl font-medium text-zinc-100 leading-tight">{selectedTask.taskType}</h2>
                            <p className="text-sm text-zinc-500 mt-2">Project: {getProjectName(selectedTask.projectId)}</p>
                            <p className="text-sm text-zinc-500">Customer: {getCustomerName(selectedTask.projectId)}</p>
                        </div>

                        <div className="flex items-center space-x-2 text-sm">
                            <span className="px-2.5 py-1 rounded bg-amber-500/20 text-amber-500 font-medium capitalize">{selectedTask.state.replace("_", " ")}</span>
                            <span className="px-2.5 py-1 rounded bg-zinc-800 text-zinc-400">Assigned: {getAgentName(selectedTask.assignedAgentId)}</span>
                        </div>

                        {selectedTask.inputJson && Object.keys(selectedTask.inputJson).length > 0 && (
                            <div className="space-y-3">
                                <h3 className="text-sm font-medium text-zinc-300">Task Instructions</h3>
                                <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-4 font-mono text-xs text-zinc-300 whitespace-pre-wrap leading-relaxed shadow-inner">
                                    {selectedTask.inputJson.description || selectedTask.inputJson.prompt || JSON.stringify(selectedTask.inputJson, null, 2)}
                                </div>
                            </div>
                        )}

                        <div className="space-y-3">
                            <h3 className="text-sm font-medium text-zinc-300">Artifacts & Reports</h3>
                            <div className="space-y-3">
                                {artifactsForTask(selectedTask.id).length === 0 && (
                                    <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-4 font-mono text-xs text-zinc-400 whitespace-pre-wrap">
                                        No artifacts submitted yet.
                                    </div>
                                )}
                                {artifactsForTask(selectedTask.id).map((a: any) => (
                                    <div key={a.id} className="bg-zinc-950 border border-zinc-800 rounded-lg p-4">
                                        <div className="flex items-center justify-between text-xs text-zinc-500 mb-2">
                                            <span className="font-mono">{a.kind}</span>
                                            <span>{a.contentType}</span>
                                        </div>
                                        {a.contentText && (
                                            <div className="font-mono text-xs text-zinc-300 whitespace-pre-wrap">
                                                {a.contentText}
                                            </div>
                                        )}
                                        {!a.contentText && a.storageUrl && (
                                            <div className="text-xs text-indigo-400 truncate">
                                                {a.storageUrl}
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </div>
                        </div>

                        <div className="space-y-3">
                            <h3 className="text-sm font-medium text-zinc-300">Timeline</h3>
                            <div className="space-y-4 pl-2 border-l-2 border-zinc-800">
                                {getTaskEvents(selectedTask.id).length === 0 ? (
                                    <>
                                        <TimelineEvent time={new Date(selectedTask.createdAt).toLocaleTimeString()} desc="Task created and queued." />
                                        {selectedTask.state !== 'queued' && <TimelineEvent time={new Date(selectedTask.updatedAt).toLocaleTimeString()} desc={`Status changed to ${selectedTask.state}`} />}
                                    </>
                                ) : (
                                    getTaskEvents(selectedTask.id).map((event: any) => {
                                        let desc = `Event: ${event.eventType}`;
                                        if (event.eventType === 'task_note' && event.payloadJson?.note) {
                                            desc = `Note: ${event.payloadJson.note}`;
                                        } else if (event.eventType === 'task_claimed') {
                                            desc = `Task claimed by ${getAgentName(event.actorId) || 'Agent'}`;
                                        } else if (event.eventType.startsWith('task_')) {
                                            desc = `Status changed to ${event.eventType.replace('task_', '')}`;
                                        }
                                        return (
                                            <TimelineEvent
                                                key={event.id}
                                                time={new Date(event.createdAt).toLocaleTimeString()}
                                                desc={desc}
                                                isNote={event.eventType === 'task_note'}
                                            />
                                        );
                                    })
                                )}
                            </div>
                        </div>
                    </div>

                    <div className="pt-6 border-t border-zinc-800 flex flex-col space-y-3 mt-auto">
                        <div className="text-xs text-zinc-500 font-medium">Add Task Note / Send to Agent:</div>
                        <div className="flex bg-zinc-950 border border-zinc-800 rounded-lg overflow-hidden focus-within:ring-1 focus-within:ring-indigo-500">
                            <textarea
                                value={comment}
                                onChange={(e) => setComment(e.target.value)}
                                placeholder="Agent instructions or private notes..."
                                className="flex-1 bg-transparent p-3 text-sm text-zinc-200 resize-none outline-none h-20"
                            />
                            <div className="p-2 border-l border-zinc-800 flex flex-col justify-end bg-zinc-900/50">
                                <button
                                    onClick={handleSendComment}
                                    disabled={!comment.trim()}
                                    className="p-2 rounded-md bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                                >
                                    <Send className="w-4 h-4" />
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

function BoardColumn({ title, count, color, children }: { title: string, count: number, color: string, children: React.ReactNode }) {
    return (
        <div className="w-80 flex flex-col h-full bg-zinc-900/30 rounded-xl border border-zinc-800/50 p-3">
            <div className="flex items-center justify-between px-1 mb-4">
                <div className="flex items-center space-x-2">
                    <div className={`w-2 h-2 rounded-full ${color}`} />
                    <h3 className="font-medium text-zinc-300 text-sm">{title}</h3>
                </div>
                <span className="text-xs font-mono text-zinc-500 bg-zinc-800/50 px-2 py-0.5 rounded">{count}</span>
            </div>
            <div className="flex-1 overflow-y-auto space-y-3 pr-1 pb-2">
                {children}
            </div>
        </div>
    );
}

function TaskCard({ id, title, project, priority, active, review, done, onClick, customer }: any) {
    const borderClass = active ? "border-indigo-500/50 shadow-[0_0_15px_rgba(99,102,241,0.1)]"
        : review ? "border-amber-500/50 shadow-[0_0_15px_rgba(245,158,11,0.1)]"
            : "border-zinc-800 hover:border-zinc-700";

    return (
        <div onClick={onClick} className={`bg-zinc-950 p-4 rounded-lg cursor-pointer transition-all duration-200 group border ${borderClass}`}>
            <div className="flex justify-between items-start mb-2">
                <div className="flex items-center flex-wrap gap-2">
                    <span className="text-[10px] font-mono text-zinc-500" title={`Task ID: ${id}`}>
                        TASK-{id.substring(0, 8).toUpperCase()}
                    </span>
                    {customer && (
                        <span className="text-[10px] font-medium text-indigo-400 bg-indigo-500/10 px-1.5 rounded truncate max-w-[100px]" title={customer}>
                            {customer}
                        </span>
                    )}
                </div>
                <button className="text-zinc-600 hover:text-zinc-300 transition-colors opacity-0 group-hover:opacity-100 pt-0.5">
                    <MoreHorizontal className="w-4 h-4" />
                </button>
            </div>
            <h4 className="text-sm font-medium text-zinc-200 mb-3 leading-snug">{title}</h4>
            <div className="flex items-center justify-between mt-auto">
                <span className="text-xs text-zinc-500 truncate max-w-[140px]">{project}</span>
                <div className="flex items-center">
                    {active && <div className="w-2 h-2 bg-indigo-500 rounded-full animate-pulse" />}
                    {done && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />}
                    {review && <AlertCircle className="w-3.5 h-3.5 text-amber-500" />}
                </div>
            </div>
        </div>
    );
}

function TimelineEvent({ time, desc, isNote }: { time: string, desc: string, isNote?: boolean }) {
    return (
        <div className={`relative pl-4 ${isNote ? 'mt-6 mb-2' : ''}`}>
            <div className={`absolute -left-[5px] top-1.5 w-2 h-2 rounded-full ring-4 ring-zinc-900 ${isNote ? 'bg-indigo-500' : 'bg-zinc-700'}`} />
            <div className={`text-xs font-mono mb-0.5 ${isNote ? 'text-indigo-400' : 'text-zinc-500'}`}>{time}</div>
            <div className={`text-sm ${isNote ? 'text-zinc-200 bg-zinc-800/50 p-3 rounded-lg border border-zinc-700/50 shadow-inner' : 'text-zinc-300'}`}>{desc}</div>
        </div>
    );
}
