"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { DndContext, DragOverlay, MouseSensor, TouchSensor, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from "@dnd-kit/core";
import { IconAlertTriangle, IconLayoutColumns, IconList, IconPlus, IconSearch, IconX } from "@tabler/icons-react";
import { toast } from "sonner";
import { useFormatter, useTranslations } from "next-intl";
import { useAge } from "@/lib/i18n/format";
import { ageParts } from "@/lib/i18n/relative-time";
import { ScopeViewsSection } from "@/components/views/scope-views-section";
import { ResourceAccessButton } from "@/components/access/resource-access-dialog";
import { PageHeader } from "@/components/page-header";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { EmptyState } from "@/components/ui/empty-state";
import { DisabledReason } from "@/components/ui/disabled-reason";
import { migrateLegacyAgentFilter, normalizeAssigneeFilter } from "@/lib/project-board-filters";
import {
    blockedReason,
    cardContextLine,
    cardSignals,
    COLUMN_DROP_STATE,
    groupBoardTasks,
    isRecurringTask,
    laneIsBulkArchivable,
    priorityLevel,
    REVIEW_BUCKET_LABEL,
    reviewBucketFor,
    taskBody,
    taskTitle,
    type BoardColumnKey,
    type ReviewBucket,
} from "@/lib/project-board-model";
import { projectTitle } from "@/lib/project-title";
import { cn } from "@/lib/utils";
import { BoardLane, LaneList, LaneSwitcher, laneCount, type CardHandlers, type Lane, type RowSelection } from "./board/board-lanes";
import { BlockTaskDialog, ConfirmArchiveTaskDialog, ConfirmArchiveTasksDialog, ProjectFormDialog, TaskFormDialog } from "./board/board-dialogs";
import { useBoardLabels } from "./board/board-labels";
import { ProjectHeader } from "./board/project-header";
import { ProjectNotesPanel } from "./board/project-notes-panel";
import { TaskCard, type TaskView } from "./board/task-card";
import { TaskDrawer } from "./board/task-drawer";

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
    members?: any[];
    currentMemberId?: string | null;
    companyRole?: string;
    /** Company viewers: the projects they hold "Can edit" or Admin on (0.20 Access). */
    editableProjectIds?: string[];
    /** Agents holding visible tasks that this person may not use (0.20): name for owners/admins, else null. */
    limitedAgents?: { id: string; name: string | null; limited: true }[];
};

const ALL_PROJECTS = "All Projects";
const ALL_CUSTOMERS = "All Customers";

const emptyProjectForm = {
    goal: "",
    customerId: "",
    leadAgentId: "",
    status: "active",
    requireApprovalForDone: false,
    requireReviewBeforeDone: false,
    commentRequiredForReview: false,
    blockStatusChangesWithPendingApproval: false,
    onlyLeadCanChangeStatus: false,
    maxActiveAgents: 3,
};
const emptyTaskForm = {
    projectId: "",
    title: "",
    taskType: "manual_task",
    description: "",
    goal: "",
    priority: 0,
    assignee: "",
    state: "inbox",
    acceptanceCriteria: "",
    definitionOfDone: "",
    deliverables: "",
    proofRequired: false,
    humanApprovalRequired: false,
};

function assigneeValue(task: any) {
    if (task?.assignedMemberId) return `human:${task.assignedMemberId}`;
    if (task?.assignedAgentId) return `agent:${task.assignedAgentId}`;
    return "";
}

function parseAssigneeValue(value: string) {
    if (!value) return null;
    const [type, id] = value.split(":", 2);
    if ((type !== "human" && type !== "agent") || !id) return null;
    return { type, id };
}

/** Patch-response shape: the API returns `{ task }`. */
async function patchTaskRequest(taskId: string, body: Record<string, unknown>) {
    const res = await fetch(`/api/tasks/${taskId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : "");
    return data.task;
}

/** The bulk archive routes take at most this many ids per request. */
const BULK_ARCHIVE_CHUNK = 200;
const UNDO_TOAST_MS = 8000;

/** POST `{ taskIds }` to a bulk route in chunks; returns the ids the server changed. */
async function bulkTaskRequest(url: string, taskIds: string[], resultKey: "archived" | "restored") {
    const changed: string[] = [];
    let skipped = 0;
    for (let start = 0; start < taskIds.length; start += BULK_ARCHIVE_CHUNK) {
        const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ taskIds: taskIds.slice(start, start + BULK_ARCHIVE_CHUNK) }) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : "");
        if (Array.isArray(data[resultKey])) changed.push(...data[resultKey]);
        if (Array.isArray(data.skipped)) skipped += data.skipped.length;
    }
    return { changed, skipped };
}

/** Wall clock that ticks each minute. 0 until mounted, so server and client render the same HTML. */
function useMinuteClock() {
    const [now, setNow] = useState(0);
    useEffect(() => {
        setNow(Date.now());
        const timer = window.setInterval(() => setNow(Date.now()), 60_000);
        return () => window.clearInterval(timer);
    }, []);
    return now;
}

function readStorage(key: string): string | null {
    try { return window.localStorage.getItem(key); } catch { return null; }
}
function writeStorage(key: string, value: string) {
    try { window.localStorage.setItem(key, value); } catch { /* private mode: preferences just do not persist */ }
}

export default function ProjectsClient({ initialTasks, projects, agents, customers, recurringDefinitions = [], artifacts = [], taskEvents = [], initialProjectMemory = [], members = [], currentMemberId = null, companyRole = "member", editableProjectIds = [], limitedAgents = [] }: Props) {
    const t = useTranslations("projects.board");
    const tTasks = useTranslations("tasks");
    const labels = useBoardLabels();
    const format = useFormatter();
    const age = useAge();
    const router = useRouter();
    const searchParams = useSearchParams();
    const nowMs = useMinuteClock();
    const taskCount = (count: number) => tTasks("count", { count });
    /** An error message, or the fallback when the server gave none. */
    const messageOf = (error: unknown, fallback: string) => error instanceof Error && error.message ? error.message : fallback;

    const [tasks, setTasks] = useState<any[]>(initialTasks);
    const [projectItems, setProjectItems] = useState<any[]>(projects);
    const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
    const [projectFilter, setProjectFilter] = useState(ALL_PROJECTS);
    // Viewers read the board; they never drag, edit or archive, except inside
    // a project where they were given "Can edit" or Admin (0.20 Access).
    const canEdit = companyRole !== "viewer" || (projectFilter !== ALL_PROJECTS && editableProjectIds.includes(projectFilter));
    const [assigneeFilter, setAssigneeFilter] = useState("all");
    const [customerFilter, setCustomerFilter] = useState(ALL_CUSTOMERS);
    const [searchQuery, setSearchQuery] = useState("");
    const [events, setEvents] = useState<any[]>(taskEvents);
    const [projectMemoryItems, setProjectMemoryItems] = useState<any[]>(initialProjectMemory);
    const [isNotesOpen, setIsNotesOpen] = useState(false);
    const [projectDialogMode, setProjectDialogMode] = useState<"create" | "edit" | null>(null);
    const [editingProject, setEditingProject] = useState<any | null>(null);
    const [projectForm, setProjectForm] = useState<any>(emptyProjectForm);
    const [taskDialogMode, setTaskDialogMode] = useState<"create" | "edit" | null>(null);
    const [taskForm, setTaskForm] = useState<any>(emptyTaskForm);
    const [isMutating, setIsMutating] = useState(false);
    const [mutationError, setMutationError] = useState<string | null>(null);
    const [archiveProjectArmed, setArchiveProjectArmed] = useState<string | null>(null);
    const [archivingTaskId, setArchivingTaskId] = useState<string | null>(null);
    const [blockDialog, setBlockDialog] = useState<{ task: any } | null>(null);
    /** Tasks waiting on the "Archive N tasks?" confirmation (a lane's "Archive all" or the list selection). */
    const [bulkArchiveIds, setBulkArchiveIds] = useState<string[] | null>(null);
    const [listSelection, setListSelection] = useState<ReadonlySet<string>>(() => new Set());
    const [blockReasonDraft, setBlockReasonDraft] = useState("");
    const [hideCompletedProjects, setHideCompletedProjects] = useState(true);
    const [completingProject, setCompletingProject] = useState<string | null>(null);
    const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
    const [showAttentionOnly, setShowAttentionOnly] = useState(searchParams.get("attention") === "1");
    const [viewMode, setViewMode] = useState<"board" | "list">("board");
    const [phoneLane, setPhoneLane] = useState<string | null>(null);
    const [reviewFilter, setReviewFilter] = useState<ReviewBucket | null>(null);
    const [filtersHydrated, setFiltersHydrated] = useState(false);
    const sensors = useSensors(
        useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
        useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
    );

    // Saved filters, then deep links on top (a record card in chat wins over the saved filter).
    useEffect(() => {
        const savedProject = readStorage("projects-board-project-filter");
        const requestedAssignee = searchParams.get("assignee");
        const savedAssignee = readStorage("projects-board-assignee-filter");
        const savedAgent = readStorage("projects-board-agent-filter");
        const savedCustomer = readStorage("projects-board-customer-filter");
        const savedSearch = readStorage("projects-board-search-query");
        const savedHideCompleted = readStorage("projects-board-hide-completed");
        const savedView = readStorage("projects-board-view");

        const requestedProject = searchParams.get("project");
        if (requestedProject && projects.some((project) => project.id === requestedProject)) {
            setProjectFilter(requestedProject);
        } else if (savedProject && (savedProject === ALL_PROJECTS || projects.some((project) => project.id === savedProject))) {
            setProjectFilter(savedProject);
        }
        const validAssignees = { agentIds: agents.map((agent) => agent.id), memberIds: members.map((member) => member.id) };
        if (requestedAssignee) setAssigneeFilter(normalizeAssigneeFilter(requestedAssignee, validAssignees));
        else if (savedAssignee) setAssigneeFilter(normalizeAssigneeFilter(savedAssignee, validAssignees));
        else setAssigneeFilter(migrateLegacyAgentFilter(savedAgent, validAssignees.agentIds));
        if (savedAgent) { try { window.localStorage.removeItem("projects-board-agent-filter"); } catch { /* ignore */ } }
        if (savedCustomer && (savedCustomer === ALL_CUSTOMERS || customers.some((customer) => customer.id === savedCustomer))) setCustomerFilter(savedCustomer);
        if (savedSearch) setSearchQuery(savedSearch);
        if (savedHideCompleted === "0") setHideCompletedProjects(false);
        if (savedView === "list" || savedView === "board") setViewMode(savedView);
        setFiltersHydrated(true);
    }, [agents, customers, members, projects, searchParams]);

    // `?task=<id>` opens that task once, e.g. from a task card in chat.
    const openedTaskParamRef = useRef<string | null>(null);
    useEffect(() => {
        const requestedTask = searchParams.get("task");
        if (!requestedTask || openedTaskParamRef.current === requestedTask) return;
        if (!tasks.some((candidate) => candidate.id === requestedTask)) return;
        openedTaskParamRef.current = requestedTask;
        setSelectedTaskId(requestedTask);
    }, [searchParams, tasks]);

    useEffect(() => {
        if (!filtersHydrated) return;
        writeStorage("projects-board-project-filter", projectFilter);
        writeStorage("projects-board-assignee-filter", assigneeFilter);
        writeStorage("projects-board-customer-filter", customerFilter);
        writeStorage("projects-board-search-query", searchQuery);
        writeStorage("projects-board-hide-completed", hideCompletedProjects ? "1" : "0");
        writeStorage("projects-board-view", viewMode);
    }, [filtersHydrated, projectFilter, assigneeFilter, customerFilter, searchQuery, hideCompletedProjects, viewMode]);

    // ─── Lookups ────────────────────────────────────────────────────────────
    const projectById = useMemo(() => new Map(projectItems.map((project) => [project.id, project])), [projectItems]);
    const customerById = useMemo(() => new Map(customers.map((customer) => [customer.id, customer])), [customers]);
    const agentName = useCallback((id?: string | null) => {
        const agent = agents.find((item) => item.id === id);
        if (agent) return agent.name || t("unknownAgent");
        // An agent limited to other people: 🔒 its name for owners/admins, "Private agent" for others.
        const limited = limitedAgents.find((item) => item.id === id);
        if (limited) return limited.name ? `🔒 ${limited.name}` : t("privateAgent");
        return t("unknownAgent");
    }, [agents, limitedAgents, t]);
    const memberName = useCallback((id?: string | null) => {
        const member = members.find((item) => item.id === id);
        return member?.displayName || member?.email || t("unknownPerson");
    }, [members, t]);
    const projectLabel = useCallback((projectId?: string | null) => projectTitle(projectById.get(projectId ?? "")), [projectById]);
    const customerNameOf = useCallback((projectId?: string | null) => {
        const project = projectById.get(projectId ?? "");
        return project?.customerId ? customerById.get(project.customerId)?.name ?? null : null;
    }, [customerById, projectById]);

    const visibleProjects = useMemo(
        () => hideCompletedProjects ? projectItems.filter((p) => p.status !== "completed" && p.status !== "killed") : projectItems,
        [projectItems, hideCompletedProjects],
    );

    // ─── Filtering ──────────────────────────────────────────────────────────
    const scopedTasks = useMemo(() => tasks.filter((task) => {
        if (projectFilter !== ALL_PROJECTS && task.projectId !== projectFilter) return false;
        if (customerFilter !== ALL_CUSTOMERS && projectById.get(task.projectId)?.customerId !== customerFilter) return false;
        return true;
    }), [tasks, projectFilter, customerFilter, projectById]);

    const filteredTasks = useMemo(() => {
        const query = searchQuery.trim().toLowerCase();
        return scopedTasks.filter((task) => {
            const taskAssignee = assigneeValue(task);
            if (assigneeFilter === "human" && !task.assignedMemberId) return false;
            if (assigneeFilter === "agent" && !task.assignedAgentId) return false;
            if (assigneeFilter === "unassigned" && taskAssignee) return false;
            if (!["all", "human", "agent", "unassigned"].includes(assigneeFilter) && taskAssignee !== assigneeFilter) return false;
            if (!query) return true;
            const project = projectById.get(task.projectId);
            const customer = project?.customerId ? customerById.get(project.customerId) : null;
            const owner = task.assignedMemberId ? memberName(task.assignedMemberId) : task.assignedAgentId ? agentName(task.assignedAgentId) : "";
            const input = task.inputJson && typeof task.inputJson === "object" ? task.inputJson : {};
            return [taskTitle(task), input.description, input.goal, task.taskType, task.state, project?.goal, customer?.name, owner, task.templateVersion, task.contractVersion]
                .filter(Boolean).join(" ").toLowerCase().includes(query);
        });
    }, [scopedTasks, searchQuery, assigneeFilter, projectById, customerById, memberName, agentName]);

    const filteredRecurringDefinitions = useMemo(() => recurringDefinitions.filter((definition) => {
        if (projectFilter !== ALL_PROJECTS && definition.projectId !== projectFilter) return false;
        if (customerFilter !== ALL_CUSTOMERS && projectById.get(definition.projectId)?.customerId !== customerFilter) return false;
        return true;
    }), [recurringDefinitions, projectFilter, customerFilter, projectById]);

    const groups = useMemo(() => groupBoardTasks(filteredTasks, nowMs), [filteredTasks, nowMs]);

    // ─── Card view models ───────────────────────────────────────────────────
    const filteredToProject = projectFilter !== ALL_PROJECTS;
    const filteredToCustomer = customerFilter !== ALL_CUSTOMERS;
    const viewFor = useCallback((task: any): TaskView => {
        const project = projectLabel(task.projectId);
        const customer = customerNameOf(task.projectId);
        const owner = task.assignedMemberId
            ? { name: memberName(task.assignedMemberId), kind: "human" as const }
            : task.assignedAgentId ? { name: agentName(task.assignedAgentId), kind: "agent" as const } : null;
        const fresh = task.state === "inbox" || task.state === "queued";
        const stamp = fresh ? task.createdAt : task.updatedAt ?? task.createdAt;
        const stampDate = stamp ? new Date(stamp) : null;
        return {
            task,
            title: taskTitle(task),
            context: cardContextLine({ customerName: customer, projectName: project.name, filteredToProject, filteredToCustomer }),
            contextTitle: [customer, project.name, project.description].filter(Boolean).join("\n"),
            owner,
            priority: priorityLevel(task.priority),
            age: nowMs ? age(stamp, nowMs) : "",
            ageNow: nowMs ? ageParts(stamp, nowMs)?.key === "ageNow" : false,
            ageTitle: nowMs && stampDate && !Number.isNaN(stampDate.getTime()) ? t(fresh ? "createdAt" : "updatedAt", { when: format.dateTime(stampDate, { dateStyle: "medium", timeStyle: "short" }) }) : "",
            signals: cardSignals(task, { nowMs, waitingOnDependency: groups.waitingOnDependency.has(task.id), currentMemberId }),
            recurring: isRecurringTask(task),
        };
    }, [projectLabel, customerNameOf, memberName, agentName, filteredToProject, filteredToCustomer, nowMs, groups, currentMemberId, age, format, t]);

    const views = useMemo(() => new Map(filteredTasks.map((task) => [task.id, viewFor(task)])), [filteredTasks, viewFor]);
    const toViews = useCallback((list: any[]) => list.map((task) => views.get(task.id) ?? viewFor(task)), [views, viewFor]);

    // ─── Lanes ──────────────────────────────────────────────────────────────
    const reviewTasks = reviewFilter
        ? groups.columns.review.filter((task) => reviewBucketFor(task, groups.waitingOnDependency.has(task.id)) === reviewFilter)
        : groups.columns.review;
    const reviewHeader = groups.columns.review.length > 0 ? (
        <div className="flex flex-wrap gap-1" role="group" aria-label={t("filterReview")}>
            {(Object.keys(REVIEW_BUCKET_LABEL) as ReviewBucket[]).filter((bucket) => groups.reviewCounts[bucket] > 0).map((bucket) => {
                const active = reviewFilter === bucket;
                return (
                    <button
                        key={bucket}
                        type="button"
                        aria-pressed={active}
                        onClick={() => setReviewFilter(active ? null : bucket)}
                        className={cn(
                            "inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] transition-colors",
                            active ? "bg-violet-400/15 text-violet-100 ring-1 ring-inset ring-violet-400/30" : "bg-zinc-900 text-zinc-400 hover:text-zinc-200",
                        )}
                    >
                        {labels.reviewBucket(bucket)}
                        <span className="tabular-nums text-zinc-500">{groups.reviewCounts[bucket]}</span>
                    </button>
                );
            })}
        </div>
    ) : undefined;

    const lanes: Lane[] = showAttentionOnly
        ? [
            { key: "dead_letter", title: tTasks("lanes.deadLettered"), tone: "problem", icon: "failed", views: toViews(groups.attention.deadLetter), emptyText: tTasks("lanes.deadLetteredEmpty") },
            { key: "failed", title: tTasks("lanes.failed"), tone: "problem", icon: "failed", views: toViews(groups.attention.failed), emptyText: tTasks("lanes.failedEmpty") },
            { key: "stale_inbox", title: tTasks("lanes.staleInbox"), tone: "neutral", icon: "stale", views: toViews(groups.attention.staleInbox), emptyText: tTasks("lanes.staleInboxEmpty") },
            { key: "overdue_review", title: tTasks("lanes.overdueReview"), tone: "review", icon: "review", views: toViews(groups.attention.overdueReview), emptyText: tTasks("lanes.overdueReviewEmpty") },
        ]
        : [
            { key: "inbox", title: labels.column("inbox"), tone: "neutral", icon: "inbox", views: toViews(groups.columns.inbox), dropId: "inbox", emptyText: tTasks("lanes.inboxEmpty") },
            { key: "in_progress", title: labels.column("in_progress"), tone: "active", icon: "progress", views: toViews(groups.columns.in_progress), dropId: "in_progress", emptyText: tTasks("lanes.inProgressEmpty") },
            // Failed work is rare and needs the same thing as blocked work (a person), so it
            // shares this lane with a failed icon instead of taking a sixth column.
            { key: "blocked", title: groups.columns.exceptions.length > 0 ? tTasks("lanes.blockedOrFailed") : labels.column("blocked"), tone: "problem", icon: "blocked", views: toViews([...groups.columns.exceptions, ...groups.columns.blocked]), dropId: "blocked", emptyText: tTasks("lanes.blockedEmpty"), collapseWhenEmpty: true },
            { key: "review", title: labels.column("review"), tone: "review", icon: "review", views: toViews(reviewTasks), dropId: "review", emptyText: reviewFilter ? tTasks("lanes.reviewGroupEmpty") : tTasks("lanes.reviewEmpty"), header: reviewHeader, count: reviewFilter ? undefined : groups.columns.review.length },
            { key: "done", title: labels.column("done"), tone: "done", icon: "done", views: toViews(groups.columns.done), dropId: "done", emptyText: tTasks("lanes.doneEmpty") },
            ...((filteredRecurringDefinitions.length > 0 || groups.recurring.length > 0) ? [{
                key: "recurring",
                title: tTasks("lanes.recurring"),
                tone: "neutral" as const,
                icon: "recurring" as const,
                views: toViews(groups.recurring),
                definitions: filteredRecurringDefinitions.map((definition) => ({
                    definition,
                    projectName: filteredToProject ? "" : projectLabel(definition.projectId).name,
                    ownerName: definition.createdByAgentId ? agentName(definition.createdByAgentId) : "",
                })),
                emptyText: tTasks("lanes.recurringEmpty"),
            }] : []),
        ];

    if (canEdit) {
        for (const lane of lanes) {
            if (laneIsBulkArchivable({ key: lane.key, tasks: lane.views.map((view) => view.task), hasDefinitions: (lane.definitions?.length ?? 0) > 0 })) {
                const ids = lane.views.map((view) => view.task.id);
                lane.onArchiveAll = () => { setMutationError(null); setBulkArchiveIds(ids); };
            }
        }
    }

    // Phones show one lane at a time; default to where the work is.
    const activePhoneLane = lanes.find((lane) => lane.key === phoneLane)
        ?? lanes.find((lane) => lane.key === "in_progress" && laneCount(lane) > 0)
        ?? lanes.find((lane) => laneCount(lane) > 0)
        ?? lanes[0];

    // ─── Mutations ──────────────────────────────────────────────────────────
    const replaceTask = (next: any) => setTasks((prev) => prev.map((item) => item.id === next.id ? next : item));

    /** Apply `optimistic` immediately so drags and menu moves feel instant; roll back on failure. */
    const patchTask = async (task: any, body: Record<string, unknown>, options: { optimistic?: Record<string, unknown>; success?: string } = {}) => {
        if (options.optimistic) replaceTask({ ...task, ...options.optimistic });
        try {
            const updated = await patchTaskRequest(task.id, body);
            if (updated) replaceTask(updated);
            if (options.success) toast.success(options.success);
            return true;
        } catch (error) {
            if (options.optimistic) replaceTask(task);
            toast.error(messageOf(error, t("taskUpdateFailed")));
            return false;
        }
    };

    const setTaskState = (task: any, state: string) => {
        if (!canEdit || task.state === state) return;
        // Blocking needs a reason, asked for in a dialog; the task stays put until it is given.
        if (state === "blocked") {
            setBlockReasonDraft(blockedReason(task));
            setMutationError(null);
            setBlockDialog({ task });
            return;
        }
        void patchTask(task, { state }, { optimistic: { state, updatedAt: new Date().toISOString() }, success: tTasks("movedTo", { state: labels.state(state).toLowerCase() }) });
    };

    const setTaskPriority = (task: any, priority: number) => {
        if (!canEdit) return;
        const level = priorityLevel(priority);
        void patchTask(task, { priority }, { optimistic: { priority }, success: level ? tTasks("prioritySet", { priority: labels.priority(level.tone).toLowerCase() }) : tTasks("priorityCleared") });
    };

    const submitBlockTask = async () => {
        if (!blockDialog) return;
        const reason = blockReasonDraft.trim();
        if (!reason) { setMutationError(tTasks("block.reasonMissing")); return; }
        setIsMutating(true);
        setMutationError(null);
        try {
            const updated = await patchTaskRequest(blockDialog.task.id, { state: "blocked", blockedReason: reason });
            replaceTask(updated);
            toast.success(tTasks("block.done"));
            setBlockDialog(null);
            setBlockReasonDraft("");
        } catch (error) {
            setMutationError(messageOf(error, tTasks("block.failed")));
        } finally {
            setIsMutating(false);
        }
    };

    const sendTaskNote = async (task: any, text: string) => {
        try {
            const noteRes = await fetch(`/api/tasks/${task.id}/notes`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ comment: text }) });
            if (!noteRes.ok) throw new Error("note");
            const data = await noteRes.json().catch(() => ({}));
            if (data.event) setEvents((prev) => [...prev, data.event]);
            if (task.assignedAgentId) {
                await fetch("/api/chat", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ text: `Task Directive for TASK-${task.id}:\n${text}`, targetAgentId: task.assignedAgentId }),
                });
            }
            toast.success(task.assignedAgentId ? t("noteSentTo", { agent: agentName(task.assignedAgentId) }) : t("noteSaved"));
            return true;
        } catch (error) {
            console.error("Failed to send task note", error);
            toast.error(t("noteFailedRetry"));
            return false;
        }
    };

    const addProjectNote = async (content: string) => {
        if (projectFilter === ALL_PROJECTS) return false;
        const res = await fetch(`/api/projects/${projectFilter}/memory`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content }) });
        if (!res.ok) { toast.error(t("noteFailed")); return false; }
        const { data } = await res.json();
        setProjectMemoryItems((prev) => [data, ...prev]);
        return true;
    };

    const selectedProject = projectFilter === ALL_PROJECTS ? null : projectById.get(projectFilter) ?? null;

    const openCreateProject = () => {
        setMutationError(null);
        setEditingProject(null);
        setProjectForm({ ...emptyProjectForm, customerId: customerFilter === ALL_CUSTOMERS ? "" : customerFilter });
        setProjectDialogMode("create");
    };

    const openEditProject = (project: any) => {
        setMutationError(null);
        setEditingProject(project);
        setProjectForm({
            goal: project.goal || "",
            customerId: project.customerId || "",
            leadAgentId: project.leadAgentId || "",
            status: project.status || "active",
            requireApprovalForDone: Boolean(project.requireApprovalForDone),
            requireReviewBeforeDone: Boolean(project.requireReviewBeforeDone),
            commentRequiredForReview: Boolean(project.commentRequiredForReview),
            blockStatusChangesWithPendingApproval: Boolean(project.blockStatusChangesWithPendingApproval),
            onlyLeadCanChangeStatus: Boolean(project.onlyLeadCanChangeStatus),
            maxActiveAgents: project.maxActiveAgents || 3,
        });
        setProjectDialogMode("edit");
    };

    const submitProject = async () => {
        if (!projectForm.goal.trim()) return;
        setIsMutating(true);
        setMutationError(null);
        try {
            const endpoint = projectDialogMode === "edit" && editingProject ? `/api/projects/${editingProject.id}` : "/api/projects";
            const res = await fetch(endpoint, { method: projectDialogMode === "edit" ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...projectForm, goal: projectForm.goal.trim() }) });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || t("projectSaveFailed"));
            setProjectItems((prev) => projectDialogMode === "edit" ? prev.map((project) => project.id === data.project.id ? data.project : project) : [data.project, ...prev]);
            if (projectDialogMode !== "edit") setProjectFilter(data.project.id);
            setProjectDialogMode(null);
            router.refresh();
        } catch (error) {
            setMutationError(messageOf(error, t("projectSaveFailed")));
        } finally {
            setIsMutating(false);
        }
    };

    const archiveProject = async (project: any) => {
        if (archiveProjectArmed !== project.id) {
            setArchiveProjectArmed(project.id);
            window.setTimeout(() => setArchiveProjectArmed((current) => current === project.id ? null : current), 4000);
            return;
        }
        setArchiveProjectArmed(null);
        setIsMutating(true);
        setMutationError(null);
        try {
            const res = await fetch(`/api/projects/${project.id}`, { method: "DELETE" });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || t("projectArchiveFailed"));
            setProjectItems((prev) => prev.filter((item) => item.id !== project.id));
            setTasks((prev) => prev.filter((task) => task.projectId !== project.id));
            if (projectFilter === project.id) setProjectFilter(ALL_PROJECTS);
            toast.success(t("projectArchived"));
            router.refresh();
        } catch (error) {
            setMutationError(messageOf(error, t("projectArchiveFailed")));
        } finally {
            setIsMutating(false);
        }
    };

    const setProjectStatus = async (project: any, status: "completed" | "active") => {
        setIsMutating(true);
        setMutationError(null);
        if (status === "completed") setCompletingProject(project.id);
        try {
            const res = await fetch(`/api/projects/${project.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }) });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || t("projectUpdateFailed"));
            setProjectItems((prev) => prev.map((p) => p.id === project.id ? { ...p, status } : p));
            toast.success(status === "completed" ? t("projectCompleted", { name: projectTitle(project).name }) : t("projectReopened", { name: projectTitle(project).name }));
            router.refresh();
        } catch (error) {
            setMutationError(messageOf(error, t("projectUpdateFailed")));
            toast.error(t("projectUpdateFailedToast"));
        } finally {
            setIsMutating(false);
            setCompletingProject(null);
        }
    };

    const openCreateTask = useCallback((projectId?: string) => {
        setMutationError(null);
        // With one project in view there is nothing to choose; otherwise the dialog asks.
        const only = visibleProjects.length === 1 ? visibleProjects[0].id : "";
        setTaskForm({ ...emptyTaskForm, projectId: projectId || selectedProject?.id || only });
        setTaskDialogMode("create");
    }, [selectedProject, visibleProjects]);

    // `?new=task` (the sidebar "+" and the command palette) opens New task once.
    const newTaskParamHandled = useRef(false);
    const wantsNewTask = searchParams.get("new") === "task";
    useEffect(() => {
        if (!wantsNewTask) { newTaskParamHandled.current = false; return; }
        if (!filtersHydrated || newTaskParamHandled.current || !canEdit) return;
        newTaskParamHandled.current = true;
        openCreateTask();
        router.replace("/projects", { scroll: false });
    }, [wantsNewTask, filtersHydrated, canEdit, openCreateTask, router]);

    const selectedTask = selectedTaskId ? tasks.find((task) => task.id === selectedTaskId) ?? null : null;

    const openEditTask = (task: any) => {
        const input = task.inputJson && typeof task.inputJson === "object" ? task.inputJson : {};
        setMutationError(null);
        setTaskForm({
            projectId: task.projectId,
            title: taskTitle(task),
            taskType: task.taskType || "manual_task",
            description: taskBody(task) || "",
            goal: typeof input.goal === "string" ? input.goal : "",
            priority: task.priority || 0,
            assignee: assigneeValue(task),
            state: task.state || "inbox",
            acceptanceCriteria: Array.isArray(input.acceptanceCriteria) ? input.acceptanceCriteria.join("\n") : "",
            definitionOfDone: typeof input.definitionOfDone === "string" ? input.definitionOfDone : "",
            deliverables: Array.isArray(input.deliverables) ? input.deliverables.join("\n") : "",
            proofRequired: Boolean(task.proofRequired),
            humanApprovalRequired: Boolean(task.humanApprovalRequired),
        });
        setTaskDialogMode("edit");
    };

    // A workspace with no projects yet: the first task goes into "General" (created by the server).
    const useDefaultProject = taskDialogMode === "create" && !taskForm.projectId && projectItems.length === 0;
    const submitTask = async () => {
        if ((!taskForm.projectId && !useDefaultProject) || !taskForm.title.trim()) return;
        setIsMutating(true);
        setMutationError(null);
        try {
            const inputJson = {
                title: taskForm.title.trim(),
                description: taskForm.description,
                goal: taskForm.goal || taskForm.title.trim(),
                acceptanceCriteria: String(taskForm.acceptanceCriteria || "").split("\n").map((line) => line.trim()).filter(Boolean),
                definitionOfDone: taskForm.definitionOfDone,
                deliverables: String(taskForm.deliverables || "").split("\n").map((line) => line.trim()).filter(Boolean),
            };
            const isEdit = taskDialogMode === "edit" && selectedTask;
            const res = await fetch(isEdit ? `/api/tasks/${selectedTask.id}` : "/api/tasks", {
                method: isEdit ? "PATCH" : "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ...taskForm, assignee: parseAssigneeValue(taskForm.assignee), priority: Number(taskForm.priority) || 0, inputJson, ...(useDefaultProject && !isEdit ? { useDefaultProject: true } : {}) }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || t("taskSaveFailed"));
            setTasks((prev) => isEdit ? prev.map((task) => task.id === data.task.id ? data.task : task) : [data.task, ...prev]);
            if (!isEdit && !projectById.has(data.task.projectId)) setProjectItems((prev) => [...prev, { id: data.task.projectId, goal: "General", status: "active", customerId: null }]);
            setTaskDialogMode(null);
            router.refresh();
        } catch (error) {
            setMutationError(messageOf(error, t("taskSaveFailed")));
        } finally {
            setIsMutating(false);
        }
    };

    const archiveTask = async (task: any) => {
        setIsMutating(true);
        setMutationError(null);
        try {
            const res = await fetch(`/api/tasks/${task.id}`, { method: "DELETE" });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || t("taskArchiveFailed"));
            setTasks((prev) => prev.filter((item) => item.id !== task.id));
            setArchivingTaskId(null);
            if (selectedTaskId === task.id) setSelectedTaskId(null);
            toast.success(t("taskArchived"));
            router.refresh();
        } catch (error) {
            setMutationError(messageOf(error, t("taskArchiveFailed")));
        } finally {
            setIsMutating(false);
        }
    };

    const restoreTasks = async (ids: string[], snapshot: any[]) => {
        try {
            const { changed } = await bulkTaskRequest("/api/tasks/unarchive", ids, "restored");
            const back = new Set(changed);
            setTasks((prev) => {
                const present = new Set(prev.map((task) => task.id));
                return [...snapshot.filter((task) => back.has(task.id) && !present.has(task.id)).map((task) => ({ ...task, deletedAt: null })), ...prev];
            });
            if (changed.length < ids.length) toast.warning(t("restoredPartly", { restored: taskCount(changed.length), failed: taskCount(ids.length - changed.length) }));
            else toast.success(t("restored", { tasks: taskCount(changed.length) }));
            router.refresh();
        } catch (error) {
            toast.error(messageOf(error, t("restoreFailed")));
        }
    };

    const archiveTasks = async (ids: string[]) => {
        setIsMutating(true);
        setMutationError(null);
        try {
            const { changed, skipped } = await bulkTaskRequest("/api/tasks/archive", ids, "archived");
            const gone = new Set(changed);
            const snapshot = tasks.filter((task) => gone.has(task.id));
            setTasks((prev) => prev.filter((task) => !gone.has(task.id)));
            setListSelection((prev) => new Set([...prev].filter((id) => !gone.has(id))));
            if (selectedTaskId && gone.has(selectedTaskId)) setSelectedTaskId(null);
            setBulkArchiveIds(null);
            toast.success(t("archived", { tasks: taskCount(changed.length) }), {
                description: skipped > 0 ? t("archiveSkipped", { tasks: taskCount(skipped), count: skipped }) : undefined,
                duration: UNDO_TOAST_MS,
                action: changed.length > 0 ? { label: t("undo"), onClick: () => void restoreTasks(changed, snapshot) } : undefined,
            });
            router.refresh();
        } catch (error) {
            setMutationError(messageOf(error, t("archiveFailed")));
        } finally {
            setIsMutating(false);
        }
    };

    // List-view selection only ever holds tasks the current filters show.
    const visibleIds = useMemo(() => new Set(filteredTasks.map((task) => task.id)), [filteredTasks]);
    const selectedVisibleIds = [...listSelection].filter((id) => visibleIds.has(id));
    const rowSelection: RowSelection | undefined = canEdit && viewMode === "list" ? {
        ids: listSelection,
        toggle: (taskId) => setListSelection((prev) => {
            const next = new Set(prev);
            if (next.has(taskId)) next.delete(taskId); else next.add(taskId);
            return next;
        }),
        setMany: (taskIds, selected) => setListSelection((prev) => {
            const next = new Set(prev);
            for (const id of taskIds) { if (selected) next.add(id); else next.delete(id); }
            return next;
        }),
    } : undefined;

    // ─── Drag and drop ──────────────────────────────────────────────────────
    const handleDragStart = (event: DragStartEvent) => setDraggingTaskId(String(event.active.id));
    const handleDragEnd = (event: DragEndEvent) => {
        setDraggingTaskId(null);
        if (!event.over || !canEdit) return;
        const newState = COLUMN_DROP_STATE[String(event.over.id) as BoardColumnKey];
        const task = tasks.find((item) => item.id === event.active.id);
        if (newState && task) setTaskState(task, newState);
    };
    const draggingTask = draggingTaskId ? tasks.find((task) => task.id === draggingTaskId) : null;

    const handlers: CardHandlers = {
        canEdit,
        selectedId: selectedTaskId,
        onOpen: (task) => setSelectedTaskId(task.id),
        onSetPriority: setTaskPriority,
        onSetState: setTaskState,
        onArchive: (task) => { setMutationError(null); setArchivingTaskId(task.id); },
    };

    // ─── Filter copy ────────────────────────────────────────────────────────
    const customerOptions = [
        { value: ALL_CUSTOMERS, label: t("allCustomers"), description: t("customerCount", { count: customers.length }) },
        ...customers.map((customer) => ({ value: customer.id, label: customer.name, description: t("projectCount", { count: projectItems.filter((project) => project.customerId === customer.id).length }) })),
    ];
    const projectOptions = [
        { value: ALL_PROJECTS, label: t("allProjects"), description: hideCompletedProjects ? t("activeProjectCount", { count: visibleProjects.length }) : t("projectCount", { count: visibleProjects.length }) },
        ...visibleProjects
            .filter((project) => customerFilter === ALL_CUSTOMERS || project.customerId === customerFilter)
            .map((project) => {
                const title = projectTitle(project);
                const customerName = customerById.get(project.customerId)?.name || t("noCustomer");
                const finished = project.status === "completed" || project.status === "killed";
                return {
                    value: project.id,
                    label: title.name,
                    description: finished ? `${customerName} · ${labels.projectStatus(project.status)}` : customerName,
                    keywords: title.description,
                };
            }),
    ];
    const assigneeOptions = [
        { value: "all", label: t("assignees.all"), description: t("assignees.allDescription", { people: members.length, agents: agents.length }) },
        ...(currentMemberId ? [{ value: `human:${currentMemberId}`, label: t("assignees.me"), description: t("assignees.meDescription") }] : []),
        { value: "human", label: t("assignees.people"), description: t("assignees.peopleDescription") },
        { value: "agent", label: t("assignees.agents"), description: t("assignees.agentsDescription") },
        { value: "unassigned", label: t("assignees.unassigned"), description: t("assignees.unassignedDescription") },
        ...members.map((member) => ({ value: `human:${member.id}`, label: member.displayName || member.email, description: member.roleTitle || t("assignees.person") })),
        ...agents.map((agent) => ({ value: `agent:${agent.id}`, label: agent.name, description: agent.role || t("assignees.agent") })),
    ];
    const assigneeLabel = assigneeOptions.find((option) => option.value === assigneeFilter)?.label;
    const filterParts = [
        selectedProject ? projectTitle(selectedProject).name : null,
        filteredToCustomer && !selectedProject ? customerById.get(customerFilter)?.name ?? null : null,
        assigneeFilter !== "all" ? assigneeLabel ?? null : null,
        searchQuery.trim() ? `"${searchQuery.trim()}"` : null,
    ].filter(Boolean) as string[];
    const hasBoardFilters = filterParts.length > 0;
    const totalCount = tasks.length;
    const shownCount = filteredTasks.length;

    const clearBoardFilters = () => {
        setProjectFilter(ALL_PROJECTS);
        setAssigneeFilter("all");
        setCustomerFilter(ALL_CUSTOMERS);
        setSearchQuery("");
        setReviewFilter(null);
        if (searchParams.has("assignee") || searchParams.has("project")) router.replace("/projects");
    };

    // Auto-split names (and the name migration) keep the purpose as a tagged project note.
    const selectedProjectPurpose = selectedProject
        ? projectMemoryItems
            .filter((item) => item.projectId === selectedProject.id && Array.isArray(item.tags) && item.tags.includes("project-purpose"))
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0]?.content?.replace(/^\*\*Purpose\*\*\s*/, "") ?? null
        : null;

    const currentProjectNotes = projectMemoryItems
        .filter((item) => projectFilter === ALL_PROJECTS || item.projectId === projectFilter)
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const nothingMatches = shownCount === 0 && filteredRecurringDefinitions.length === 0;
    const segmented = "inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60";

    return (
        <div className="relative mx-auto flex h-full max-w-[1800px] flex-col gap-4">
            <PageHeader
                eyebrow={t("eyebrow")}
                title={t("title")}
                description={t("description")}
                actions={canEdit ? (
                    <>
                        <button type="button" onClick={openCreateProject} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-900/80 px-3 text-sm font-medium text-zinc-100 transition-colors hover:border-zinc-600 hover:bg-zinc-800">
                            <IconPlus className="h-4 w-4" aria-hidden="true" />{t("newProject")}
                        </button>
                        <button type="button" onClick={() => openCreateTask()} className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-cyan-400/15 px-3 text-sm font-semibold text-cyan-50 ring-1 ring-inset ring-cyan-400/30 transition-colors hover:bg-cyan-400/25">
                            <IconPlus className="h-4 w-4" aria-hidden="true" />{t("newTask")}
                        </button>
                    </>
                ) : (
                    <DisabledReason reason={t("viewOnly")}>
                        <button type="button" disabled className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-sm font-medium text-muted-foreground disabled:opacity-60">
                            <IconPlus className="h-4 w-4" aria-hidden="true" />{t("newTask")}
                        </button>
                    </DisabledReason>
                )}
            />

            <div className="emperor-panel rounded-2xl p-3">
                <div className="flex flex-wrap items-center gap-2">
                    <label className="relative min-w-0 flex-[1_1_16rem]">
                        <span className="sr-only">{t("searchTasks")}</span>
                        <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" aria-hidden="true" />
                        <input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder={t("searchTasks")} className="h-10 w-full rounded-xl border border-zinc-800 bg-zinc-950/80 pl-9 pr-9 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400/60" />
                        {searchQuery && (
                            <button type="button" onClick={() => setSearchQuery("")} aria-label={t("clearSearch")} className="absolute right-2 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-zinc-500 hover:text-zinc-200"><IconX className="h-3.5 w-3.5" aria-hidden="true" /></button>
                        )}
                    </label>
                    <SearchableSelect
                        value={customerFilter}
                        options={customerOptions}
                        placeholder={t("allCustomers")}
                        searchPlaceholder={t("searchCustomers")}
                        className="hidden min-w-0 flex-[1_1_11rem] sm:block sm:max-w-[15rem]"
                        onChange={(nextCustomerId) => {
                            setCustomerFilter(nextCustomerId);
                            if (projectFilter !== ALL_PROJECTS && nextCustomerId !== ALL_CUSTOMERS && projectById.get(projectFilter)?.customerId !== nextCustomerId) setProjectFilter(ALL_PROJECTS);
                        }}
                    />
                    <SearchableSelect
                        value={projectFilter}
                        options={projectOptions}
                        placeholder={t("allProjects")}
                        searchPlaceholder={t("searchProjects")}
                        onChange={setProjectFilter}
                        className="min-w-0 flex-[1_1_13rem] sm:max-w-[18rem]"
                    />
                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            aria-pressed={showAttentionOnly}
                            onClick={() => setShowAttentionOnly((prev) => !prev)}
                            title={t("needsAttentionHint")}
                            className={cn(
                                "inline-flex h-10 items-center gap-1.5 rounded-xl border px-3 text-sm transition-colors",
                                showAttentionOnly ? "border-rose-400/40 bg-rose-400/10 text-rose-100" : "border-zinc-800 bg-zinc-950/80 text-zinc-300 hover:border-zinc-700 hover:text-zinc-100",
                            )}
                        >
                            <IconAlertTriangle className="h-4 w-4" aria-hidden="true" />
                            {t("needsAttention")}
                            {groups.attentionCount > 0 && <span className={cn("rounded-full px-1.5 text-xs tabular-nums", showAttentionOnly ? "bg-rose-400/20" : "bg-zinc-800 text-zinc-300")}>{groups.attentionCount}</span>}
                        </button>
                        <div role="group" aria-label={t("layout")} className="hidden h-10 items-center gap-0.5 rounded-xl border border-zinc-800 bg-zinc-950/80 p-1 md:inline-flex">
                            <button type="button" aria-pressed={viewMode === "board"} onClick={() => setViewMode("board")} className={cn(segmented, viewMode === "board" ? "bg-zinc-800 text-zinc-50" : "text-zinc-400 hover:text-zinc-200")}><IconLayoutColumns className="h-4 w-4" aria-hidden="true" />{t("board")}</button>
                            <button type="button" aria-pressed={viewMode === "list"} onClick={() => setViewMode("list")} className={cn(segmented, viewMode === "list" ? "bg-zinc-800 text-zinc-50" : "text-zinc-400 hover:text-zinc-200")}><IconList className="h-4 w-4" aria-hidden="true" />{t("list")}</button>
                        </div>
                    </div>
                </div>
                <details className="group mt-2">
                    <summary className="inline-flex cursor-pointer select-none items-center rounded-md px-1 py-1 text-xs font-medium text-zinc-400 hover:text-zinc-200">{t("moreFilters")}</summary>
                    <div className="mt-2 flex flex-wrap items-center gap-3 border-t border-zinc-800/80 pt-3">
                        <SearchableSelect value={customerFilter} options={customerOptions} placeholder={t("allCustomers")} searchPlaceholder={t("searchCustomers")} onChange={setCustomerFilter} className="min-w-[14rem] sm:hidden" />
                        <SearchableSelect value={assigneeFilter} options={assigneeOptions} placeholder={t("assignees.all")} searchPlaceholder={t("searchAssignees")} onChange={setAssigneeFilter} className="min-w-[14rem]" />
                        <label className="inline-flex min-h-10 items-center gap-2 text-sm text-zinc-300">
                            <input type="checkbox" checked={!hideCompletedProjects} onChange={(event) => setHideCompletedProjects(!event.target.checked)} className="h-4 w-4 accent-cyan-500" />
                            {t("includeFinished")}
                        </label>
                    </div>
                </details>
            </div>

            {selectedProject && (
                <ProjectHeader
                    project={selectedProject}
                    title={projectTitle({ ...selectedProject, description: selectedProjectPurpose })}
                    customerName={customerNameOf(selectedProject.id)}
                    leadName={selectedProject.leadAgentId ? agentName(selectedProject.leadAgentId) : null}
                    taskCount={scopedTasks.length}
                    canEdit={canEdit}
                    archiveArmed={archiveProjectArmed === selectedProject.id}
                    completing={completingProject === selectedProject.id}
                    onClear={() => setProjectFilter(ALL_PROJECTS)}
                    onNotes={() => setIsNotesOpen(true)}
                    onEdit={() => openEditProject(selectedProject)}
                    onComplete={() => void setProjectStatus(selectedProject, "completed")}
                    onReopen={() => void setProjectStatus(selectedProject, "active")}
                    onArchive={() => void archiveProject(selectedProject)}
                    accessSlot={<ResourceAccessButton type="project" id={selectedProject.id} className="h-9" />}
                />
            )}
            {selectedProject && <ScopeViewsSection key={selectedProject.id} projectId={selectedProject.id} hideWhenEmpty />}

            {hasBoardFilters && (
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-sm text-zinc-400" role="status">
                    <span>{t.rich("showing", { shown: shownCount, total: totalCount, strong: (chunks) => <span className="tabular-nums text-zinc-200">{chunks}</span>, num: (chunks) => <span className="tabular-nums">{chunks}</span> })}</span>
                    <span aria-hidden="true">·</span>
                    <span className="min-w-0 truncate">{t.rich("filteredTo", { filters: filterParts.join(", "), strong: (chunks) => <span className="text-zinc-200">{chunks}</span> })}</span>
                    <button type="button" onClick={clearBoardFilters} className="rounded-md px-1.5 py-0.5 text-sm font-medium text-cyan-300 hover:bg-cyan-400/10 hover:text-cyan-200">{t("clear")}</button>
                </p>
            )}

            {mutationError && !projectDialogMode && !taskDialogMode && !blockDialog && !archivingTaskId && !bulkArchiveIds && (
                <div role="alert" className="flex items-start gap-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
                    <span className="flex-1">{mutationError}</span>
                    <button type="button" onClick={() => setMutationError(null)} aria-label={t("dismiss")} className="text-rose-300 hover:text-rose-100"><IconX className="h-4 w-4" aria-hidden="true" /></button>
                </div>
            )}

            {nothingMatches ? (
                totalCount === 0 ? (
                    <EmptyState
                        className="flex-1 justify-center"
                        icon={IconLayoutColumns}
                        title={t("emptyTitle")}
                        description={canEdit ? t("emptyDescription") : t("emptyViewOnly")}
                        action={canEdit && <button type="button" onClick={() => openCreateTask()} className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-cyan-400/15 px-4 text-sm font-semibold text-cyan-50 ring-1 ring-inset ring-cyan-400/30 hover:bg-cyan-400/25"><IconPlus className="h-4 w-4" aria-hidden="true" />{t("createTask")}</button>}
                    />
                ) : (
                    <EmptyState
                        className="flex-1 justify-center"
                        icon={IconSearch}
                        title={showAttentionOnly && !hasBoardFilters ? t("nothingNeedsAttention") : t("noMatchTitle")}
                        description={hasBoardFilters ? t("hiddenBy", { count: totalCount, filters: filterParts.join(", ") }) : t("everythingMoving")}
                        action={hasBoardFilters && <button type="button" onClick={clearBoardFilters} className="inline-flex h-10 items-center rounded-lg border border-border px-4 text-sm font-medium text-foreground hover:bg-muted">{t("clearFilters")}</button>}
                    />
                )
            ) : (
                <>
                    {/* Desktop board */}
                    <div className={cn("min-h-0 flex-1", viewMode === "board" ? "hidden md:flex" : "hidden")}>
                        <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd} onDragCancel={() => setDraggingTaskId(null)}>
                            <div className="flex min-h-[28rem] w-full gap-3 overflow-x-auto pb-2">
                                {lanes.map((lane) => <BoardLane key={lane.key} lane={lane} handlers={handlers} dragging={Boolean(draggingTask)} />)}
                            </div>
                            <DragOverlay dropAnimation={{ duration: 180, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" }}>
                                {draggingTask ? <TaskCard view={viewFor(draggingTask)} canEdit={canEdit} onOpen={() => {}} overlay /> : null}
                            </DragOverlay>
                        </DndContext>
                    </div>
                    {/* Desktop list */}
                    {viewMode === "list" && (
                        <div className="hidden md:block">
                            {rowSelection && selectedVisibleIds.length > 0 && (
                                <div role="region" aria-label={t("selectedTasks")} className="sticky top-0 z-10 mb-3 flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-950/95 px-3 py-2 text-sm text-zinc-300 shadow-lg shadow-black/30 backdrop-blur">
                                    <span>{t.rich("selectedCount", { count: selectedVisibleIds.length, num: (chunks) => <span className="tabular-nums text-zinc-100">{chunks}</span> })}</span>
                                    <button type="button" onClick={() => { setMutationError(null); setBulkArchiveIds(selectedVisibleIds); }} className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-lg bg-rose-500/15 px-3 text-sm font-medium text-rose-100 ring-1 ring-inset ring-rose-400/30 hover:bg-rose-500/25">{t("archiveSelected")}</button>
                                    <button type="button" onClick={() => setListSelection(new Set())} className="inline-flex h-8 items-center rounded-lg px-2 text-sm text-zinc-400 hover:text-zinc-200">{t("clear")}</button>
                                </div>
                            )}
                            <LaneList lanes={lanes} handlers={handlers} selection={rowSelection} />
                        </div>
                    )}
                    {/* Phones: one state at a time */}
                    <div className="space-y-3 md:hidden">
                        <LaneSwitcher lanes={lanes} active={activePhoneLane.key} onChange={setPhoneLane} />
                        <LaneList lanes={[activePhoneLane]} handlers={handlers} />
                    </div>
                </>
            )}

            {selectedTask && (
                <TaskDrawer
                    task={selectedTask}
                    view={views.get(selectedTask.id) ?? viewFor(selectedTask)}
                    project={projectLabel(selectedTask.projectId)}
                    customerName={customerNameOf(selectedTask.projectId)}
                    workTypeLabel={labels.workType(selectedTask.taskType)}
                    events={events.filter((event) => event.taskId === selectedTask.id)}
                    artifacts={artifacts.filter((artifact) => artifact.taskId === selectedTask.id)}
                    agents={agents}
                    members={members}
                    lookups={{ agentName, memberName }}
                    canEdit={canEdit}
                    busy={isMutating}
                    onClose={() => setSelectedTaskId(null)}
                    onSetState={(state) => setTaskState(selectedTask, state)}
                    onAssign={(value) => void patchTask(selectedTask, { assignee: parseAssigneeValue(value) }, { success: value ? t("ownerChanged") : t("ownerRemoved") })}
                    onSetPriority={(priority) => setTaskPriority(selectedTask, priority)}
                    onEdit={() => openEditTask(selectedTask)}
                    onArchive={() => { setMutationError(null); setArchivingTaskId(selectedTask.id); }}
                    onSendNote={(text) => sendTaskNote(selectedTask, text)}
                />
            )}

            {isNotesOpen && selectedProject && (
                <ProjectNotesPanel
                    projectName={projectTitle(selectedProject).name}
                    notes={currentProjectNotes}
                    agentName={agentName}
                    canEdit={canEdit}
                    onAdd={addProjectNote}
                    onClose={() => setIsNotesOpen(false)}
                />
            )}

            <ProjectFormDialog mode={projectDialogMode} form={projectForm} setForm={setProjectForm} customers={customers} agents={agents} busy={isMutating} error={projectDialogMode ? mutationError : null} onClose={() => setProjectDialogMode(null)} onSubmit={() => void submitProject()} />
            <TaskFormDialog mode={taskDialogMode} form={taskForm} setForm={setTaskForm} projects={taskDialogMode === "edit" ? projectItems : visibleProjects} defaultProject={useDefaultProject} customers={customers} agents={agents} members={members} busy={isMutating} error={taskDialogMode ? mutationError : null} onClose={() => setTaskDialogMode(null)} onSubmit={() => void submitTask()} />
            <ConfirmArchiveTaskDialog
                open={Boolean(archivingTaskId)}
                title={taskTitle(tasks.find((task) => task.id === archivingTaskId) ?? { id: "" })}
                busy={isMutating}
                error={archivingTaskId ? mutationError : null}
                onCancel={() => setArchivingTaskId(null)}
                onConfirm={() => { const task = tasks.find((item) => item.id === archivingTaskId); if (task) void archiveTask(task); }}
            />
            <ConfirmArchiveTasksDialog
                open={Boolean(bulkArchiveIds)}
                count={bulkArchiveIds?.length ?? 0}
                busy={isMutating}
                error={bulkArchiveIds ? mutationError : null}
                onCancel={() => setBulkArchiveIds(null)}
                onConfirm={() => { if (bulkArchiveIds) void archiveTasks(bulkArchiveIds); }}
            />
            <BlockTaskDialog
                open={Boolean(blockDialog)}
                title={blockDialog ? taskTitle(blockDialog.task) : tTasks("drawer.task")}
                reason={blockReasonDraft}
                setReason={setBlockReasonDraft}
                busy={isMutating}
                error={blockDialog ? mutationError : null}
                onCancel={() => { setBlockDialog(null); setBlockReasonDraft(""); setMutationError(null); }}
                onConfirm={() => void submitBlockTask()}
            />
        </div>
    );
}
