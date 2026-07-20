"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */

import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { DndContext, DragOverlay, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { IconAlertTriangle, IconArchive, IconBrain, IconCircleCheck, IconChevronRight, IconPencil, IconFilter, IconHistory, IconInbox, IconDots, IconPlus, IconRepeat, IconRotate, IconSearch, IconSend, IconTrash, IconCircleX } from "@tabler/icons-react";
import { toast } from "sonner";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import { PageHeader } from "@/components/page-header";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { SearchableSelect } from "@/components/ui/searchable-select";
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
    companyRole?: string;
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
    assignedAgentId: "",
    state: "inbox",
    acceptanceCriteria: "",
    definitionOfDone: "",
    deliverables: "",
    proofRequired: false,
    humanApprovalRequired: false,
};
const taskStates = ["inbox", "in_progress", "review", "done", "failed", "dead_letter"];

const PRIORITY_OPTIONS = [
    { value: 0, label: "No priority", cls: "text-zinc-400 border-zinc-600" },
    { value: 25, label: "Low", cls: "text-slate-300 border-slate-500/40" },
    { value: 50, label: "Medium", cls: "text-amber-300 border-amber-500/40" },
    { value: 75, label: "High", cls: "text-orange-300 border-orange-500/40" },
    { value: 100, label: "Critical", cls: "text-rose-300 border-rose-500/40" },
];
const getPriorityInfo = (p: number) => PRIORITY_OPTIONS.reduce((best, opt) => (p >= opt.value ? opt : best), PRIORITY_OPTIONS[0]);
const COLUMN_DROP_STATE: Record<string, string> = {
    inbox: "inbox",
    in_progress: "in_progress",
    review: "review",
    done: "done",
    exceptions: "failed",
};
const projectStatuses = ["active", "paused", "completed", "killed"];
const PROJECT_STATUS_STYLES: Record<string, string> = {
    active: "border-emerald-500/25 bg-emerald-500/10 text-emerald-300",
    paused: "border-amber-500/25 bg-amber-500/10 text-amber-300",
    completed: "border-cyan-500/25 bg-cyan-500/10 text-cyan-300",
    killed: "border-red-500/25 bg-red-500/10 text-red-300",
};
const workTypeOptions = [
    { value: "manual_task", label: "Standard task" },
    { value: "research", label: "Research" },
    { value: "implementation", label: "Implementation" },
    { value: "review", label: "Review" },
    { value: "outreach", label: "Outreach" },
    { value: "reporting", label: "Reporting" },
];

function humanizeKey(value: unknown) {
    if (typeof value !== "string" || !value.trim()) return "";
    return value
        .replace(/[_:-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function getWorkTypeLabel(value: unknown) {
    const option = workTypeOptions.find((item) => item.value === value);
    return option?.label || humanizeKey(value) || "Standard task";
}

export default function ProjectsClient({ initialTasks, projects, agents, customers, recurringDefinitions = [], artifacts = [], taskEvents = [], initialProjectMemory = [], companyRole = "member" }: Props) {
    const router = useRouter();
    const [tasks, setTasks] = useState<any[]>(initialTasks);
    const [projectItems, setProjectItems] = useState<any[]>(projects);
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
    const [projectDialogMode, setProjectDialogMode] = useState<"create" | "edit" | null>(null);
    const [editingProject, setEditingProject] = useState<any | null>(null);
    const [projectForm, setProjectForm] = useState<any>(emptyProjectForm);
    const [taskDialogMode, setTaskDialogMode] = useState<"create" | "edit" | null>(null);
    const [taskForm, setTaskForm] = useState<any>(emptyTaskForm);
    const [isMutating, setIsMutating] = useState(false);
    const [mutationError, setMutationError] = useState<string | null>(null);
    const [confirmingArchive, setConfirmingArchive] = useState<string | null>(null);
    const [hideCompletedProjects, setHideCompletedProjects] = useState(true); // default: hide completed; localStorage overrides in useEffect
    const [completingProject, setCompletingProject] = useState<string | null>(null);
    const [draggingTask, setDraggingTask] = useState<any | null>(null);
    const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));
    const searchParams = useSearchParams();
    const [showAttentionOnly, setShowAttentionOnly] = useState(searchParams.get("attention") === "1");

    // Initial load from localStorage
    useEffect(() => {
        const savedProject = localStorage.getItem("projects-board-project-filter");
        const savedAgent = localStorage.getItem("projects-board-agent-filter");
        const savedCustomer = localStorage.getItem("projects-board-customer-filter");
        const savedSearch = localStorage.getItem("projects-board-search-query");
        const savedHideCompleted = localStorage.getItem("projects-board-hide-completed");

        if (savedProject) setProjectFilter(savedProject);
        if (savedAgent) setAgentFilter(savedAgent);
        if (savedCustomer) setCustomerFilter(savedCustomer);
        if (savedSearch) setSearchQuery(savedSearch);
        // Only override the default (true) if user explicitly chose to show all
        if (savedHideCompleted === "0") setHideCompletedProjects(false);
    }, []);

    // Save to localStorage when filters change
    useEffect(() => {
        localStorage.setItem("projects-board-project-filter", projectFilter);
        localStorage.setItem("projects-board-agent-filter", agentFilter);
        localStorage.setItem("projects-board-customer-filter", customerFilter);
        localStorage.setItem("projects-board-search-query", searchQuery);
    }, [projectFilter, agentFilter, customerFilter, searchQuery]);

    // Persist hide-completed preference
    useEffect(() => {
        localStorage.setItem("projects-board-hide-completed", hideCompletedProjects ? "1" : "0");
    }, [hideCompletedProjects]);

    // Filtered project list (exclude completed when toggled)
    const visibleProjects = useMemo(() => {
        if (!hideCompletedProjects) return projectItems;
        return projectItems.filter((p) => p.status !== "completed" && p.status !== "killed");
    }, [projectItems, hideCompletedProjects]);

    const filteredTasks = useMemo(() => {
        const query = searchQuery.trim().toLowerCase();
        return tasks.filter((task) => {
            if (projectFilter !== "All Projects" && task.projectId !== projectFilter) return false;
            if (agentFilter !== "All Agents" && task.assignedAgentId !== agentFilter) return false;
            
            if (customerFilter !== "All Customers") {
                const project = projectItems.find((p) => p.id === task.projectId);
                if (!project || project.customerId !== customerFilter) return false;
            }

            if (!query) return true;

            const project = projectItems.find((item) => item.id === task.projectId);
            const customer = project ? customers.find((item) => item.id === project.customerId) : null;
            const agent = task.assignedAgentId ? agents.find((item) => item.id === task.assignedAgentId) : null;
            const input = taskInput(task);
            return [getTaskTitle(task), input.description, input.goal, task.taskType, task.state, project?.goal, customer?.name, agent?.name, task.templateVersion, task.contractVersion].filter(Boolean).join(" ").toLowerCase().includes(query);
        });
    }, [agentFilter, customers, tasks, projectFilter, projectItems, searchQuery, agents, customerFilter]);

    const recurringTasks = filteredTasks.filter(isRecurring);
    const filteredRecurringDefinitions = recurringDefinitions.filter((definition) => {
        if (projectFilter !== "All Projects" && definition.projectId !== projectFilter) return false;
        if (customerFilter !== "All Customers") {
            const project = projectItems.find((p) => p.id === definition.projectId);
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
    
    // "Needs attention" view computations
    const now = Date.now();
    const STALE_INBOX_MS = 60 * 60 * 1000; // 1 hour unclaimed
    const OVERDUE_REVIEW_MS = 24 * 60 * 60 * 1000; // 24 hours in review
    const staleInboxTasks = byState.inbox.filter((task) => {
        const created = task.createdAt ? new Date(task.createdAt).getTime() : 0;
        return now - created > STALE_INBOX_MS;
    });
    const overdueReviewTasks = byState.review.filter((task) => {
        const updated = task.updatedAt ? new Date(task.updatedAt).getTime() : 0;
        return now - updated > OVERDUE_REVIEW_MS;
    });
    const attentionTasks = [...exceptionTasks, ...staleInboxTasks, ...overdueReviewTasks];
    const byState_attention = {
        deadLetter: exceptionTasks.filter((task) => task.state === "dead_letter"),
        failed: exceptionTasks.filter((task) => task.state === "failed"),
        staleInbox: staleInboxTasks,
        overdueReview: overdueReviewTasks,
    };
    const reviewCounts = {
        approval_needed: byState.review.filter((task) => reviewBucket(task, isBlocked(task, filteredTasks)) === "approval_needed").length,
        waiting_review: byState.review.filter((task) => reviewBucket(task, isBlocked(task, filteredTasks)) === "waiting_review").length,
        blocked: byState.review.filter((task) => reviewBucket(task, isBlocked(task, filteredTasks)) === "blocked").length,
        ready_to_close: byState.review.filter((task) => reviewBucket(task, isBlocked(task, filteredTasks)) === "ready_to_close").length,
    };

    const getProjectName = (projectId: string) => projectItems.find((project) => project.id === projectId)?.goal || "Unknown Project";
    const getCustomerName = (projectId: string) => {
        const project = projectItems.find((item) => item.id === projectId);
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
            toast.error("Failed to send. Please try again.");
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

    const handleSetPriority = async (task: any, priority: number) => {
        try {
            const res = await fetch(`/api/tasks/${task.id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ priority }),
            });
            if (res.ok) {
                const data = await res.json();
                setTasks((prev) => prev.map((t) => t.id === data.task.id ? data.task : t));
                if (selectedTask?.id === task.id) setSelectedTask(data.task);
                toast.success(`Priority set to ${getPriorityInfo(priority).label}`);
            }
        } catch { toast.error("Failed to update priority"); }
    };

    const handleSetState = async (task: any, state: string) => {
        try {
            const res = await fetch(`/api/tasks/${task.id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ state }),
            });
            if (res.ok) {
                const data = await res.json();
                setTasks((prev) => prev.map((t) => t.id === data.task.id ? data.task : t));
                if (selectedTask?.id === task.id) setSelectedTask(data.task);
                toast.success(`Moved to ${humanizeKey(state)}`);
            }
        } catch { toast.error("Failed to update state"); }
    };

    const selectedProject = projectFilter === "All Projects" ? null : projectItems.find((project) => project.id === projectFilter) || null;
    const customerOptions = [
        { value: "All Customers", label: "All Customers", description: `${customers.length} customers` },
        ...customers.map((customer) => ({ value: customer.id, label: customer.name, description: `${projectItems.filter((project) => project.customerId === customer.id).length} projects` })),
    ];
    const projectOptions = [
        { value: "All Projects", label: "All Projects", description: `${visibleProjects.length} active projects` },
        ...visibleProjects
            .filter((project) => customerFilter === "All Customers" ? true : project.customerId === customerFilter)
            .map((project) => {
                const customerName = customers.find((customer) => customer.id === project.customerId)?.name || "No customer";
                const isFinished = project.status === "completed" || project.status === "killed";
                return {
                    value: project.id,
                    label: isFinished ? `${project.goal} (${humanizeKey(project.status)})` : project.goal,
                    description: project.status === "active" ? customerName : `${customerName} — ${humanizeKey(project.status)}`,
                };
            }),
    ];
    const agentOptions = [
        { value: "All Agents", label: "All Agents", description: `${agents.length} agents` },
        ...agents.map((agent) => ({ value: agent.id, label: agent.name, description: agent.role || "Agent" })),
    ];

    const openCreateProject = () => {
        setMutationError(null);
        setEditingProject(null);
        setProjectForm({ ...emptyProjectForm, customerId: customerFilter === "All Customers" ? "" : customerFilter });
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
            const res = await fetch(endpoint, {
                method: projectDialogMode === "edit" ? "PATCH" : "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(projectForm),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "Project save failed");
            setProjectItems((prev) => projectDialogMode === "edit"
                ? prev.map((project) => project.id === data.project.id ? data.project : project)
                : [data.project, ...prev]);
            if (projectDialogMode !== "edit") setProjectFilter(data.project.id);
            setProjectDialogMode(null);
            router.refresh();
        } catch (error) {
            setMutationError(error instanceof Error ? error.message : "Project save failed");
        } finally {
            setIsMutating(false);
        }
    };

    const archiveProject = async (project: any) => {
        if (confirmingArchive !== project.id) {
            setConfirmingArchive(project.id);
            setTimeout(() => setConfirmingArchive(null), 4000);
            return;
        }
        setConfirmingArchive(null);
        setIsMutating(true);
        setMutationError(null);
        try {
            const res = await fetch(`/api/projects/${project.id}`, { method: "DELETE" });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "Project archive failed");
            setProjectItems((prev) => prev.filter((item) => item.id !== project.id));
            setTasks((prev) => prev.filter((task) => task.projectId !== project.id));
            if (projectFilter === project.id) setProjectFilter("All Projects");
            toast.success("Project archived.");
            router.refresh();
        } catch (error) {
            setMutationError(error instanceof Error ? error.message : "Project archive failed");
        } finally {
            setIsMutating(false);
        }
    };

    const completeProject = async (project: any) => {
        setIsMutating(true);
        setMutationError(null);
        setCompletingProject(project.id);
        try {
            const res = await fetch(`/api/projects/${project.id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ status: "completed" }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "Failed to complete project");
            setProjectItems((prev) => prev.map((p) => p.id === project.id ? { ...p, status: "completed" } : p));
            toast.success(`Project "${project.name || project.goal}" completed.`);
            router.refresh();
        } catch (error) {
            setMutationError(error instanceof Error ? error.message : "Failed to complete project");
            toast.error("Failed to complete project.");
        } finally {
            setIsMutating(false);
            setCompletingProject(null);
        }
    };

    const reopenProject = async (project: any) => {
        setIsMutating(true);
        setMutationError(null);
        try {
            const res = await fetch(`/api/projects/${project.id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ status: "active" }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "Failed to reopen project");
            setProjectItems((prev) => prev.map((p) => p.id === project.id ? { ...p, status: "active" } : p));
            toast.success(`Project "${project.name || project.goal}" reopened.`);
            router.refresh();
        } catch (error) {
            setMutationError(error instanceof Error ? error.message : "Failed to reopen project");
        } finally {
            setIsMutating(false);
        }
    };

    const openCreateTask = () => {
        setMutationError(null);
        setTaskForm({ ...emptyTaskForm, projectId: selectedProject?.id || "" });
        setTaskDialogMode("create");
    };

    const openEditTask = (task: any) => {
        const input = taskInput(task);
        setMutationError(null);
        setTaskForm({
            projectId: task.projectId,
            title: getTaskTitle(task),
            taskType: task.taskType || "manual_task",
            description: getTaskDescription(task) || "",
            goal: typeof input.goal === "string" ? input.goal : "",
            priority: task.priority || 0,
            assignedAgentId: task.assignedAgentId || "",
            state: task.state || "inbox",
            acceptanceCriteria: Array.isArray(input.acceptanceCriteria) ? input.acceptanceCriteria.join("\n") : "",
            definitionOfDone: typeof input.definitionOfDone === "string" ? input.definitionOfDone : "",
            deliverables: Array.isArray(input.deliverables) ? input.deliverables.join("\n") : "",
            proofRequired: Boolean(task.proofRequired),
            humanApprovalRequired: Boolean(task.humanApprovalRequired),
        });
        setTaskDialogMode("edit");
    };

    const submitTask = async () => {
        if (!taskForm.projectId || !taskForm.title.trim()) return;
        setIsMutating(true);
        setMutationError(null);
        try {
            const inputJson = {
                title: taskForm.title,
                description: taskForm.description,
                goal: taskForm.goal || taskForm.title,
                acceptanceCriteria: String(taskForm.acceptanceCriteria || "").split("\n").map((line) => line.trim()).filter(Boolean),
                definitionOfDone: taskForm.definitionOfDone,
                deliverables: String(taskForm.deliverables || "").split("\n").map((line) => line.trim()).filter(Boolean),
            };
            const isEdit = taskDialogMode === "edit" && selectedTask;
            const res = await fetch(isEdit ? `/api/tasks/${selectedTask.id}` : "/api/tasks", {
                method: isEdit ? "PATCH" : "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    ...taskForm,
                    priority: Number(taskForm.priority) || 0,
                    inputJson,
                }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "Task save failed");
            setTasks((prev) => isEdit ? prev.map((task) => task.id === data.task.id ? data.task : task) : [data.task, ...prev]);
            if (isEdit) setSelectedTask(data.task);
            setTaskDialogMode(null);
            router.refresh();
        } catch (error) {
            setMutationError(error instanceof Error ? error.message : "Task save failed");
        } finally {
            setIsMutating(false);
        }
    };

    const updateTaskPatch = async (task: any, patch: Record<string, unknown>) => {
        setIsMutating(true);
        setMutationError(null);
        try {
            const res = await fetch(`/api/tasks/${task.id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(patch),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "Task update failed");
            setTasks((prev) => prev.map((item) => item.id === data.task.id ? data.task : item));
            setSelectedTask(data.task);
            router.refresh();
        } catch (error) {
            setMutationError(error instanceof Error ? error.message : "Task update failed");
        } finally {
            setIsMutating(false);
        }
    };

    const moveTaskToState = async (task: any, newState: string) => {
        if (task.state === newState) return;
        setIsMutating(true);
        setMutationError(null);
        try {
            const res = await fetch(`/api/tasks/${task.id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ state: newState }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "Task move failed");
            setTasks((prev) => prev.map((item) => item.id === data.task.id ? data.task : item));
            if (selectedTask?.id === data.task.id) setSelectedTask(data.task);
            toast.success(`Moved to ${humanizeKey(newState)}`);
        } catch (error) {
            setMutationError(error instanceof Error ? error.message : "Task move failed");
        } finally {
            setIsMutating(false);
        }
    };

    const handleDragStart = (event: DragStartEvent) => {
        setDraggingTask(tasks.find((task) => task.id === event.active.id) || null);
    };

    const handleDragEnd = (event: DragEndEvent) => {
        setDraggingTask(null);
        const { active, over } = event;
        if (!over) return;
        const newState = COLUMN_DROP_STATE[String(over.id)];
        if (!newState) return;
        const task = tasks.find((item) => item.id === active.id);
        if (task) void moveTaskToState(task, newState);
    };

    const archiveTask = async (task: any) => {
        if (confirmingArchive !== task.id) {
            setConfirmingArchive(task.id);
            setTimeout(() => setConfirmingArchive(null), 4000);
            return;
        }
        setConfirmingArchive(null);
        setIsMutating(true);
        setMutationError(null);
        try {
            const res = await fetch(`/api/tasks/${task.id}`, { method: "DELETE" });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "Task archive failed");
            setTasks((prev) => prev.filter((item) => item.id !== task.id));
            setSelectedTask(null);
            toast.success("Task archived.");
            router.refresh();
        } catch (error) {
            setMutationError(error instanceof Error ? error.message : "Task archive failed");
        } finally {
            setIsMutating(false);
        }
    };

    const blockedCount = filteredTasks.filter((task) => isBlocked(task, filteredTasks)).length;
    const currentProjectMemory = projectMemoryItems.filter((item) => projectFilter === "All Projects" ? true : item.projectId === projectFilter).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return (
        <div className="relative mx-auto flex h-full max-w-[1800px] flex-col space-y-6 animate-in fade-in duration-500">
            <PageHeader
                eyebrow="Projects"
                title="Projects Board"
                description="Track work from to-do to done across all your projects."
                actions={
                    <>
                        {companyRole !== "viewer" && <button onClick={openCreateProject} className="flex h-9 sm:h-10 cursor-pointer items-center gap-1.5 sm:gap-2 rounded-full border border-zinc-700 bg-zinc-900/80 px-3 sm:px-4 text-xs sm:text-sm font-semibold text-zinc-100 transition-colors hover:border-zinc-600 hover:bg-zinc-800"><IconPlus className="h-3.5 w-3.5 sm:h-4 sm:w-4" />Project</button>}
                        <button onClick={openCreateTask} disabled={!selectedProject} className="flex h-9 sm:h-10 cursor-pointer items-center gap-1.5 sm:gap-2 rounded-full border border-emerald-400/40 bg-emerald-400/10 px-3 sm:px-4 text-xs sm:text-sm font-semibold text-emerald-100 transition-colors hover:bg-emerald-400/15 disabled:cursor-not-allowed disabled:border-zinc-800 disabled:bg-zinc-900/80 disabled:text-zinc-600"><IconPlus className="h-3.5 w-3.5 sm:h-4 sm:w-4" />Task</button>
                        <button
                            onClick={() => setHideCompletedProjects((v) => !v)}
                            className={cn(
                                "flex h-9 sm:h-10 cursor-pointer items-center gap-1.5 sm:gap-2 rounded-full border px-3 sm:px-4 text-xs sm:text-sm font-semibold transition-colors",
                                hideCompletedProjects
                                    ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-100 hover:bg-cyan-400/15"
                                    : "border-zinc-700 bg-zinc-900/80 text-zinc-100 hover:border-zinc-600 hover:bg-zinc-800"
                            )}
                            title={hideCompletedProjects ? "Showing only active projects" : "Showing all projects"}
                        >
                            <IconArchive className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                            {hideCompletedProjects ? "Active" : "All"}
                        </button>
                        {projectFilter !== "All Projects" && <button onClick={() => setIsContextOpen(true)} className="flex h-9 sm:h-10 cursor-pointer items-center gap-1.5 sm:gap-2 rounded-full border border-cyan-400/40 bg-cyan-400/10 px-3 sm:px-4 text-xs sm:text-sm font-semibold text-cyan-100 transition-colors hover:bg-cyan-400/15"><IconBrain className="h-3.5 w-3.5 sm:h-4 sm:w-4" />Notes</button>}
                    </>
                }
            />
            <div className="emperor-panel rounded-2xl p-3 sm:p-4">
                <div className="grid gap-3">
                    <div className="flex flex-wrap items-center gap-3">
                        <div className="relative min-w-[260px] flex-1">
                        <IconSearch className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
                            <input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Search tasks..." className="w-full rounded-xl border border-zinc-800 bg-zinc-950/80 py-2 pl-9 pr-4 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400/60" />
                        </div>
                        <SearchableSelect
                            value={customerFilter}
                            options={customerOptions}
                            placeholder="All Customers"
                            searchPlaceholder="Search customers..."
                            onChange={(nextCustomerId) => {
                                setCustomerFilter(nextCustomerId);
                                if (
                                    projectFilter !== "All Projects" &&
                                    nextCustomerId !== "All Customers" &&
                                    projectItems.find((project) => project.id === projectFilter)?.customerId !== nextCustomerId
                                ) {
                                    setProjectFilter("All Projects");
                                }
                            }}
                        />
                        <SearchableSelect
                            value={projectFilter}
                            options={projectOptions}
                            placeholder="All Projects"
                            searchPlaceholder="Search projects..."
                            onChange={setProjectFilter}
                            className="min-w-[280px]"
                        />
                    </div>
                    <details className="rounded-xl border border-zinc-800/80 bg-zinc-950/70 px-3 py-2">
                        <summary className="cursor-pointer text-xs font-semibold uppercase tracking-[0.18em] text-zinc-400">
                            Advanced filters and project actions
                        </summary>
                        <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-zinc-800/80 pt-3">
                            <SearchableSelect
                                value={agentFilter}
                                options={agentOptions}
                                placeholder="All Agents"
                                searchPlaceholder="Search agents..."
                                onChange={setAgentFilter}
                            />
                            <div className="inline-flex items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-950/80 px-3 py-2 text-xs text-zinc-400">
                                <IconFilter className="h-4 w-4" />
                                Filter by agent
                            </div>
                            {selectedProject && (
                                <span className={cn("rounded-xl border px-3 py-2 text-xs font-semibold uppercase tracking-wider", PROJECT_STATUS_STYLES[selectedProject.status] || PROJECT_STATUS_STYLES.active)}>
                                    Project status: {humanizeKey(selectedProject.status)}
                                </span>
                            )}
                            {selectedProject && (
                                <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                        <button className="cursor-pointer rounded-xl border border-zinc-800 bg-zinc-950/80 p-2.5 text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-zinc-100"><IconDots className="h-4 w-4" /></button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="end" className="w-48 border-zinc-800 bg-zinc-950 text-zinc-100">
                                        <DropdownMenuItem onClick={() => openEditProject(selectedProject)}><IconPencil className="mr-2 h-4 w-4" />Edit project</DropdownMenuItem>
                                        {selectedProject.status !== "completed" && selectedProject.status !== "killed" && (
                                            <DropdownMenuItem onClick={() => void completeProject(selectedProject)} disabled={completingProject === selectedProject.id}>
                                                <IconCircleCheck className="mr-2 h-4 w-4 text-emerald-400" />
                                                {completingProject === selectedProject.id ? "Completing..." : "Complete project"}
                                            </DropdownMenuItem>
                                        )}
                                        {(selectedProject.status === "completed" || selectedProject.status === "killed") && (
                                            <DropdownMenuItem onClick={() => void reopenProject(selectedProject)}>
                                                <IconRotate className="mr-2 h-4 w-4 text-amber-400" />Reopen project
                                            </DropdownMenuItem>
                                        )}
                                        <DropdownMenuItem variant="destructive" onClick={() => void archiveProject(selectedProject)}><IconTrash className="mr-2 h-4 w-4" />{confirmingArchive === selectedProject ? "Click again to confirm" : "Archive project"}</DropdownMenuItem>
                                    </DropdownMenuContent>
                                </DropdownMenu>
                            )}
                        </div>
                    </details>
                </div>
            </div>
            {mutationError && <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">{mutationError}</div>}

            <div className="grid gap-2 sm:gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
                <MetricCard label="To do" value={byState.inbox.length} hint="Queued work" />
                <MetricCard label="In progress" value={byState.inProgress.length} hint="Active execution" accent="cyan" />
                <MetricCard label="Needs review" value={byState.review.length} hint="Needs your review" accent="amber" />
                <MetricCard label="Done" value={byState.done.length} hint="Closed work" accent="emerald" />
                <MetricCard label="Recurring" value={filteredRecurringDefinitions.length} hint="Recurring task definitions" accent="slate" />
            </div>

            {(blockedCount > 0 || exceptionTasks.length > 0) && (
                <div className="flex flex-wrap items-center gap-3 rounded-xl border border-zinc-800/80 bg-zinc-900/40 px-4 py-3 text-sm">
                    {blockedCount > 0 && <span className="rounded-lg border border-rose-500/20 bg-rose-500/10 px-3 py-1.5 text-rose-300"><IconAlertTriangle className="mr-1 inline h-4 w-4" />{blockedCount} blocked tasks</span>}
                    {exceptionTasks.length > 0 && <span className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-zinc-300">{exceptionTasks.length} failed tasks</span>}
                </div>
            )}

            {/* Needs Attention toggle */}
            <div className="flex items-center gap-3">
                <button
                    type="button"
                    onClick={() => setShowAttentionOnly((prev) => !prev)}
                    className={`inline-flex items-center gap-2 rounded-xl border px-4 py-2 text-sm font-medium transition-colors ${showAttentionOnly ? "border-rose-400/40 bg-rose-400/10 text-rose-200" : "border-zinc-800 bg-zinc-950/80 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"}`}
                >
                    <IconAlertTriangle className="h-4 w-4" />
                    {showAttentionOnly ? "Showing: Needs Attention" : "Show Needs Attention"}
                    {attentionTasks.length > 0 && (
                        <span className={`rounded-full px-2 py-0.5 text-xs ${showAttentionOnly ? "bg-rose-400/20 text-rose-200" : "bg-zinc-800 text-zinc-400"}`}>{attentionTasks.length}</span>
                    )}
                </button>
                {showAttentionOnly && (
                    <span className="text-xs text-zinc-500">
                        Dead-lettered · failed · stale inbox (&gt;1h) · overdue review (&gt;24h)
                    </span>
                )}
            </div>

            <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
                <div className="flex min-h-0 flex-1 overflow-hidden -mx-3 sm:-mx-5 lg:-mx-8 px-3 sm:px-5 lg:px-8">
                    <div className="flex-1 overflow-x-auto pb-4">
                        <div className="flex h-full min-w-max gap-6">
                            {showAttentionOnly ? (
                                <>
                                    <BoardColumn droppableId="dead_letter" title="Dead-lettered" count={byState_attention.deadLetter.length} tone="rose" icon={IconCircleX}>
                                        {byState_attention.deadLetter.length === 0 ? <EmptyColumnHint>No dead-lettered tasks.</EmptyColumnHint> : byState_attention.deadLetter
                                            .sort((a, b) => (b.priority || 0) - (a.priority || 0))
                                            .map((task) => <TaskCard key={task.id} task={task} project={getProjectName(task.projectId)} customer={getCustomerName(task.projectId)} agent={getAgentName(task.assignedAgentId)} onClick={() => setSelectedTask(task)} onSetPriority={(p) => handleSetPriority(task, p)} onSetState={(s) => handleSetState(task, s)} />)}
                                    </BoardColumn>
                                    <BoardColumn droppableId="failed" title="Failed" count={byState_attention.failed.length} tone="rose" icon={IconCircleX}>
                                        {byState_attention.failed.length === 0 ? <EmptyColumnHint>No failed tasks.</EmptyColumnHint> : byState_attention.failed
                                            .sort((a, b) => (b.priority || 0) - (a.priority || 0))
                                            .map((task) => <TaskCard key={task.id} task={task} project={getProjectName(task.projectId)} customer={getCustomerName(task.projectId)} agent={getAgentName(task.assignedAgentId)} onClick={() => setSelectedTask(task)} onSetPriority={(p) => handleSetPriority(task, p)} onSetState={(s) => handleSetState(task, s)} />)}
                                    </BoardColumn>
                                    <BoardColumn droppableId="stale_inbox" title="Stale inbox (>1h)" count={byState_attention.staleInbox.length} tone="amber" icon={IconInbox}>
                                        {byState_attention.staleInbox.length === 0 ? <EmptyColumnHint>No stale inbox tasks.</EmptyColumnHint> : byState_attention.staleInbox
                                            .sort((a, b) => (b.priority || 0) - (a.priority || 0))
                                            .map((task) => <TaskCard key={task.id} task={task} project={getProjectName(task.projectId)} customer={getCustomerName(task.projectId)} agent={getAgentName(task.assignedAgentId)} onClick={() => setSelectedTask(task)} onSetPriority={(p) => handleSetPriority(task, p)} onSetState={(s) => handleSetState(task, s)} />)}
                                    </BoardColumn>
                                    <BoardColumn droppableId="overdue_review" title="Overdue review (>24h)" count={byState_attention.overdueReview.length} tone="amber" icon={IconAlertTriangle}>
                                        {byState_attention.overdueReview.length === 0 ? <EmptyColumnHint>No overdue reviews.</EmptyColumnHint> : byState_attention.overdueReview
                                            .sort((a, b) => (b.priority || 0) - (a.priority || 0))
                                            .map((task) => <TaskCard key={task.id} task={task} project={getProjectName(task.projectId)} customer={getCustomerName(task.projectId)} agent={getAgentName(task.assignedAgentId)} onClick={() => setSelectedTask(task)} onSetPriority={(p) => handleSetPriority(task, p)} onSetState={(s) => handleSetState(task, s)} />)}
                                    </BoardColumn>
                                </>
                            ) : (
                                <>
                            <BoardColumn droppableId="inbox" title="Inbox" count={byState.inbox.length} tone="zinc" icon={IconInbox}>
                                {byState.inbox.map((task) => <TaskCard key={task.id} task={task} project={getProjectName(task.projectId)} customer={getCustomerName(task.projectId)} agent={getAgentName(task.assignedAgentId)} blocked={isBlocked(task, filteredTasks)} onClick={() => setSelectedTask(task)} onSetPriority={(p) => handleSetPriority(task, p)} onSetState={(s) => handleSetState(task, s)} />)}
                            </BoardColumn>
                            <BoardColumn droppableId="in_progress" title="In Progress" count={byState.inProgress.length} tone="cyan" icon={CirclePulseIcon}>
                                {byState.inProgress.map((task) => <TaskCard key={task.id} task={task} project={getProjectName(task.projectId)} customer={getCustomerName(task.projectId)} agent={getAgentName(task.assignedAgentId)} blocked={isBlocked(task, filteredTasks)} active onClick={() => setSelectedTask(task)} onSetPriority={(p) => handleSetPriority(task, p)} onSetState={(s) => handleSetState(task, s)} />)}
                            </BoardColumn>
                            <BoardColumn droppableId="review" title="Review" count={byState.review.length} tone="amber" icon={IconCircleCheck}>
                                <div className="mb-3 grid grid-cols-2 gap-2 text-[10px] font-semibold uppercase tracking-[0.16em]">
                                    <BucketBadge label="Approval needed" count={reviewCounts.approval_needed} />
                                    <BucketBadge label="Waiting review" count={reviewCounts.waiting_review} />
                                    <BucketBadge label="Blocked" count={reviewCounts.blocked} tone="rose" />
                                    <BucketBadge label="Ready to close" count={reviewCounts.ready_to_close} tone="emerald" />
                                </div>
                                {byState.review.slice().sort((a, b) => Number(isBlocked(a, filteredTasks)) - Number(isBlocked(b, filteredTasks))).map((task) => <TaskCard key={task.id} task={task} project={getProjectName(task.projectId)} customer={getCustomerName(task.projectId)} agent={getAgentName(task.assignedAgentId)} blocked={isBlocked(task, filteredTasks)} reviewBucket={reviewBucket(task, isBlocked(task, filteredTasks))} review onClick={() => setSelectedTask(task)} onSetPriority={(p) => handleSetPriority(task, p)} onSetState={(s) => handleSetState(task, s)} />)}
                            </BoardColumn>
                            <BoardColumn droppableId="done" title="Done" count={byState.done.length} tone="emerald" icon={IconCircleCheck}>
                                {byState.done.map((task) => <TaskCard key={task.id} task={task} project={getProjectName(task.projectId)} customer={getCustomerName(task.projectId)} agent={getAgentName(task.assignedAgentId)} done onClick={() => setSelectedTask(task)} onSetPriority={(p) => handleSetPriority(task, p)} onSetState={(s) => handleSetState(task, s)} />)}
                            </BoardColumn>
                            <BoardColumn droppableId="exceptions" title="Exceptions" count={exceptionTasks.length} tone="rose" icon={IconCircleX}>
                                {exceptionTasks.length === 0 ? <EmptyColumnHint>No failed or dead-lettered tasks.</EmptyColumnHint> : exceptionTasks.map((task) => <TaskCard key={task.id} task={task} project={getProjectName(task.projectId)} customer={getCustomerName(task.projectId)} agent={getAgentName(task.assignedAgentId)} onClick={() => setSelectedTask(task)} onSetPriority={(p) => handleSetPriority(task, p)} onSetState={(s) => handleSetState(task, s)} />)}
                            </BoardColumn>
                            {(filteredRecurringDefinitions.length > 0 || recurringTasks.length > 0) && <BoardColumn title="Recurring" count={filteredRecurringDefinitions.length + recurringTasks.length} tone="slate" icon={IconRepeat}>
                                {filteredRecurringDefinitions.map((definition) => <RecurringCard key={definition.id} definition={definition} project={getProjectName(definition.projectId)} customer={getCustomerName(definition.projectId)} agent={getAgentName(definition.createdByAgentId)} />)}
                                {recurringTasks.map((task) => <TaskCard key={task.id} task={task} project={getProjectName(task.projectId)} customer={getCustomerName(task.projectId)} agent={getAgentName(task.assignedAgentId)} recurring blocked={isBlocked(task, filteredTasks)} onClick={() => setSelectedTask(task)} onSetPriority={(p) => handleSetPriority(task, p)} onSetState={(s) => handleSetState(task, s)} />)}
                            </BoardColumn>}
                                </>
                            )}
                        </div>
                    </div>
                </div>
                <DragOverlay>
                    {draggingTask ? <TaskCard task={draggingTask} project={getProjectName(draggingTask.projectId)} customer={getCustomerName(draggingTask.projectId)} agent={getAgentName(draggingTask.assignedAgentId)} onClick={() => {}} overlay /> : null}
                </DragOverlay>
            </DndContext>

            {selectedTask && (
                <div className="absolute right-0 top-0 z-50 flex h-full w-full sm:w-[60%] lg:w-[42%] flex-col rounded-xl border-l border-zinc-800 bg-zinc-900/95 p-4 sm:p-6 shadow-2xl backdrop-blur-3xl animate-in slide-in-from-right-8 duration-300">
                    <div className="mb-8 flex items-center justify-between">
                        <div className="rounded border border-zinc-800 bg-zinc-950 px-2 py-1 font-mono text-xs text-zinc-500">TASK-{selectedTask.id.substring(0, 8).toUpperCase()}</div>
                        <button onClick={() => setSelectedTask(null)} className="cursor-pointer rounded p-1 text-zinc-500 transition-colors hover:bg-zinc-800"><IconChevronRight className="h-5 w-5" /></button>
                    </div>
                    <div className="min-h-0 flex-1 space-y-6 overflow-y-auto pr-2">
                        <div>
                            <h2 className="text-xl font-medium text-zinc-100">{getTaskTitle(selectedTask)}</h2>
                            <p className="mt-1 text-xs font-medium uppercase tracking-[0.16em] text-zinc-600">{getWorkTypeLabel(selectedTask.taskType)}</p>
                            <p className="mt-2 text-sm text-zinc-500">Project: {getProjectName(selectedTask.projectId)}</p>
                            <p className="text-sm text-zinc-500">Customer: {getCustomerName(selectedTask.projectId)}</p>
                        </div>
                        <div className="flex flex-wrap gap-2 text-sm">
                            <span className="rounded bg-zinc-800 px-2.5 py-1 font-medium text-zinc-300">{humanizeKey(selectedTask.state)}</span>
                            <span className="rounded bg-zinc-800 px-2.5 py-1 text-zinc-400">Assigned: {getAgentName(selectedTask.assignedAgentId)}</span>
                            {isBlocked(selectedTask, filteredTasks) && <span className="rounded bg-rose-500/20 px-2.5 py-1 text-rose-400">Blocked</span>}
                            {isRecurring(selectedTask) && <span className="rounded bg-cyan-500/20 px-2.5 py-1 text-cyan-300">Recurring</span>}
                        </div>
                        <div className="grid gap-3 rounded-lg border border-zinc-800 bg-zinc-950 p-3 sm:grid-cols-2">
                            <label className="space-y-1 text-xs text-zinc-500">
                                <span>State</span>
                                <select value={selectedTask.state} disabled={isMutating} onChange={(event) => void updateTaskPatch(selectedTask, { state: event.target.value })} className="h-9 w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 text-sm text-zinc-200 outline-none focus:border-cyan-400">
                                    {taskStates.map((state) => <option key={state} value={state}>{humanizeKey(state)}</option>)}
                                </select>
                            </label>
                            <label className="space-y-1 text-xs text-zinc-500">
                                <span>Assignee</span>
                                <select value={selectedTask.assignedAgentId || ""} disabled={isMutating} onChange={(event) => void updateTaskPatch(selectedTask, { assignedAgentId: event.target.value || null })} className="h-9 w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 text-sm text-zinc-200 outline-none focus:border-cyan-400">
                                    <option value="">Unassigned</option>
                                    {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
                                </select>
                            </label>
                            <label className="space-y-1 text-xs text-zinc-500">
                                <span>Priority</span>
                                <select value={selectedTask.priority || 0} disabled={isMutating} onChange={(event) => void updateTaskPatch(selectedTask, { priority: Number(event.target.value) || 0 })} className="h-9 w-full rounded-md border border-zinc-800 bg-zinc-900 px-2 text-sm text-zinc-200 outline-none focus:border-cyan-400">
                                    {PRIORITY_OPTIONS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                                </select>
                            </label>
                            <div className="flex items-end gap-2">
                                <button onClick={() => openEditTask(selectedTask)} className="flex h-9 flex-1 cursor-pointer items-center justify-center gap-2 rounded-md border border-zinc-700 bg-zinc-900 text-sm font-medium text-zinc-200 transition-colors hover:bg-zinc-800"><IconPencil className="h-4 w-4" />Edit</button>
                                <button onClick={() => void archiveTask(selectedTask)} className="flex h-9 flex-1 cursor-pointer items-center justify-center gap-2 rounded-md border border-rose-500/30 bg-rose-500/10 text-sm font-medium text-rose-200 transition-colors hover:bg-rose-500/20"><IconTrash className="h-4 w-4" />{confirmingArchive === selectedTask?.id ? "Click again to confirm" : "Archive"}</button>
                            </div>
                        </div>
                        {selectedTask.inputJson && Object.keys(selectedTask.inputJson).length > 0 && <Section title="Task Instructions"><div className="whitespace-pre-wrap rounded-lg border border-zinc-800 bg-zinc-950 p-4 font-mono text-xs leading-relaxed text-zinc-300 shadow-inner">{getTaskDescription(selectedTask) || JSON.stringify(selectedTask.inputJson, null, 2)}</div></Section>}
                        <Section title="Storage & Reports">{artifactsForTask(selectedTask.id).length === 0 ? <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-4 font-mono text-xs text-zinc-400">No files submitted yet.</div> : artifactsForTask(selectedTask.id).map((artifact) => <div key={artifact.id} className="rounded-lg border border-zinc-800 bg-zinc-950 p-4"><div className="mb-2 flex items-center justify-between gap-3 text-xs text-zinc-500"><div className="flex min-w-0 items-center gap-2"><span className="font-mono">{artifact.title || artifact.originalFilename || artifact.kind}</span><span className="rounded border border-zinc-800 bg-zinc-900 px-1.5 py-0.5 uppercase tracking-wider text-[10px]">{getArtifactClassLabel(artifact.artifactClass || artifact.kind)}</span>{artifact.isCanonical && <span className="rounded border border-emerald-500/20 bg-emerald-500/10 px-1.5 py-0.5 uppercase tracking-wider text-[10px] text-emerald-300">canonical</span>}</div><span>{artifact.contentType}</span></div><div className="mb-2 flex items-center gap-2 text-[10px] uppercase tracking-wider text-zinc-600"><span>{getArtifactImportanceLabel(artifact.importance || "operational")}</span>{artifact.originalFilename && <span className="truncate">{artifact.originalFilename}</span>}</div>{artifact.contentText ? <MarkdownRenderer content={artifact.contentText} className="text-xs" /> : <div className="text-xs text-zinc-500">Stored securely. Use Storage to preview or download.</div>}</div>)}</Section>
                        <Section title="Timeline">{getTaskEvents(selectedTask.id).length === 0 ? <><TimelineEvent time={new Date(selectedTask.createdAt).toLocaleTimeString()} desc="Task created and entered inbox." /><>{selectedTask.state !== "queued" && selectedTask.state !== "inbox" && <TimelineEvent time={new Date(selectedTask.updatedAt).toLocaleTimeString()} desc={`Status changed to ${selectedTask.state}`} />}</></> : getTaskEvents(selectedTask.id).map((event) => <TimelineEvent key={event.id} time={new Date(event.createdAt).toLocaleTimeString()} desc={event.eventType === "task_note" && event.payloadJson?.note ? `Note: ${event.payloadJson.note}` : event.eventType === "task_handoff" && event.payloadJson?.handoff ? `Handoff from ${event.payloadJson.handoff.fromRole} to ${event.payloadJson.handoff.toRole}` : event.eventType.startsWith("task_") ? `Status changed to ${event.eventType.replace("task_", "")}` : `Event: ${event.eventType}`} isNote={event.eventType === "task_note" || event.eventType === "task_handoff"} />)}</Section>
                    </div>
                    <div className="mt-auto border-t border-zinc-800 pt-6">
                        <div className="mb-2 text-xs font-medium text-zinc-500">Add Task Note / Send to Agent</div>
                        <div className="flex overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950 focus-within:ring-1 focus-within:ring-cyan-500">
                            <textarea value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Agent instructions or private notes..." className="h-20 flex-1 resize-none bg-transparent p-3 text-sm text-zinc-200 outline-none" />
                            <div className="flex flex-col justify-end border-l border-zinc-800 bg-zinc-950/70 p-2">
                                <button onClick={handleSendComment} disabled={!comment.trim()} className="cursor-pointer rounded-md bg-cyan-400/10 p-2 text-cyan-100 transition-colors hover:bg-cyan-400/15 disabled:cursor-not-allowed disabled:opacity-50"><IconSend className="h-4 w-4" /></button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {isContextOpen && (
                <div className="absolute right-0 top-0 z-50 flex h-full w-[45%] flex-col rounded-l-2xl border-l border-zinc-800 bg-zinc-900/98 shadow-2xl backdrop-blur-3xl animate-in slide-in-from-right-10 duration-300">
                    <div className="flex items-center justify-between rounded-tl-2xl border-b border-zinc-800 bg-zinc-950/50 p-6">
                        <div className="flex items-center space-x-3">
                            <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-cyan-500/30 bg-cyan-400/10 text-cyan-500 shadow-inner"><IconBrain className="h-6 w-6" /></div>
                            <div><h2 className="text-lg font-semibold uppercase tracking-tight text-zinc-100">Project notes</h2><p className="text-xs font-medium text-zinc-500">Notes and context for this project</p></div>
                        </div>
                        <button onClick={() => setIsContextOpen(false)} className="cursor-pointer rounded-lg p-2 text-zinc-500 transition-colors hover:bg-zinc-800"><IconChevronRight className="h-6 w-6" /></button>
                    </div>
                    <div className="custom-scrollbar flex-1 space-y-8 overflow-y-auto p-6">
                        <div className="space-y-3">
                            <label className="pl-1 text-[10px] font-bold uppercase tracking-widest text-zinc-500">Add a note</label>
                            <div className="relative">
                                <textarea value={newContext} onChange={(event) => setNewContext(event.target.value)} placeholder="Enter new goals, findings, or critical context for the agents..." className="h-32 w-full resize-none rounded-xl border border-zinc-800 bg-zinc-950 p-4 text-sm text-zinc-200 outline-none shadow-inner focus:ring-1 focus:ring-cyan-400" />
                                <button onClick={handleAddProjectContext} disabled={!newContext.trim() || isSubmittingContext} className="absolute bottom-3 right-3 flex cursor-pointer items-center space-x-2 rounded-lg bg-cyan-400/10 px-4 py-2 text-xs font-bold text-cyan-100 transition-colors hover:bg-cyan-400/15 disabled:cursor-not-allowed disabled:opacity-50">{isSubmittingContext ? <div className="h-3 w-3 animate-spin rounded-full border-2 border-white/30 border-t-white" /> : <IconPlus className="h-3 w-3" />}<span>Save</span></button>
                            </div>
                        </div>
                        <div className="space-y-4">
                            <h3 className="flex items-center space-x-2 pl-1 text-[10px] font-bold uppercase tracking-widest text-zinc-500"><IconHistory className="h-3 w-3" /><span>Notes</span></h3>
                            {currentProjectMemory.length === 0 ? <div className="flex flex-col items-center justify-center space-y-2 rounded-2xl border border-dashed border-zinc-800 p-8 text-center opacity-50"><IconBrain className="mb-2 h-8 w-8 text-zinc-700" /><p className="text-sm text-zinc-500">No notes yet for this project.</p><p className="text-xs text-zinc-600">Add notes to share context across tasks.</p></div> : <div className="space-y-4">{currentProjectMemory.map((memory) => <div key={memory.id} className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950/50 shadow-sm transition-colors hover:border-zinc-700"><div className="flex items-center justify-between border-b border-zinc-800/50 bg-zinc-900/20 p-4"><div className="flex items-center space-x-2"><div className="h-1.5 w-1.5 rounded-full bg-cyan-500 shadow-[0_0_8px_rgba(34,211,238,0.45)]" /><span className="font-mono text-[10px] text-zinc-500">{new Date(memory.createdAt).toLocaleString()}</span></div>{memory.createdByAgentId && <div className="rounded-full border border-cyan-500/20 bg-cyan-500/10 px-2 py-0.5 text-[9px] font-bold uppercase tracking-tighter text-cyan-400">By {getAgentName(memory.createdByAgentId)}</div>}</div><div className="p-5"><MarkdownRenderer content={memory.content} className="text-sm prose-invert" /></div>{Array.isArray(memory.tags) && memory.tags.length > 0 && <div className="flex flex-wrap gap-2 px-5 pb-4">{memory.tags.map((tag: string) => <span key={tag} className="rounded border border-zinc-800 bg-zinc-900 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-widest text-zinc-500">{tag}</span>)}</div>}</div>)}</div>}
                        </div>
                    </div>
                </div>
            )}

            <Dialog open={Boolean(projectDialogMode)} onOpenChange={(open) => !open && setProjectDialogMode(null)}>
                <DialogContent className="max-h-[90vh] overflow-y-auto border-zinc-800 bg-zinc-950 text-zinc-100 sm:max-w-2xl">
                    <DialogHeader>
                        <DialogTitle>{projectDialogMode === "edit" ? "Edit Project" : "New Project"}</DialogTitle>
                    </DialogHeader>
                    <div className="grid gap-4">
                        <label className="space-y-1 text-sm text-zinc-400">
                            <span>Goal</span>
                            <textarea value={projectForm.goal} onChange={(event) => setProjectForm((prev: any) => ({ ...prev, goal: event.target.value }))} className="h-24 w-full rounded-lg border border-zinc-800 bg-zinc-900 p-3 text-sm text-zinc-100 outline-none focus:border-cyan-400" />
                        </label>
                        <div className="grid gap-3 sm:grid-cols-2">
                            <label className="space-y-1 text-sm text-zinc-400">
                                <span>Customer</span>
                                <select value={projectForm.customerId} onChange={(event) => setProjectForm((prev: any) => ({ ...prev, customerId: event.target.value }))} className="h-10 w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-100 outline-none focus:border-cyan-400">
                                    <option value="">No customer</option>
                                    {customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}
                                </select>
                            </label>
                            <label className="space-y-1 text-sm text-zinc-400">
                                <span>Lead agent</span>
                                <select value={projectForm.leadAgentId} onChange={(event) => setProjectForm((prev: any) => ({ ...prev, leadAgentId: event.target.value }))} className="h-10 w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-100 outline-none focus:border-cyan-400">
                                    <option value="">No lead</option>
                                    {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
                                </select>
                            </label>
                            <label className="space-y-1 text-sm text-zinc-400">
                                <span>Status</span>
                                <select value={projectForm.status} onChange={(event) => setProjectForm((prev: any) => ({ ...prev, status: event.target.value }))} className="h-10 w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-100 outline-none focus:border-cyan-400">
                                    {projectStatuses.map((status) => <option key={status} value={status}>{status}</option>)}
                                </select>
                            </label>
                            <label className="space-y-1 text-sm text-zinc-400">
                                <span>Max active agents</span>
                                <input type="number" min={1} value={projectForm.maxActiveAgents} onChange={(event) => setProjectForm((prev: any) => ({ ...prev, maxActiveAgents: Number(event.target.value) || 1 }))} className="h-10 w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-100 outline-none focus:border-cyan-400" />
                            </label>
                        </div>
                        <div className="grid gap-2 rounded-lg border border-zinc-800 bg-zinc-950/70 p-3 text-sm text-zinc-300 sm:grid-cols-2">
                            <CheckboxRow label="Require approval for done" checked={projectForm.requireApprovalForDone} onChange={(checked) => setProjectForm((prev: any) => ({ ...prev, requireApprovalForDone: checked }))} />
                            <CheckboxRow label="Require review before done" checked={projectForm.requireReviewBeforeDone} onChange={(checked) => setProjectForm((prev: any) => ({ ...prev, requireReviewBeforeDone: checked }))} />
                            <CheckboxRow label="Require review comments" checked={projectForm.commentRequiredForReview} onChange={(checked) => setProjectForm((prev: any) => ({ ...prev, commentRequiredForReview: checked }))} />
                            <CheckboxRow label="Block while approval pending" checked={projectForm.blockStatusChangesWithPendingApproval} onChange={(checked) => setProjectForm((prev: any) => ({ ...prev, blockStatusChangesWithPendingApproval: checked }))} />
                            <CheckboxRow label="Only lead can change status" checked={projectForm.onlyLeadCanChangeStatus} onChange={(checked) => setProjectForm((prev: any) => ({ ...prev, onlyLeadCanChangeStatus: checked }))} />
                        </div>
                        <div className="flex justify-end gap-2">
                            <button onClick={() => setProjectDialogMode(null)} className="cursor-pointer rounded-lg border border-zinc-800 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-900">Cancel</button>
                            <button onClick={() => void submitProject()} disabled={isMutating || !projectForm.goal.trim()} className="cursor-pointer rounded-lg bg-cyan-400/10 px-4 py-2 text-sm font-semibold text-cyan-100 hover:bg-cyan-400/15 disabled:cursor-not-allowed disabled:opacity-50">{isMutating ? "Saving..." : "Save project"}</button>
                        </div>
                    </div>
                </DialogContent>
            </Dialog>

            <Dialog open={Boolean(taskDialogMode)} onOpenChange={(open) => !open && setTaskDialogMode(null)}>
                <DialogContent className="max-h-[90vh] overflow-y-auto border-zinc-800 bg-zinc-950 text-zinc-100 sm:max-w-2xl">
                    <DialogHeader>
                        <DialogTitle>{taskDialogMode === "edit" ? "Edit Task" : "New Task"}</DialogTitle>
                    </DialogHeader>
                    <div className="grid gap-4">
                        <div className="grid gap-3 sm:grid-cols-2">
                            <label className="space-y-1 text-sm text-zinc-400">
                                <span>Project</span>
                                <select value={taskForm.projectId} disabled={taskDialogMode === "edit"} onChange={(event) => setTaskForm((prev: any) => ({ ...prev, projectId: event.target.value }))} className="h-10 w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-100 outline-none focus:border-cyan-400 disabled:opacity-60">
                                    <option value="">Select project</option>
                                    {projectItems.map((project) => <option key={project.id} value={project.id}>{project.goal}</option>)}
                                </select>
                            </label>
                            <label className="space-y-1 text-sm text-zinc-400">
                                <span>Work type</span>
                                <select value={taskForm.taskType} disabled={taskDialogMode === "edit"} onChange={(event) => setTaskForm((prev: any) => ({ ...prev, taskType: event.target.value }))} className="h-10 w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-100 outline-none focus:border-cyan-400 disabled:opacity-60">
                                    {workTypeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                                </select>
                            </label>
                        </div>
                        <label className="space-y-1 text-sm text-zinc-400">
                            <span>Title</span>
                            <input value={taskForm.title} onChange={(event) => setTaskForm((prev: any) => ({ ...prev, title: event.target.value }))} className="h-10 w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-100 outline-none focus:border-cyan-400" />
                        </label>
                        <label className="space-y-1 text-sm text-zinc-400">
                            <span>Description</span>
                            <textarea value={taskForm.description} onChange={(event) => setTaskForm((prev: any) => ({ ...prev, description: event.target.value }))} className="h-24 w-full rounded-lg border border-zinc-800 bg-zinc-900 p-3 text-sm text-zinc-100 outline-none focus:border-cyan-400" />
                        </label>
                        <div className="grid gap-3 sm:grid-cols-3">
                            <label className="space-y-1 text-sm text-zinc-400">
                                <span>State</span>
                                <select value={taskForm.state} onChange={(event) => setTaskForm((prev: any) => ({ ...prev, state: event.target.value }))} className="h-10 w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-100 outline-none focus:border-cyan-400">
                                    {taskStates.map((state) => <option key={state} value={state}>{humanizeKey(state)}</option>)}
                                </select>
                            </label>
                            <label className="space-y-1 text-sm text-zinc-400">
                                <span>Assignee</span>
                                <select value={taskForm.assignedAgentId} onChange={(event) => setTaskForm((prev: any) => ({ ...prev, assignedAgentId: event.target.value }))} className="h-10 w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-100 outline-none focus:border-cyan-400">
                                    <option value="">Unassigned</option>
                                    {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
                                </select>
                            </label>
                            <label className="space-y-1 text-sm text-zinc-400">
                                <span>Priority</span>
                                <select value={taskForm.priority} onChange={(event) => setTaskForm((prev: any) => ({ ...prev, priority: Number(event.target.value) || 0 }))} className="h-10 w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-100 outline-none focus:border-cyan-400">
                                    {PRIORITY_OPTIONS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                                </select>
                            </label>
                        </div>
                        <label className="space-y-1 text-sm text-zinc-400">
                            <span>Acceptance criteria</span>
                            <textarea value={taskForm.acceptanceCriteria} onChange={(event) => setTaskForm((prev: any) => ({ ...prev, acceptanceCriteria: event.target.value }))} placeholder="One criterion per line" className="h-20 w-full rounded-lg border border-zinc-800 bg-zinc-900 p-3 text-sm text-zinc-100 outline-none focus:border-cyan-400" />
                        </label>
                        <div className="grid gap-3 sm:grid-cols-2">
                            <label className="space-y-1 text-sm text-zinc-400">
                                <span>Definition of done</span>
                                <textarea value={taskForm.definitionOfDone} onChange={(event) => setTaskForm((prev: any) => ({ ...prev, definitionOfDone: event.target.value }))} className="h-20 w-full rounded-lg border border-zinc-800 bg-zinc-900 p-3 text-sm text-zinc-100 outline-none focus:border-cyan-400" />
                            </label>
                            <label className="space-y-1 text-sm text-zinc-400">
                                <span>Deliverables</span>
                                <textarea value={taskForm.deliverables} onChange={(event) => setTaskForm((prev: any) => ({ ...prev, deliverables: event.target.value }))} placeholder="One deliverable per line" className="h-20 w-full rounded-lg border border-zinc-800 bg-zinc-900 p-3 text-sm text-zinc-100 outline-none focus:border-cyan-400" />
                            </label>
                        </div>
                        <div className="flex flex-wrap gap-4 rounded-lg border border-zinc-800 bg-zinc-950/70 p-3 text-sm text-zinc-300">
                            <CheckboxRow label="Proof required" checked={taskForm.proofRequired} onChange={(checked) => setTaskForm((prev: any) => ({ ...prev, proofRequired: checked }))} />
                            <CheckboxRow label="Human approval required" checked={taskForm.humanApprovalRequired} onChange={(checked) => setTaskForm((prev: any) => ({ ...prev, humanApprovalRequired: checked }))} />
                        </div>
                        <div className="flex justify-end gap-2">
                            <button onClick={() => setTaskDialogMode(null)} className="cursor-pointer rounded-lg border border-zinc-800 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-900">Cancel</button>
                            <button onClick={() => void submitTask()} disabled={isMutating || !taskForm.projectId || !taskForm.title.trim()} className="cursor-pointer rounded-lg bg-cyan-400/10 px-4 py-2 text-sm font-semibold text-cyan-100 hover:bg-cyan-400/15 disabled:cursor-not-allowed disabled:opacity-50">{isMutating ? "Saving..." : "Save task"}</button>
                        </div>
                    </div>
                </DialogContent>
            </Dialog>
        </div>
    );
}

function MetricCard({ label, value, hint, accent = "slate" }: { label: string; value: number; hint: string; accent?: "slate" | "cyan" | "amber" | "emerald" }) {
    const tone = { slate: "border-zinc-800 bg-zinc-950/50", cyan: "border-cyan-500/20 bg-cyan-500/10", amber: "border-amber-500/20 bg-amber-500/10", emerald: "border-emerald-500/20 bg-emerald-500/10" }[accent];
    return <div className={cn("rounded-xl border p-4", tone)}><div className="text-[10px] font-bold uppercase tracking-[0.18em] text-zinc-500">{label}</div><div className="mt-2 text-2xl font-semibold text-zinc-100">{value}</div><div className="mt-1 text-xs text-zinc-500">{hint}</div></div>;
}

function BucketBadge({ label, count, tone = "zinc" }: { label: string; count: number; tone?: "zinc" | "rose" | "emerald" }) {
    const toneClass = { zinc: "border-zinc-800 bg-zinc-950 text-zinc-300", rose: "border-rose-500/20 bg-rose-500/10 text-rose-300", emerald: "border-emerald-500/20 bg-emerald-500/10 text-emerald-300" }[tone];
    return <div className={cn("rounded-lg border px-2 py-1.5", toneClass)}><div className="flex items-center justify-between gap-2"><span>{label}</span><span className="font-mono text-[10px]">{count}</span></div></div>;
}

function EmptyColumnHint({ children }: { children: ReactNode }) {
    return <div className="rounded-lg border border-dashed border-zinc-800 p-4 text-center text-xs text-zinc-600">{children}</div>;
}

function BoardColumn({ title, count, tone, icon: Icon, children, droppableId }: { title: string; count: number; tone: "zinc" | "cyan" | "amber" | "emerald" | "slate" | "rose"; icon: any; children: ReactNode; droppableId?: string }) {
    const toneClass = { zinc: "border-zinc-800/60 bg-zinc-900/30", cyan: "border-cyan-500/20 bg-cyan-500/5", amber: "border-amber-500/20 bg-amber-500/5", emerald: "border-emerald-500/20 bg-emerald-500/5", slate: "border-zinc-800/60 bg-zinc-900/30", rose: "border-rose-500/20 bg-rose-500/5" }[tone];
    const { setNodeRef, isOver } = useDroppable({ id: droppableId || `__nodrop-${title}`, disabled: !droppableId });
    return (
        <div ref={setNodeRef} className={cn("flex h-full w-80 flex-col rounded-xl border p-3 transition-colors", toneClass, isOver && "border-cyan-400/60 bg-cyan-400/10 ring-1 ring-cyan-400/40")}>
            <div className="mb-4 flex items-center justify-between px-1"><div className="flex items-center space-x-2"><Icon className="h-4 w-4 text-zinc-500" /><h3 className="text-sm font-medium text-zinc-300">{title}</h3></div><span className="rounded bg-zinc-800/50 px-2 py-0.5 font-mono text-xs text-zinc-500">{count}</span></div>
            <div className="custom-scrollbar flex-1 space-y-3 overflow-y-auto pr-1 pb-2">{children}</div>
        </div>
    );
}

function TaskCard({ task, project, customer, agent, blocked, reviewBucket, recurring, active, review, done, onClick, onSetPriority, onSetState, onAssign, overlay }: { task: any; project: string; customer: string; agent: string; blocked?: boolean; reviewBucket?: string; recurring?: boolean; active?: boolean; review?: boolean; done?: boolean; onClick: () => void; onSetPriority?: (priority: number) => void; onSetState?: (state: string) => void; onAssign?: (agentId: string) => void; overlay?: boolean }) {
    const draggable = useDraggable({ id: task.id, disabled: overlay });
    const priorityInfo = getPriorityInfo(task.priority || 0);
    const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
    const border = blocked ? "border-rose-500/50" : recurring ? "border-cyan-500/40" : active ? "border-cyan-500/50" : review ? "border-amber-500/50" : done ? "border-emerald-500/40" : "border-zinc-800";
    const style = overlay ? undefined : { transform: CSS.Translate.toString(draggable.transform) };
    
    const handleContextMenu = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setContextMenu({ x: e.clientX, y: e.clientY });
    };
    
    useEffect(() => {
        if (!contextMenu) return;
        const close = () => setContextMenu(null);
        window.addEventListener("click", close);
        return () => window.removeEventListener("click", close);
    }, [contextMenu]);
    return (
        <button
            ref={overlay ? undefined : draggable.setNodeRef}
            style={style}
            {...(overlay ? {} : draggable.listeners)}
            {...(overlay ? {} : draggable.attributes)}
            onClick={onClick}
            onContextMenu={handleContextMenu}
            className={cn(
                "w-full cursor-grab touch-none rounded-lg border bg-zinc-950 p-4 text-left transition-colors hover:bg-zinc-900/80 active:cursor-grabbing",
                border,
                draggable.isDragging && "opacity-40",
                overlay && "cursor-grabbing shadow-2xl shadow-black/50",
            )}
        >
            <div className="mb-3 flex items-start justify-between gap-3"><div className="space-y-2"><div className="flex items-center gap-2"><div className="h-1.5 w-1.5 rounded-full bg-cyan-500/40" /><span className="font-mono text-[10px] text-zinc-500">TASK-{task.id.substring(0, 8).toUpperCase()}</span></div><h4 className="text-sm font-medium leading-snug text-zinc-200">{getTaskTitle(task)}</h4><div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-600">{getWorkTypeLabel(task.taskType)}</div></div><span className={cn("rounded border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider", task.priority >= 75 ? "bg-rose-500/10 text-rose-400 border-rose-500/20" : task.priority >= 50 ? "bg-amber-500/10 text-amber-400 border-amber-500/20" : task.priority >= 25 ? "bg-slate-500/10 text-slate-400 border-slate-500/20" : "bg-zinc-500/10 text-zinc-500 border-zinc-700")}>{priorityInfo.label}</span></div>
            <div className="mb-3 flex flex-wrap gap-2 text-[10px] font-medium"><span className="rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-zinc-400">{project}</span><span className="rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-zinc-500">{customer}</span><span className="rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-zinc-500">{agent}</span></div>
            <div className="flex flex-wrap gap-2 text-[10px] font-semibold uppercase tracking-[0.16em]"><span className="rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-zinc-500">{humanizeKey(task.state)}</span>{blocked && <span className="rounded border border-rose-500/20 bg-rose-500/10 px-2 py-1 text-rose-300">Blocked</span>}{reviewBucket && <span className="rounded border border-amber-500/20 bg-amber-500/10 px-2 py-1 text-amber-300">{humanizeKey(reviewBucket)}</span>}{recurring && <span className="rounded border border-cyan-500/20 bg-cyan-500/10 px-2 py-1 text-cyan-300">Recurring</span>}</div>
            {(task.processingStartedAt || task.templateVersion) && <div className="mt-3 flex items-center justify-between text-[10px] text-zinc-600"><span>{task.templateVersion ? `v${task.templateVersion}` : "Standard"}</span>{task.processingStartedAt && <span>Processing since {new Date(task.processingStartedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>}</div>}
            
            {/* Right-click context menu */}
            {contextMenu && (
                <div
                    className="fixed z-[100] min-w-[180px] rounded-xl border border-zinc-700 bg-zinc-900 p-1.5 shadow-2xl shadow-black/60 backdrop-blur-xl animate-in fade-in zoom-in-95 duration-150"
                    style={{ left: contextMenu.x, top: contextMenu.y }}
                    role="menu"
                >
                    <div className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Set Priority</div>
                    {PRIORITY_OPTIONS.filter(p => p.value > 0).map((p) => (
                        <div
                            key={p.value}
                            role="menuitem"
                            onClick={(e) => { e.stopPropagation(); onSetPriority?.(p.value); setContextMenu(null); }}
                            className={`flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-zinc-800 ${task.priority >= p.value ? 'text-zinc-100' : 'text-zinc-400'}`}
                        >
                            <span className={`h-2 w-2 rounded-full ${task.priority >= p.value ? 'bg-current' : 'border border-current opacity-30'}`} />
                            {p.label}
                        </div>
                    ))}
                    <div className="my-1 border-t border-zinc-800" />
                    <div className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Move to</div>
                    {["inbox", "in_progress", "review", "done"].filter(s => s !== task.state).map((state) => (
                        <div
                            key={state}
                            role="menuitem"
                            onClick={(e) => { e.stopPropagation(); onSetState?.(state); setContextMenu(null); }}
                            className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
                        >
                            {humanizeKey(state)}
                        </div>
                    ))}
                </div>
            )}
        </button>
    );
}

function RecurringCard({ definition, project, customer, agent }: { definition: any; project: string; customer: string; agent: string }) {
    return <div className="w-full rounded-lg border border-cyan-500/30 bg-zinc-950 p-4 text-left"><div className="mb-3 flex items-start justify-between gap-3"><div className="space-y-2"><div className="flex items-center gap-2"><div className="h-1.5 w-1.5 rounded-full bg-cyan-500/40" /><span className="font-mono text-[10px] text-zinc-500">RECUR-{definition.id.substring(0, 8).toUpperCase()}</span></div><h4 className="text-sm font-medium leading-snug text-zinc-200">{definition.name}</h4></div><span className={cn("rounded border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider", definition.active ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-300" : "border-zinc-800 bg-zinc-900 text-zinc-500")}>{definition.active ? "ACTIVE" : "PAUSED"}</span></div><div className="mb-3 flex flex-wrap gap-2 text-[10px] font-medium"><span className="rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-zinc-400">{project}</span><span className="rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-zinc-500">{customer}</span><span className="rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-zinc-500">{agent}</span></div><div className="flex flex-wrap gap-2 text-[10px] font-semibold uppercase tracking-[0.16em]"><span className="rounded border border-cyan-500/20 bg-cyan-500/10 px-2 py-1 text-cyan-300">{getWorkTypeLabel(definition.taskType)}</span>{definition.cronExpression && <span className="rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-zinc-500">{definition.cronExpression}</span>}{definition.nextRunAt && <span className="rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-zinc-500">Next {new Date(definition.nextRunAt).toLocaleString()}</span>}</div></div>;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
    return <div className="space-y-3"><h3 className="text-sm font-medium text-zinc-300">{title}</h3>{children}</div>;
}

function TimelineEvent({ time, desc, isNote }: { time: string; desc: string; isNote?: boolean }) {
    return <div className="flex items-start space-x-3"><div className={cn("mt-1 h-2 w-2 rounded-full", isNote ? "bg-cyan-500" : "bg-zinc-600")} /><div className="flex-1"><div className="text-[10px] text-zinc-500">{time}</div><div className="text-sm text-zinc-300">{desc}</div></div></div>;
}

function CheckboxRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
    return (
        <label className="flex items-center gap-2">
            <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="h-4 w-4 rounded border-zinc-700 bg-zinc-900 text-cyan-600 focus:ring-cyan-400" />
            <span>{label}</span>
        </label>
    );
}

function CirclePulseIcon({ className }: { className?: string }) {
    return <div className={cn("h-4 w-4 rounded-full border border-cyan-400/70", className)} />;
}
