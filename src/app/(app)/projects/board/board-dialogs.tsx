"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PROJECT_NAME_MAX, projectTitle } from "@/lib/project-title";
import { sentenceCase } from "@/lib/project-board-model";
import { cn } from "@/lib/utils";
import { PRIORITY_CHOICES } from "./task-card";

export const WORK_TYPE_OPTIONS = [
    { value: "manual_task", label: "Standard task" },
    { value: "research", label: "Research" },
    { value: "implementation", label: "Implementation" },
    { value: "review", label: "Review" },
    { value: "outreach", label: "Outreach" },
    { value: "reporting", label: "Reporting" },
];

export function workTypeLabel(value: unknown) {
    return WORK_TYPE_OPTIONS.find((option) => option.value === value)?.label || sentenceCase(value) || "Standard task";
}

const TASK_STATES = ["inbox", "in_progress", "review", "blocked", "done", "failed", "dead_letter"];
const PROJECT_STATUSES = ["active", "paused", "completed", "killed"];

const field = "w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-100 outline-none transition-colors focus:border-cyan-400 disabled:opacity-60";
const labelClass = "grid gap-1.5 text-sm text-zinc-400";

function CheckboxRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
    return (
        <label className="flex min-h-9 items-center gap-2">
            <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="h-4 w-4 rounded border-zinc-700 bg-zinc-900 accent-cyan-500" />
            <span>{label}</span>
        </label>
    );
}

function DialogActions({ onCancel, onSubmit, disabled, busy, label }: { onCancel: () => void; onSubmit: () => void; disabled: boolean; busy: boolean; label: string }) {
    return (
        <div className="flex justify-end gap-2">
            <button type="button" onClick={onCancel} className="min-h-10 rounded-lg border border-zinc-800 px-4 text-sm text-zinc-300 hover:bg-zinc-900">Cancel</button>
            <button type="button" onClick={onSubmit} disabled={disabled} className="min-h-10 rounded-lg bg-cyan-400/15 px-4 text-sm font-semibold text-cyan-50 hover:bg-cyan-400/25 disabled:cursor-not-allowed disabled:opacity-50">{busy ? "Saving..." : label}</button>
        </div>
    );
}

export function ProjectFormDialog({ mode, form, setForm, customers, agents, busy, error, onClose, onSubmit }: {
    mode: "create" | "edit" | null;
    form: any;
    setForm: (updater: (prev: any) => any) => void;
    customers: any[];
    agents: any[];
    busy: boolean;
    error: string | null;
    onClose: () => void;
    onSubmit: () => void;
}) {
    const length = String(form.goal || "").trim().length;
    const tooLong = length > PROJECT_NAME_MAX;
    return (
        <Dialog open={Boolean(mode)} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-h-[90vh] overflow-y-auto border-zinc-800 bg-zinc-950 text-zinc-100 sm:max-w-2xl">
                <DialogHeader>
                    <DialogTitle>{mode === "edit" ? "Edit project" : "New project"}</DialogTitle>
                    <DialogDescription className="text-zinc-500">A short name people recognise on the board. Context and goals go in project notes.</DialogDescription>
                </DialogHeader>
                <div className="grid gap-4">
                    <label className={labelClass}>
                        <span className="flex items-center justify-between"><span>Name</span><span className={cn("text-xs tabular-nums", tooLong ? "text-amber-300" : "text-zinc-500")}>{length}/{PROJECT_NAME_MAX}</span></span>
                        <input autoFocus value={form.goal} onChange={(event) => setForm((prev) => ({ ...prev, goal: event.target.value }))} placeholder="Harbor Dental website relaunch" className={cn(field, "h-10")} />
                        {tooLong && <span className="text-xs text-amber-200/90">Long names are cut on the board as “{projectTitle({ goal: form.goal }).name}”. Move the explanation to project notes.</span>}
                    </label>
                    <div className="grid gap-3 sm:grid-cols-2">
                        <label className={labelClass}>
                            <span>Customer</span>
                            <select value={form.customerId} onChange={(event) => setForm((prev) => ({ ...prev, customerId: event.target.value }))} className={cn(field, "h-10")}>
                                <option value="">No customer</option>
                                {customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}
                            </select>
                        </label>
                        <label className={labelClass}>
                            <span>Lead agent</span>
                            <select value={form.leadAgentId} onChange={(event) => setForm((prev) => ({ ...prev, leadAgentId: event.target.value }))} className={cn(field, "h-10")}>
                                <option value="">No lead</option>
                                {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
                            </select>
                        </label>
                        <label className={labelClass}>
                            <span>Status</span>
                            <select value={form.status} onChange={(event) => setForm((prev) => ({ ...prev, status: event.target.value }))} className={cn(field, "h-10")}>
                                {PROJECT_STATUSES.map((status) => <option key={status} value={status}>{sentenceCase(status)}</option>)}
                            </select>
                        </label>
                        <label className={labelClass}>
                            <span>Max active agents</span>
                            <input type="number" min={1} value={form.maxActiveAgents} onChange={(event) => setForm((prev) => ({ ...prev, maxActiveAgents: Number(event.target.value) || 1 }))} className={cn(field, "h-10")} />
                        </label>
                    </div>
                    <fieldset className="grid gap-1 rounded-lg border border-zinc-800 bg-zinc-950/70 p-3 text-sm text-zinc-300 sm:grid-cols-2">
                        <legend className="px-1 text-xs text-zinc-500">Rules</legend>
                        <CheckboxRow label="Require approval for done" checked={form.requireApprovalForDone} onChange={(checked) => setForm((prev) => ({ ...prev, requireApprovalForDone: checked }))} />
                        <CheckboxRow label="Require review before done" checked={form.requireReviewBeforeDone} onChange={(checked) => setForm((prev) => ({ ...prev, requireReviewBeforeDone: checked }))} />
                        <CheckboxRow label="Require review comments" checked={form.commentRequiredForReview} onChange={(checked) => setForm((prev) => ({ ...prev, commentRequiredForReview: checked }))} />
                        <CheckboxRow label="Block while approval pending" checked={form.blockStatusChangesWithPendingApproval} onChange={(checked) => setForm((prev) => ({ ...prev, blockStatusChangesWithPendingApproval: checked }))} />
                        <CheckboxRow label="Only lead can change status" checked={form.onlyLeadCanChangeStatus} onChange={(checked) => setForm((prev) => ({ ...prev, onlyLeadCanChangeStatus: checked }))} />
                    </fieldset>
                    {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}
                    <DialogActions onCancel={onClose} onSubmit={onSubmit} disabled={busy || !String(form.goal || "").trim()} busy={busy} label="Save project" />
                </div>
            </DialogContent>
        </Dialog>
    );
}

export function TaskFormDialog({ mode, form, setForm, projects, customers, agents, members, busy, error, onClose, onSubmit }: {
    mode: "create" | "edit" | null;
    form: any;
    setForm: (updater: (prev: any) => any) => void;
    projects: any[];
    customers: any[];
    agents: any[];
    members: any[];
    busy: boolean;
    error: string | null;
    onClose: () => void;
    onSubmit: () => void;
}) {
    const customerName = (id?: string | null) => customers.find((customer) => customer.id === id)?.name;
    const titleLength = String(form.title || "").trim().length;
    return (
        <Dialog open={Boolean(mode)} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-h-[90vh] overflow-y-auto border-zinc-800 bg-zinc-950 text-zinc-100 sm:max-w-2xl">
                <DialogHeader>
                    <DialogTitle>{mode === "edit" ? "Edit task" : "New task"}</DialogTitle>
                    <DialogDescription className="text-zinc-500">Title the outcome in a few words. Put context and what done looks like in the description.</DialogDescription>
                </DialogHeader>
                <div className="grid gap-4">
                    <div className="grid gap-3 sm:grid-cols-2">
                        <label className={labelClass}>
                            <span>Project</span>
                            <select value={form.projectId} disabled={mode === "edit"} onChange={(event) => setForm((prev) => ({ ...prev, projectId: event.target.value }))} className={cn(field, "h-10", !form.projectId && "text-zinc-400")}>
                                <option value="">Choose a project</option>
                                {projects.map((project) => {
                                    const customer = customerName(project.customerId);
                                    const name = projectTitle(project).name;
                                    return <option key={project.id} value={project.id}>{customer ? `${name} (${customer})` : name}</option>;
                                })}
                            </select>
                            {!form.projectId && mode === "create" && <span className="text-xs text-zinc-500">Every task lives in a project.</span>}
                        </label>
                        <label className={labelClass}>
                            <span>Work type</span>
                            <select value={form.taskType} disabled={mode === "edit"} onChange={(event) => setForm((prev) => ({ ...prev, taskType: event.target.value }))} className={cn(field, "h-10")}>
                                {WORK_TYPE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                            </select>
                        </label>
                    </div>
                    <label className={labelClass}>
                        <span className="flex items-center justify-between"><span>Title</span><span className={cn("text-xs tabular-nums", titleLength > 80 ? "text-amber-300" : "text-zinc-500")}>{titleLength}/80</span></span>
                        <input value={form.title} onChange={(event) => setForm((prev) => ({ ...prev, title: event.target.value }))} placeholder="Publish the spring menu landing page" className={cn(field, "h-10")} />
                    </label>
                    <label className={labelClass}>
                        <span>Description <span className="text-xs text-zinc-500">Markdown works</span></span>
                        <textarea value={form.description} onChange={(event) => setForm((prev) => ({ ...prev, description: event.target.value }))} rows={6} placeholder={"## Goal\n\n## Context\n\n## Done when\n- [ ] "} className={cn(field, "py-2.5 font-mono text-[13px] leading-relaxed")} />
                    </label>
                    <div className="grid gap-3 sm:grid-cols-3">
                        <label className={labelClass}>
                            <span>State</span>
                            <select value={form.state} onChange={(event) => setForm((prev) => ({ ...prev, state: event.target.value }))} className={cn(field, "h-10")}>
                                {TASK_STATES.map((state) => <option key={state} value={state}>{sentenceCase(state)}</option>)}
                            </select>
                        </label>
                        <label className={labelClass}>
                            <span>Owner</span>
                            <select value={form.assignee} onChange={(event) => setForm((prev) => ({ ...prev, assignee: event.target.value }))} className={cn(field, "h-10")}>
                                <option value="">No owner</option>
                                <optgroup label="People">{members.map((member) => <option key={member.id} value={`human:${member.id}`}>{member.displayName || member.email}</option>)}</optgroup>
                                <optgroup label="Agents">{agents.map((agent) => <option key={agent.id} value={`agent:${agent.id}`}>{agent.name}</option>)}</optgroup>
                            </select>
                        </label>
                        <label className={labelClass}>
                            <span>Priority</span>
                            <select value={form.priority} onChange={(event) => setForm((prev) => ({ ...prev, priority: Number(event.target.value) || 0 }))} className={cn(field, "h-10")}>
                                {PRIORITY_CHOICES.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
                            </select>
                        </label>
                    </div>
                    <details className="group rounded-lg border border-zinc-800 bg-zinc-950/70 px-3 py-2">
                        <summary className="cursor-pointer text-sm text-zinc-400">Acceptance criteria and deliverables</summary>
                        <div className="mt-3 grid gap-3">
                            <label className={labelClass}>
                                <span>Acceptance criteria</span>
                                <textarea value={form.acceptanceCriteria} onChange={(event) => setForm((prev) => ({ ...prev, acceptanceCriteria: event.target.value }))} placeholder="One per line" rows={3} className={cn(field, "py-2.5")} />
                            </label>
                            <div className="grid gap-3 sm:grid-cols-2">
                                <label className={labelClass}>
                                    <span>Definition of done</span>
                                    <textarea value={form.definitionOfDone} onChange={(event) => setForm((prev) => ({ ...prev, definitionOfDone: event.target.value }))} rows={3} className={cn(field, "py-2.5")} />
                                </label>
                                <label className={labelClass}>
                                    <span>Deliverables</span>
                                    <textarea value={form.deliverables} onChange={(event) => setForm((prev) => ({ ...prev, deliverables: event.target.value }))} placeholder="One per line" rows={3} className={cn(field, "py-2.5")} />
                                </label>
                            </div>
                        </div>
                    </details>
                    <div className="flex flex-wrap gap-x-5 rounded-lg border border-zinc-800 bg-zinc-950/70 px-3 py-1.5 text-sm text-zinc-300">
                        <CheckboxRow label="Proof required" checked={form.proofRequired} onChange={(checked) => setForm((prev) => ({ ...prev, proofRequired: checked }))} />
                        <CheckboxRow label="Human approval required" checked={form.humanApprovalRequired} onChange={(checked) => setForm((prev) => ({ ...prev, humanApprovalRequired: checked }))} />
                    </div>
                    {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}
                    <DialogActions onCancel={onClose} onSubmit={onSubmit} disabled={busy || !form.projectId || !String(form.title || "").trim()} busy={busy} label={mode === "edit" ? "Save task" : "Create task"} />
                </div>
            </DialogContent>
        </Dialog>
    );
}

export function ConfirmArchiveTaskDialog({ open, title, busy, error, onCancel, onConfirm }: { open: boolean; title: string; busy: boolean; error: string | null; onCancel: () => void; onConfirm: () => void }) {
    return (
        <Dialog open={open} onOpenChange={(next) => { if (!next && !busy) onCancel(); }}>
            <DialogContent className="bg-background text-foreground sm:max-w-md" showCloseButton={!busy}>
                <DialogHeader><DialogTitle>Archive task?</DialogTitle></DialogHeader>
                <p className="text-sm text-muted-foreground">“{title}” will disappear from the board. Its history and files stay saved.</p>
                {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
                <div className="flex justify-end gap-2">
                    <button disabled={busy} onClick={onCancel} className="min-h-11 rounded-md border px-4 text-sm">Cancel</button>
                    <button disabled={busy} onClick={onConfirm} className="min-h-11 rounded-md bg-destructive px-4 text-sm text-white disabled:opacity-50">{busy ? "Archiving…" : "Archive task"}</button>
                </div>
            </DialogContent>
        </Dialog>
    );
}

export function BlockTaskDialog({ open, title, reason, setReason, busy, error, onCancel, onConfirm }: { open: boolean; title: string; reason: string; setReason: (value: string) => void; busy: boolean; error: string | null; onCancel: () => void; onConfirm: () => void }) {
    return (
        <Dialog open={open} onOpenChange={(next) => { if (!next && !busy) onCancel(); }}>
            <DialogContent className="bg-background text-foreground sm:max-w-md" showCloseButton={!busy}>
                <DialogHeader><DialogTitle>Block task</DialogTitle></DialogHeader>
                <p className="text-sm text-muted-foreground">“{title}” will be held out of automatic stalled reminders until it is unblocked.</p>
                <label className="space-y-1 text-sm text-zinc-400">
                    <span>Why is it blocked?</span>
                    <textarea autoFocus value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Name the person or dependency you are waiting on" rows={3} className="w-full resize-y rounded-lg border border-zinc-800 bg-zinc-900 p-3 text-sm text-zinc-100 outline-none focus:border-cyan-400" />
                </label>
                {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
                <div className="flex justify-end gap-2">
                    <button disabled={busy} onClick={onCancel} className="min-h-11 rounded-md border px-4 text-sm">Cancel</button>
                    <button disabled={busy || !reason.trim()} onClick={onConfirm} className="min-h-11 rounded-md bg-rose-500/90 px-4 text-sm font-medium text-white hover:bg-rose-500 disabled:opacity-50">{busy ? "Blocking…" : "Block task"}</button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
