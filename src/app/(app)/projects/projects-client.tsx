"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */

import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Brain, CheckCircle2, ChevronRight, Filter, History, Inbox, Plus, Repeat, Search, Send } from "lucide-react";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import { getArtifactClassLabel, getArtifactImportanceLabel } from "@/lib/artifact-taxonomy";
import { cn } from "@/lib/utils";

type Props = {
    initialTasks: any[];
    projects: any[];
    agents: any[];
    customers: any[];
    recurringDefinitions?: any[];
    artifacts?: any[];
    taskEvents?: any[];
    initialMessages?: any[];
    initialProjectMemory?: any[];
    initialSchedules?: any[];
};

const isRecurring = (task: any) => task?.taskKind === "recurring" || task?.taskKind === "recurrent";
const isBlocked = (task: any, allTasks: any[]) => (Array.isArray(task?.blockedByTaskIds) ? task.blockedByTaskIds : []).some((id: string) => allTasks.some((candidate) => candidate.id === id && candidate.state !== "done"));
const reviewBucket = (task: any, blocked: boolean) => (blocked ? "blocked" : task?.humanApprovalRequired ? "approval_needed" : task?.proofRequired ? "waiting_review" : "ready_to_close");
const taskInput = (task: any) => task?.inputJson && typeof task.inputJson === "object" ? task.inputJson : {};
const getTaskTitle = (task: any) => {
    const input = taskInput(task);
    return typeof input.title === "string" && input.title.trim() ? input.title.trim() : task?.taskType || "Untitled task";
};
const getTaskDescription = (task: any) => {
    const input = taskInput(task);
    return typeof input.description === "string" && input.description.trim()
        ? input.description.trim()
        : typeof input.prompt === "string" && input.prompt.trim()
            ? input.prompt.trim()
            : null;
};

export default function ProjectsClient({ initialTasks, projects, agents, customers, recurringDefinitions = [], artifacts = [], taskEvents = [], initialProjectMemory = [] }: Props) {
    const [selectedTask, setSelectedTask] = useState<any | null>(null);
    const [projectFilter, setProjectFilter] = useState("All Projects");
    const [agentFilter, setAgentFilter] = useState("All Agents");
    const [customerFilter, setCustomerFilter] = useState("All Customers");
    const [searchQuery, setSearchQuery] = useState("");
    const [comment, setComment] = useState("");
    const [events, setEvents] = useState<any[]>(taskEvents);
    const [projectMemoryItems, setProjectMemoryItems] = useState<any[]>(initialProjectMemory);
    const [isContextOpen, setIsContextOpen] = useState(false);
    const [newContext, setNewContext] = useState("");
    const [isSubmittingContext, setIsSubmittingContext] = useState(false);

    // Initial load from localStorage
    useEffect(() => {
        const savedProject = localStorage.getItem("projects-board-project-filter");
        const savedAgent = localStorage.getItem("projects-board-agent-filter");
        const savedCustomer = localStorage.getItem("projects-board-customer-filter");
        const savedSearch = localStorage.getItem("projects-board-search-query");

        if (savedProject) setProjectFilter(savedProject);
        if (savedAgent) setAgentFilter(savedAgent);
        if (savedCustomer) setCustomerFilter(savedCustomer);
        if (savedSearch) setSearchQuery(savedSearch);
    }, []);

    // Save to localStorage when filters change
    useEffect(() => {
        localStorage.setItem("projects-board-project-filter", projectFilter);
        localStorage.setItem("projects-board-agent-filter", agentFilter);
        localStorage.setItem("projects-board-customer-filter", customerFilter);
        localStorage.setItem("projects-board-search-query", searchQuery);
    }, [projectFilter, agentFilter, customerFilter, searchQuery]);

    useEffect(() => setEvents(taskEvents), [taskEvents]);

    const filteredTasks = useMemo(() => {
        const query = searchQuery.trim().toLowerCase();
        return initialTasks.filter((task) => {
            if (projectFilter !== "All Projects" && task.projectId !== projectFilter) return false;
            if (agentFilter !== "All Agents" && task.assignedAgentId !== agentFilter) return false;
            
            if (customerFilter !== "All Customers") {
                const project = projects.find((p) => p.id === task.projectId);
                if (!project || project.customerId !== customerFilter) return false;
            }

            if (!query) return true;

            const project = projects.find((item) => item.id === task.projectId);
            const customer = project ? customers.find((item) => item.id === project.customerId) : null;
            const agent = task.assignedAgentId ? agents.find((item) => item.id === task.assignedAgentId) : null;
            const input = taskInput(task);
            return [getTaskTitle(task), input.description, input.goal, task.taskType, task.state, project?.goal, customer?.name, agent?.name, task.templateVersion, task.contractVersion].filter(Boolean).join(" ").toLowerCase().includes(query);
        });
    }, [agentFilter, customers, initialTasks, projectFilter, projects, searchQuery, agents, customerFilter]);

    const recurrentTasks = filteredTasks.filter(isRecurring);
    const recurrentDefinitions = recurringDefinitions.filter((definition) => {
        if (projectFilter !== "All Projects" && definition.projectId !== projectFilter) return false;
        if (customerFilter !== "All Customers") {
            const project = projects.find((p) => p.id === definition.projectId);
            if (!project || project.customerId !== customerFilter) return false;
        }
        return true;
    });
    const workflowTasks = filteredTasks.filter((task) => !isRecurring(task) && task.state !== "failed" && task.state !== "dead_letter");
    const exceptionTasks = filteredTasks.filter((task) => task.state === "failed" || task.state === "dead_letter");
    const byState = {
        inbox: workflowTasks.filter((task) => task.state === "queued" || task.state === "inbox"),
        inProgress: workflowTasks.filter((task) => task.state === "in_progress"),
        review: workflowTasks.filter((task) => task.state === "review"),
        done: workflowTasks.filter((task) => task.state === "done"),
    };
    const reviewCounts = {
        approval_needed: byState.review.filter((task) => reviewBucket(task, isBlocked(task, filteredTasks)) === "approval_needed").length,
        waiting_review: byState.review.filter((task) => reviewBucket(task, isBlocked(task, filteredTasks)) === "waiting_review").length,
        blocked: byState.review.filter((task) => reviewBucket(task, isBlocked(task, filteredTasks)) === "blocked").length,
        ready_to_close: byState.review.filter((task) => reviewBucket(task, isBlocked(task, filteredTasks)) === "ready_to_close").length,
    };

    const getProjectName = (projectId: string) => projects.find((project) => project.id === projectId)?.goal || "Unknown Project";
    const getCustomerName = (projectId: string) => {
        const project = projects.find((item) => item.id === projectId);
        return project ? customers.find((item) => item.id === project.customerId)?.name || "Unknown Customer" : "Unknown Customer";
    };
    const getAgentName = (agentId?: string | null) => agents.find((agent) => agent.id === agentId)?.name || "Unassigned";
    const artifactsForTask = (taskId: string) => artifacts.filter((artifact) => artifact.taskId === taskId);
    const getTaskEvents = (taskId: string) => events.filter((event) => event.taskId === taskId).sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    const handleSendComment = async () => {
        if (!selectedTask || !comment.trim()) return;
        try {
            const noteRes = await fetch(`/api/tasks/${selectedTask.id}/notes`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ comment }),
            });
            if (noteRes.ok) {
                const data = await noteRes.json();
                if (data.event) setEvents((prev) => [...prev, data.event]);
            }
            await fetch("/api/chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    text: `Task Directive for TASK-${selectedTask.id}:\n${comment}`,
                    targetAgentId: selectedTask.assignedAgentId || undefined,
                }),
            });
            setComment("");
        } catch (error) {
            console.error("Failed to send task context", error);
        }
    };

    const handleAddProjectContext = async () => {
        if (!newContext.trim() || projectFilter === "All Projects") return;
        setIsSubmittingContext(true);
        try {
            const res = await fetch(`/api/projects/${projectFilter}/memory`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ content: newContext }),
            });
            if (res.ok) {
                const { data } = await res.json();
                setProjectMemoryItems((prev) => [data, ...prev]);
                setNewContext("");
            }
        } finally {
            setIsSubmittingContext(false);
        }
    };

    const blockedCount = filteredTasks.filter((task) => isBlocked(task, filteredTasks)).length;
    const currentProjectMemory = projectMemoryItems.filter((item) => projectFilter === "All Projects" ? true : item.projectId === projectFilter).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return (
        <div className="relative flex h-full flex-col space-y-6 animate-in fade-in duration-500">
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="space-y-2">
                    <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">Projects Board</h1>
                    <p className="text-sm font-medium text-zinc-500">Inbox, execution, review, done, and a recurrent lane when the data supports it.</p>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
                        <input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Search tasks..." className="w-72 rounded-lg border border-zinc-800 bg-zinc-900/50 py-2 pl-9 pr-4 text-sm text-zinc-200 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/60" />
                    </div>
                    <select value={customerFilter} onChange={(event) => setCustomerFilter(event.target.value)} className="h-10 rounded-lg border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-300 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/60">
                        <option value="All Customers">All Customers</option>
                        {customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}
                    </select>
                    <select value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)} className="h-10 rounded-lg border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-300 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/60">
                        <option value="All Projects">All Projects</option>
                        {projects
                            .filter(p => customerFilter === "All Customers" ? true : p.customerId === customerFilter)
                            .map((project) => <option key={project.id} value={project.id}>{project.goal}</option>)
                        }
                    </select>
                    <select value={agentFilter} onChange={(event) => setAgentFilter(event.target.value)} className="h-10 rounded-lg border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-300 outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/60">
                        <option value="All Agents">All Agents</option>
                        {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
                    </select>
                    <button className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-2.5 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200"><Filter className="h-4 w-4" /></button>
                    {projectFilter !== "All Projects" && <button onClick={() => setIsContextOpen(true)} className="flex h-10 items-center gap-2 rounded-lg border border-indigo-500/50 bg-indigo-600 px-4 text-sm font-semibold text-white shadow-lg shadow-indigo-500/20 transition-colors hover:bg-indigo-500"><Brain className="h-4 w-4" />Project Brain</button>}
                </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                <MetricCard label="Inbox" value={byState.inbox.length} hint="Queued work" />
                <MetricCard label="In Progress" value={byState.inProgress.length} hint="Active execution" accent="indigo" />
                <MetricCard label="Review" value={byState.review.length} hint="Human / proof review" accent="amber" />
                <MetricCard label="Done" value={byState.done.length} hint="Closed work" accent="emerald" />
                <MetricCard label="Recurrent" value={recurrentDefinitions.length} hint="Recurring task definitions" accent="slate" />
            </div>

            {(blockedCount > 0 || exceptionTasks.length > 0) && (
                <div className="flex flex-wrap items-center gap-3 rounded-xl border border-zinc-800/80 bg-zinc-900/40 px-4 py-3 text-sm">
                    {blockedCount > 0 && <span className="rounded-lg border border-rose-500/20 bg-rose-500/10 px-3 py-1.5 text-rose-300"><AlertTriangle className="mr-1 inline h-4 w-4" />{blockedCount} blocked tasks</span>}
                    {exceptionTasks.length > 0 && <span className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-zinc-300">{exceptionTasks.length} failed/dead-letter tasks</span>}
                    <span className="text-zinc-500">Recurring definitions stay in their own lane so spawned execution tasks do not distort workflow metrics.</span>
                </div>
            )}

            <div className="flex min-h-0 flex-1 overflow-hidden -mx-8 px-8">
                <div className="flex-1 overflow-x-auto pb-4">
                    <div className="flex h-full min-w-max gap-6">
                        <BoardColumn title="Inbox" count={byState.inbox.length} tone="zinc" icon={Inbox}>
                            {byState.inbox.map((task) => <TaskCard key={task.id} task={task} project={getProjectName(task.projectId)} customer={getCustomerName(task.projectId)} agent={getAgentName(task.assignedAgentId)} blocked={isBlocked(task, filteredTasks)} onClick={() => setSelectedTask(task)} />)}
                        </BoardColumn>
                        <BoardColumn title="In Progress" count={byState.inProgress.length} tone="indigo" icon={CirclePulseIcon}>
                            {byState.inProgress.map((task) => <TaskCard key={task.id} task={task} project={getProjectName(task.projectId)} customer={getCustomerName(task.projectId)} agent={getAgentName(task.assignedAgentId)} blocked={isBlocked(task, filteredTasks)} active onClick={() => setSelectedTask(task)} />)}
                        </BoardColumn>
                        <BoardColumn title="Review" count={byState.review.length} tone="amber" icon={CheckCircle2}>
                            <div className="mb-3 grid grid-cols-2 gap-2 text-[10px] font-semibold uppercase tracking-[0.16em]">
                                <BucketBadge label="Approval needed" count={reviewCounts.approval_needed} />
                                <BucketBadge label="Waiting review" count={reviewCounts.waiting_review} />
                                <BucketBadge label="Blocked" count={reviewCounts.blocked} tone="rose" />
                                <BucketBadge label="Ready to close" count={reviewCounts.ready_to_close} tone="emerald" />
                            </div>
                            {byState.review.slice().sort((a, b) => Number(isBlocked(a, filteredTasks)) - Number(isBlocked(b, filteredTasks))).map((task) => <TaskCard key={task.id} task={task} project={getProjectName(task.projectId)} customer={getCustomerName(task.projectId)} agent={getAgentName(task.assignedAgentId)} blocked={isBlocked(task, filteredTasks)} reviewBucket={reviewBucket(task, isBlocked(task, filteredTasks))} review onClick={() => setSelectedTask(task)} />)}
                        </BoardColumn>
                        <BoardColumn title="Done" count={byState.done.length} tone="emerald" icon={CheckCircle2}>
                            {byState.done.map((task) => <TaskCard key={task.id} task={task} project={getProjectName(task.projectId)} customer={getCustomerName(task.projectId)} agent={getAgentName(task.assignedAgentId)} done onClick={() => setSelectedTask(task)} />)}
                        </BoardColumn>
                        {(recurrentDefinitions.length > 0 || recurrentTasks.length > 0) && <BoardColumn title="Recurrent" count={recurrentDefinitions.length + recurrentTasks.length} tone="slate" icon={Repeat}>
                            {recurrentDefinitions.map((definition) => <RecurringCard key={definition.id} definition={definition} project={getProjectName(definition.projectId)} customer={getCustomerName(definition.projectId)} agent={getAgentName(definition.createdByAgentId)} />)}
                            {recurrentTasks.map((task) => <TaskCard key={task.id} task={task} project={getProjectName(task.projectId)} customer={getCustomerName(task.projectId)} agent={getAgentName(task.assignedAgentId)} recurrent blocked={isBlocked(task, filteredTasks)} onClick={() => setSelectedTask(task)} />)}
                        </BoardColumn>}
                    </div>
                </div>
            </div>

            {selectedTask && (
                <div className="absolute right-0 top-0 z-50 flex h-full w-[42%] flex-col rounded-xl border-l border-zinc-800 bg-zinc-900/95 p-6 shadow-2xl backdrop-blur-3xl animate-in slide-in-from-right-8 duration-300">
                    <div className="mb-8 flex items-center justify-between">
                        <div className="rounded border border-zinc-800 bg-zinc-950 px-2 py-1 font-mono text-xs text-zinc-500">TASK-{selectedTask.id.substring(0, 8).toUpperCase()}</div>
                        <button onClick={() => setSelectedTask(null)} className="rounded p-1 text-zinc-500 transition-colors hover:bg-zinc-800"><ChevronRight className="h-5 w-5" /></button>
                    </div>
                    <div className="min-h-0 flex-1 space-y-6 overflow-y-auto pr-2">
                        <div>
                            <h2 className="text-xl font-medium text-zinc-100">{getTaskTitle(selectedTask)}</h2>
                            <p className="mt-1 text-xs font-medium uppercase tracking-[0.16em] text-zinc-600">{selectedTask.taskType}</p>
                            <p className="mt-2 text-sm text-zinc-500">Project: {getProjectName(selectedTask.projectId)}</p>
                            <p className="text-sm text-zinc-500">Customer: {getCustomerName(selectedTask.projectId)}</p>
                        </div>
                        <div className="flex flex-wrap gap-2 text-sm">
                            <span className="rounded bg-zinc-800 px-2.5 py-1 font-medium capitalize text-zinc-300">{String(selectedTask.state).replace("_", " ")}</span>
                            <span className="rounded bg-zinc-800 px-2.5 py-1 text-zinc-400">Assigned: {getAgentName(selectedTask.assignedAgentId)}</span>
                            {isBlocked(selectedTask, filteredTasks) && <span className="rounded bg-rose-500/20 px-2.5 py-1 text-rose-400">Blocked</span>}
                            {isRecurring(selectedTask) && <span className="rounded bg-indigo-500/20 px-2.5 py-1 text-indigo-300">Recurrent</span>}
                        </div>
                        {selectedTask.inputJson && Object.keys(selectedTask.inputJson).length > 0 && <Section title="Task Instructions"><div className="whitespace-pre-wrap rounded-lg border border-zinc-800 bg-zinc-950 p-4 font-mono text-xs leading-relaxed text-zinc-300 shadow-inner">{getTaskDescription(selectedTask) || JSON.stringify(selectedTask.inputJson, null, 2)}</div></Section>}
                        <Section title="Storage & Reports">{artifactsForTask(selectedTask.id).length === 0 ? <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4 font-mono text-xs text-zinc-400">No files submitted yet.</div> : artifactsForTask(selectedTask.id).map((artifact) => <div key={artifact.id} className="rounded-lg border border-zinc-800 bg-zinc-950 p-4"><div className="mb-2 flex items-center justify-between gap-3 text-xs text-zinc-500"><div className="flex min-w-0 items-center gap-2"><span className="font-mono">{artifact.title || artifact.originalFilename || artifact.kind}</span><span className="rounded border border-zinc-800 bg-zinc-900 px-1.5 py-0.5 uppercase tracking-wider text-[10px]">{getArtifactClassLabel(artifact.artifactClass || artifact.kind)}</span>{artifact.isCanonical && <span className="rounded border border-emerald-500/20 bg-emerald-500/10 px-1.5 py-0.5 uppercase tracking-wider text-[10px] text-emerald-300">canonical</span>}</div><span>{artifact.contentType}</span></div><div className="mb-2 flex items-center gap-2 text-[10px] uppercase tracking-wider text-zinc-600"><span>{getArtifactImportanceLabel(artifact.importance || "operational")}</span>{artifact.originalFilename && <span className="truncate">{artifact.originalFilename}</span>}</div>{artifact.contentText ? <MarkdownRenderer content={artifact.contentText} className="text-xs" /> : <div className="text-xs text-zinc-500">Stored securely. Use Storage to preview or download.</div>}</div>)}</Section>
                        <Section title="Timeline">{getTaskEvents(selectedTask.id).length === 0 ? <><TimelineEvent time={new Date(selectedTask.createdAt).toLocaleTimeString()} desc="Task created and entered inbox." /><>{selectedTask.state !== "queued" && selectedTask.state !== "inbox" && <TimelineEvent time={new Date(selectedTask.updatedAt).toLocaleTimeString()} desc={`Status changed to ${selectedTask.state}`} />}</></> : getTaskEvents(selectedTask.id).map((event) => <TimelineEvent key={event.id} time={new Date(event.createdAt).toLocaleTimeString()} desc={event.eventType === "task_note" && event.payloadJson?.note ? `Note: ${event.payloadJson.note}` : event.eventType === "task_handoff" && event.payloadJson?.handoff ? `Handoff from ${event.payloadJson.handoff.fromRole} to ${event.payloadJson.handoff.toRole}` : event.eventType.startsWith("task_") ? `Status changed to ${event.eventType.replace("task_", "")}` : `Event: ${event.eventType}`} isNote={event.eventType === "task_note" || event.eventType === "task_handoff"} />)}</Section>
                    </div>
                    <div className="mt-auto border-t border-zinc-800 pt-6">
                        <div className="mb-2 text-xs font-medium text-zinc-500">Add Task Note / Send to Agent</div>
                        <div className="flex overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950 focus-within:ring-1 focus-within:ring-indigo-500">
                            <textarea value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Agent instructions or private notes..." className="h-20 flex-1 resize-none bg-transparent p-3 text-sm text-zinc-200 outline-none" />
                            <div className="flex flex-col justify-end border-l border-zinc-800 bg-zinc-900/50 p-2">
                                <button onClick={handleSendComment} disabled={!comment.trim()} className="rounded-md bg-indigo-600 p-2 text-white transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"><Send className="h-4 w-4" /></button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {isContextOpen && (
                <div className="absolute right-0 top-0 z-50 flex h-full w-[45%] flex-col rounded-l-2xl border-l border-zinc-800 bg-zinc-900/98 shadow-2xl backdrop-blur-3xl animate-in slide-in-from-right-10 duration-300">
                    <div className="flex items-center justify-between rounded-tl-2xl border-b border-zinc-800 bg-zinc-950/50 p-6">
                        <div className="flex items-center space-x-3">
                            <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-indigo-500/30 bg-indigo-600/20 text-indigo-500 shadow-inner"><Brain className="h-6 w-6" /></div>
                            <div><h2 className="text-lg font-semibold uppercase tracking-tight text-zinc-100">Project Brain</h2><p className="text-xs font-medium text-zinc-500">Persistent context and memory</p></div>
                        </div>
                        <button onClick={() => setIsContextOpen(false)} className="rounded-lg p-2 text-zinc-500 transition-colors hover:bg-zinc-800"><ChevronRight className="h-6 w-6" /></button>
                    </div>
                    <div className="custom-scrollbar flex-1 space-y-8 overflow-y-auto p-6">
                        <div className="space-y-3">
                            <label className="pl-1 text-[10px] font-bold uppercase tracking-widest text-zinc-500">Teach Project New Context</label>
                            <div className="relative">
                                <textarea value={newContext} onChange={(event) => setNewContext(event.target.value)} placeholder="Enter new goals, findings, or critical context for the agents..." className="h-32 w-full resize-none rounded-xl border border-zinc-800 bg-zinc-950 p-4 text-sm text-zinc-200 outline-none shadow-inner focus:ring-1 focus:ring-indigo-500" />
                                <button onClick={handleAddProjectContext} disabled={!newContext.trim() || isSubmittingContext} className="absolute bottom-3 right-3 flex items-center space-x-2 rounded-lg bg-indigo-600 px-4 py-2 text-xs font-bold text-white shadow-lg shadow-indigo-500/20 transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50">{isSubmittingContext ? <div className="h-3 w-3 animate-spin rounded-full border-2 border-white/30 border-t-white" /> : <Plus className="h-3 w-3" />}<span>Append Context</span></button>
                            </div>
                        </div>
                        <div className="space-y-4">
                            <h3 className="flex items-center space-x-2 pl-1 text-[10px] font-bold uppercase tracking-widest text-zinc-500"><History className="h-3 w-3" /><span>Memory Timeline</span></h3>
                            {currentProjectMemory.length === 0 ? <div className="flex flex-col items-center justify-center space-y-2 rounded-2xl border border-dashed border-zinc-800 p-8 text-center opacity-50"><Brain className="mb-2 h-8 w-8 text-zinc-700" /><p className="text-sm text-zinc-500">This project currently has no high-level memory entries.</p><p className="text-xs text-zinc-600">The Brain stores critical cross-task knowledge.</p></div> : <div className="space-y-4">{currentProjectMemory.map((memory) => <div key={memory.id} className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950/50 shadow-sm transition-colors hover:border-zinc-700"><div className="flex items-center justify-between border-b border-zinc-800/50 bg-zinc-900/20 p-4"><div className="flex items-center space-x-2"><div className="h-1.5 w-1.5 rounded-full bg-indigo-500 shadow-[0_0_8px_rgba(99,102,241,0.5)]" /><span className="font-mono text-[10px] text-zinc-500">{new Date(memory.createdAt).toLocaleString()}</span></div>{memory.createdByAgentId && <div className="rounded-full border border-indigo-500/20 bg-indigo-500/10 px-2 py-0.5 text-[9px] font-bold uppercase tracking-tighter text-indigo-400">By {getAgentName(memory.createdByAgentId)}</div>}</div><div className="p-5"><MarkdownRenderer content={memory.content} className="text-sm prose-invert" /></div>{Array.isArray(memory.tags) && memory.tags.length > 0 && <div className="flex flex-wrap gap-2 px-5 pb-4">{memory.tags.map((tag: string) => <span key={tag} className="rounded border border-zinc-800 bg-zinc-900 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-widest text-zinc-500">{tag}</span>)}</div>}</div>)}</div>}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

function MetricCard({ label, value, hint, accent = "slate" }: { label: string; value: number; hint: string; accent?: "slate" | "indigo" | "amber" | "emerald" }) {
    const tone = { slate: "border-zinc-800 bg-zinc-950/50", indigo: "border-indigo-500/20 bg-indigo-500/10", amber: "border-amber-500/20 bg-amber-500/10", emerald: "border-emerald-500/20 bg-emerald-500/10" }[accent];
    return <div className={cn("rounded-xl border p-4", tone)}><div className="text-[10px] font-bold uppercase tracking-[0.18em] text-zinc-500">{label}</div><div className="mt-2 text-2xl font-semibold text-zinc-100">{value}</div><div className="mt-1 text-xs text-zinc-500">{hint}</div></div>;
}

function BucketBadge({ label, count, tone = "zinc" }: { label: string; count: number; tone?: "zinc" | "rose" | "emerald" }) {
    const toneClass = { zinc: "border-zinc-800 bg-zinc-950 text-zinc-300", rose: "border-rose-500/20 bg-rose-500/10 text-rose-300", emerald: "border-emerald-500/20 bg-emerald-500/10 text-emerald-300" }[tone];
    return <div className={cn("rounded-lg border px-2 py-1.5", toneClass)}><div className="flex items-center justify-between gap-2"><span>{label}</span><span className="font-mono text-[10px]">{count}</span></div></div>;
}

function BoardColumn({ title, count, tone, icon: Icon, children }: { title: string; count: number; tone: "zinc" | "indigo" | "amber" | "emerald" | "slate"; icon: any; children: ReactNode }) {
    const toneClass = { zinc: "border-zinc-800/60 bg-zinc-900/30", indigo: "border-indigo-500/20 bg-indigo-500/5", amber: "border-amber-500/20 bg-amber-500/5", emerald: "border-emerald-500/20 bg-emerald-500/5", slate: "border-zinc-800/60 bg-zinc-900/30" }[tone];
    return <div className={cn("flex h-full w-80 flex-col rounded-xl border p-3", toneClass)}><div className="mb-4 flex items-center justify-between px-1"><div className="flex items-center space-x-2"><Icon className="h-4 w-4 text-zinc-500" /><h3 className="text-sm font-medium text-zinc-300">{title}</h3></div><span className="rounded bg-zinc-800/50 px-2 py-0.5 font-mono text-xs text-zinc-500">{count}</span></div><div className="custom-scrollbar flex-1 space-y-3 overflow-y-auto pr-1 pb-2">{children}</div></div>;
}

function TaskCard({ task, project, customer, agent, blocked, reviewBucket, recurrent, active, review, done, onClick }: { task: any; project: string; customer: string; agent: string; blocked?: boolean; reviewBucket?: string; recurrent?: boolean; active?: boolean; review?: boolean; done?: boolean; onClick: () => void; }) {
    const priority = task.priority >= 80 ? { label: "HIGH", cls: "bg-rose-500/10 text-rose-400 border-rose-500/20" } : task.priority >= 50 ? { label: "MED", cls: "bg-amber-500/10 text-amber-400 border-amber-500/20" } : { label: "LOW", cls: "bg-zinc-500/10 text-zinc-400 border-zinc-500/20" };
    const border = blocked ? "border-rose-500/50" : recurrent ? "border-indigo-500/40" : active ? "border-indigo-500/50" : review ? "border-amber-500/50" : done ? "border-emerald-500/40" : "border-zinc-800";
    return <button onClick={onClick} className={cn("w-full rounded-lg border bg-zinc-950 p-4 text-left transition-colors hover:bg-zinc-900/80", border)}><div className="mb-3 flex items-start justify-between gap-3"><div className="space-y-2"><div className="flex items-center gap-2"><div className="h-1.5 w-1.5 rounded-full bg-indigo-500/40" /><span className="font-mono text-[10px] text-zinc-500">TASK-{task.id.substring(0, 8).toUpperCase()}</span></div><h4 className="text-sm font-medium leading-snug text-zinc-200">{getTaskTitle(task)}</h4><div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-600">{task.taskType}</div></div><span className={cn("rounded border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider", priority.cls)}>{priority.label}</span></div><div className="mb-3 flex flex-wrap gap-2 text-[10px] font-medium"><span className="rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-zinc-400">{project}</span><span className="rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-zinc-500">{customer}</span><span className="rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-zinc-500">{agent}</span></div><div className="flex flex-wrap gap-2 text-[10px] font-semibold uppercase tracking-[0.16em]"><span className="rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-zinc-500">{String(task.state).replace("_", " ")}</span>{blocked && <span className="rounded border border-rose-500/20 bg-rose-500/10 px-2 py-1 text-rose-300">Blocked</span>}{reviewBucket && <span className="rounded border border-amber-500/20 bg-amber-500/10 px-2 py-1 text-amber-300">{reviewBucket.replace("_", " ")}</span>}{recurrent && <span className="rounded border border-indigo-500/20 bg-indigo-500/10 px-2 py-1 text-indigo-300">Recurring</span>}</div>{(task.processingStartedAt || task.templateVersion) && <div className="mt-3 flex items-center justify-between text-[10px] text-zinc-600"><span>{task.templateVersion ? `v${task.templateVersion}` : "Standard"}</span>{task.processingStartedAt && <span>Processing since {new Date(task.processingStartedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>}</div>}</button>;
}

function RecurringCard({ definition, project, customer, agent }: { definition: any; project: string; customer: string; agent: string }) {
    return <div className="w-full rounded-lg border border-indigo-500/30 bg-zinc-950 p-4 text-left"><div className="mb-3 flex items-start justify-between gap-3"><div className="space-y-2"><div className="flex items-center gap-2"><div className="h-1.5 w-1.5 rounded-full bg-indigo-500/40" /><span className="font-mono text-[10px] text-zinc-500">RECUR-{definition.id.substring(0, 8).toUpperCase()}</span></div><h4 className="text-sm font-medium leading-snug text-zinc-200">{definition.name}</h4></div><span className={cn("rounded border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider", definition.active ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-300" : "border-zinc-800 bg-zinc-900 text-zinc-500")}>{definition.active ? "ACTIVE" : "PAUSED"}</span></div><div className="mb-3 flex flex-wrap gap-2 text-[10px] font-medium"><span className="rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-zinc-400">{project}</span><span className="rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-zinc-500">{customer}</span><span className="rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-zinc-500">{agent}</span></div><div className="flex flex-wrap gap-2 text-[10px] font-semibold uppercase tracking-[0.16em]"><span className="rounded border border-indigo-500/20 bg-indigo-500/10 px-2 py-1 text-indigo-300">{definition.taskType}</span>{definition.cronExpression && <span className="rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-zinc-500">{definition.cronExpression}</span>}{definition.nextRunAt && <span className="rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-zinc-500">Next {new Date(definition.nextRunAt).toLocaleString()}</span>}</div></div>;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
    return <div className="space-y-3"><h3 className="text-sm font-medium text-zinc-300">{title}</h3>{children}</div>;
}

function TimelineEvent({ time, desc, isNote }: { time: string; desc: string; isNote?: boolean }) {
    return <div className="flex items-start space-x-3"><div className={cn("mt-1 h-2 w-2 rounded-full", isNote ? "bg-indigo-500" : "bg-zinc-600")} /><div className="flex-1"><div className="text-[10px] text-zinc-500">{time}</div><div className="text-sm text-zinc-300">{desc}</div></div></div>;
}

function CirclePulseIcon({ className }: { className?: string }) {
    return <div className={cn("h-4 w-4 rounded-full border border-indigo-400/70", className)} />;
}
