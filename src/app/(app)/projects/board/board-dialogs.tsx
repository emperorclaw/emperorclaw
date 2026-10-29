"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useTranslations } from "next-intl";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PROJECT_NAME_MAX, projectTitle } from "@/lib/project-title";
import { cn } from "@/lib/utils";
import { PRIORITY_CHOICES, PROJECT_STATUSES, TASK_STATES, WORK_TYPES, useBoardLabels } from "./board-labels";

/** The project the server creates for a first task: a stored name, not UI copy. */
const DEFAULT_PROJECT_NAME = "General";
/** The description scaffold a person fills in (Markdown headings). */
const DESCRIPTION_TEMPLATE = "## Goal\n\n## Context\n\n## Done when\n- [ ] ";

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

function DialogActions({ onCancel, onSubmit, disabled, busy, label, reason }: { onCancel: () => void; onSubmit: () => void; disabled: boolean; busy: boolean; label: string; reason?: string | null }) {
    // Say why the submit button is off (not while it is just saving).
    const tc = useTranslations("common");
    const why = disabled && !busy ? reason : null;
    return (
        <div className="flex flex-wrap items-center justify-end gap-2">
            {why && <span className="mr-auto text-xs text-muted-foreground">{why}</span>}
            <button type="button" onClick={onCancel} className="min-h-10 rounded-lg border border-zinc-800 px-4 text-sm text-zinc-300 hover:bg-zinc-900">{tc("cancel")}</button>
            <button type="button" onClick={onSubmit} disabled={disabled} title={why ?? undefined} className="min-h-10 rounded-lg bg-cyan-400/15 px-4 text-sm font-semibold text-cyan-50 hover:bg-cyan-400/25 disabled:cursor-not-allowed disabled:opacity-50">{busy ? tc("saving") : label}</button>
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
    const t = useTranslations("projects.form");
    const labels = useBoardLabels();
    const length = String(form.goal || "").trim().length;
    const tooLong = length > PROJECT_NAME_MAX;
    return (
        <Dialog open={Boolean(mode)} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-h-[90vh] overflow-y-auto border-zinc-800 bg-zinc-950 text-zinc-100 sm:max-w-2xl">
                <DialogHeader>
                    <DialogTitle>{mode === "edit" ? t("editTitle") : t("newTitle")}</DialogTitle>
                    <DialogDescription className="text-zinc-500">{t("description")}</DialogDescription>
                </DialogHeader>
                <div className="grid gap-4">
                    <label className={labelClass}>
                        <span className="flex items-center justify-between"><span>{t("name")}</span><span className={cn("text-xs tabular-nums", tooLong ? "text-amber-300" : "text-zinc-500")}>{length}/{PROJECT_NAME_MAX}</span></span>
                        <input autoFocus value={form.goal} onChange={(event) => setForm((prev) => ({ ...prev, goal: event.target.value }))} placeholder={t("namePlaceholder")} className={cn(field, "h-10")} />
                        {tooLong && <span className="text-xs text-amber-200/90">{t("tooLong", { name: projectTitle({ goal: form.goal }).name })}</span>}
                    </label>
                    <div className="grid gap-3 sm:grid-cols-2">
                        <label className={labelClass}>
                            <span>{t("customer")}</span>
                            <select value={form.customerId} onChange={(event) => setForm((prev) => ({ ...prev, customerId: event.target.value }))} className={cn(field, "h-10")}>
                                <option value="">{t("noCustomer")}</option>
                                {customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}
                            </select>
                        </label>
                        <label className={labelClass}>
                            <span>{t("leadAgent")}</span>
                            <select value={form.leadAgentId} onChange={(event) => setForm((prev) => ({ ...prev, leadAgentId: event.target.value }))} className={cn(field, "h-10")}>
                                <option value="">{t("noLead")}</option>
                                {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
                            </select>
                        </label>
                        <label className={labelClass}>
                            <span>{t("status")}</span>
                            <select value={form.status} onChange={(event) => setForm((prev) => ({ ...prev, status: event.target.value }))} className={cn(field, "h-10")}>
                                {PROJECT_STATUSES.map((status) => <option key={status} value={status}>{labels.projectStatus(status)}</option>)}
                            </select>
                        </label>
                        <label className={labelClass}>
                            <span>{t("maxActiveAgents")}</span>
                            <input type="number" min={1} value={form.maxActiveAgents} onChange={(event) => setForm((prev) => ({ ...prev, maxActiveAgents: Number(event.target.value) || 1 }))} className={cn(field, "h-10")} />
                        </label>
                    </div>
                    <fieldset className="grid gap-1 rounded-lg border border-zinc-800 bg-zinc-950/70 p-3 text-sm text-zinc-300 sm:grid-cols-2">
                        <legend className="px-1 text-xs text-zinc-500">{t("rules")}</legend>
                        <CheckboxRow label={t("requireApprovalForDone")} checked={form.requireApprovalForDone} onChange={(checked) => setForm((prev) => ({ ...prev, requireApprovalForDone: checked }))} />
                        <CheckboxRow label={t("requireReviewBeforeDone")} checked={form.requireReviewBeforeDone} onChange={(checked) => setForm((prev) => ({ ...prev, requireReviewBeforeDone: checked }))} />
                        <CheckboxRow label={t("commentRequiredForReview")} checked={form.commentRequiredForReview} onChange={(checked) => setForm((prev) => ({ ...prev, commentRequiredForReview: checked }))} />
                        <CheckboxRow label={t("blockWhileApprovalPending")} checked={form.blockStatusChangesWithPendingApproval} onChange={(checked) => setForm((prev) => ({ ...prev, blockStatusChangesWithPendingApproval: checked }))} />
                        <CheckboxRow label={t("onlyLeadCanChangeStatus")} checked={form.onlyLeadCanChangeStatus} onChange={(checked) => setForm((prev) => ({ ...prev, onlyLeadCanChangeStatus: checked }))} />
                    </fieldset>
                    {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}
                    <DialogActions onCancel={onClose} onSubmit={onSubmit} disabled={busy || !String(form.goal || "").trim()} busy={busy} label={t("save")} reason={t("nameRequired")} />
                </div>
            </DialogContent>
        </Dialog>
    );
}

export function TaskFormDialog({ mode, form, setForm, projects, defaultProject = false, customers, agents, members, busy, error, onClose, onSubmit }: {
    mode: "create" | "edit" | null;
    form: any;
    setForm: (updater: (prev: any) => any) => void;
    projects: any[];
    /** No projects exist yet: the task goes into a new "General" project. */
    defaultProject?: boolean;
    customers: any[];
    agents: any[];
    members: any[];
    busy: boolean;
    error: string | null;
    onClose: () => void;
    onSubmit: () => void;
}) {
    const t = useTranslations("tasks.form");
    const labels = useBoardLabels();
    const customerName = (id?: string | null) => customers.find((customer) => customer.id === id)?.name;
    const titleLength = String(form.title || "").trim().length;
    return (
        <Dialog open={Boolean(mode)} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-h-[90vh] overflow-y-auto border-zinc-800 bg-zinc-950 text-zinc-100 sm:max-w-2xl">
                <DialogHeader>
                    <DialogTitle>{mode === "edit" ? t("editTitle") : t("newTitle")}</DialogTitle>
                    <DialogDescription className="text-zinc-500">{t("description")}</DialogDescription>
                </DialogHeader>
                <div className="grid gap-4">
                    <div className="grid gap-3 sm:grid-cols-2">
                        {defaultProject ? (
                            <div className={labelClass}>
                                <span>{t("project")}</span>
                                <p className="flex h-10 items-center rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 text-sm text-zinc-300">{DEFAULT_PROJECT_NAME}</p>
                                <span className="text-xs text-zinc-500">{t("defaultProjectHint", { name: DEFAULT_PROJECT_NAME })}</span>
                            </div>
                        ) : (
                        <label className={labelClass}>
                            <span>{t("project")}</span>
                            <select value={form.projectId} disabled={mode === "edit"} onChange={(event) => setForm((prev) => ({ ...prev, projectId: event.target.value }))} className={cn(field, "h-10", !form.projectId && "text-zinc-400")}>
                                <option value="">{t("chooseProject")}</option>
                                {projects.map((project) => {
                                    const customer = customerName(project.customerId);
                                    const name = projectTitle(project).name;
                                    return <option key={project.id} value={project.id}>{customer ? `${name} (${customer})` : name}</option>;
                                })}
                            </select>
                            {!form.projectId && mode === "create" && <span className="text-xs text-zinc-500">{t("projectRequired")}</span>}
                        </label>
                        )}
                        <label className={labelClass}>
                            <span>{t("workType")}</span>
                            <select value={form.taskType} disabled={mode === "edit"} onChange={(event) => setForm((prev) => ({ ...prev, taskType: event.target.value }))} className={cn(field, "h-10")}>
                                {WORK_TYPES.map((value) => <option key={value} value={value}>{labels.workType(value)}</option>)}
                            </select>
                        </label>
                    </div>
                    <label className={labelClass}>
                        <span className="flex items-center justify-between"><span>{t("title")}</span><span className={cn("text-xs tabular-nums", titleLength > 80 ? "text-amber-300" : "text-zinc-500")}>{titleLength}/80</span></span>
                        <input value={form.title} onChange={(event) => setForm((prev) => ({ ...prev, title: event.target.value }))} placeholder={t("titlePlaceholder")} className={cn(field, "h-10")} />
                    </label>
                    <label className={labelClass}>
                        <span>{t("descriptionLabel")} <span className="text-xs text-zinc-500">{t("markdownWorks")}</span></span>
                        <textarea value={form.description} onChange={(event) => setForm((prev) => ({ ...prev, description: event.target.value }))} rows={6} placeholder={DESCRIPTION_TEMPLATE} className={cn(field, "py-2.5 font-mono text-[13px] leading-relaxed")} />
                    </label>
                    <div className="grid gap-3 sm:grid-cols-3">
                        <label className={labelClass}>
                            <span>{t("state")}</span>
                            <select value={form.state} onChange={(event) => setForm((prev) => ({ ...prev, state: event.target.value }))} className={cn(field, "h-10")}>
                                {TASK_STATES.map((state) => <option key={state} value={state}>{labels.state(state)}</option>)}
                            </select>
                        </label>
                        <label className={labelClass}>
                            <span>{t("owner")}</span>
                            <select value={form.assignee} onChange={(event) => setForm((prev) => ({ ...prev, assignee: event.target.value }))} className={cn(field, "h-10")}>
                                <option value="">{t("noOwner")}</option>
                                <optgroup label={t("people")}>{members.map((member) => <option key={member.id} value={`human:${member.id}`}>{member.displayName || member.email}</option>)}</optgroup>
                                <optgroup label={t("agents")}>{agents.map((agent) => <option key={agent.id} value={`agent:${agent.id}`}>{agent.name}</option>)}</optgroup>
                            </select>
                        </label>
                        <label className={labelClass}>
                            <span>{t("priority")}</span>
                            <select value={form.priority} onChange={(event) => setForm((prev) => ({ ...prev, priority: Number(event.target.value) || 0 }))} className={cn(field, "h-10")}>
                                {PRIORITY_CHOICES.map((choice) => <option key={choice.value} value={choice.value}>{labels.priority(choice.tone)}</option>)}
                            </select>
                        </label>
                    </div>
                    <details className="group rounded-lg border border-zinc-800 bg-zinc-950/70 px-3 py-2">
                        <summary className="cursor-pointer text-sm text-zinc-400">{t("criteriaSummary")}</summary>
                        <div className="mt-3 grid gap-3">
                            <label className={labelClass}>
                                <span>{t("acceptanceCriteria")}</span>
                                <textarea value={form.acceptanceCriteria} onChange={(event) => setForm((prev) => ({ ...prev, acceptanceCriteria: event.target.value }))} placeholder={t("onePerLine")} rows={3} className={cn(field, "py-2.5")} />
                            </label>
                            <div className="grid gap-3 sm:grid-cols-2">
                                <label className={labelClass}>
                                    <span>{t("definitionOfDone")}</span>
                                    <textarea value={form.definitionOfDone} onChange={(event) => setForm((prev) => ({ ...prev, definitionOfDone: event.target.value }))} rows={3} className={cn(field, "py-2.5")} />
                                </label>
                                <label className={labelClass}>
                                    <span>{t("deliverables")}</span>
                                    <textarea value={form.deliverables} onChange={(event) => setForm((prev) => ({ ...prev, deliverables: event.target.value }))} placeholder={t("onePerLine")} rows={3} className={cn(field, "py-2.5")} />
                                </label>
                            </div>
                        </div>
                    </details>
                    <div className="flex flex-wrap gap-x-5 rounded-lg border border-zinc-800 bg-zinc-950/70 px-3 py-1.5 text-sm text-zinc-300">
                        <CheckboxRow label={t("proofRequired")} checked={form.proofRequired} onChange={(checked) => setForm((prev) => ({ ...prev, proofRequired: checked }))} />
                        <CheckboxRow label={t("humanApprovalRequired")} checked={form.humanApprovalRequired} onChange={(checked) => setForm((prev) => ({ ...prev, humanApprovalRequired: checked }))} />
                    </div>
                    {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}
                    <DialogActions onCancel={onClose} onSubmit={onSubmit} disabled={busy || (!form.projectId && !defaultProject) || !String(form.title || "").trim()} busy={busy} label={mode === "edit" ? t("save") : t("create")} reason={!form.projectId && !defaultProject ? t("chooseProjectReason") : t("titleRequired")} />
                </div>
            </DialogContent>
        </Dialog>
    );
}

export function ConfirmArchiveTaskDialog({ open, title, busy, error, onCancel, onConfirm }: { open: boolean; title: string; busy: boolean; error: string | null; onCancel: () => void; onConfirm: () => void }) {
    const t = useTranslations("tasks.archive");
    const tc = useTranslations("common");
    return (
        <Dialog open={open} onOpenChange={(next) => { if (!next && !busy) onCancel(); }}>
            <DialogContent className="bg-background text-foreground sm:max-w-md" showCloseButton={!busy}>
                <DialogHeader><DialogTitle>{t("oneTitle")}</DialogTitle></DialogHeader>
                <p className="text-sm text-muted-foreground">{t("oneBody", { title })}</p>
                {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
                <div className="flex justify-end gap-2">
                    <button disabled={busy} onClick={onCancel} className="min-h-11 rounded-md border px-4 text-sm">{tc("cancel")}</button>
                    <button disabled={busy} onClick={onConfirm} className="min-h-11 rounded-md bg-destructive px-4 text-sm text-white disabled:opacity-50">{busy ? t("archiving") : t("oneConfirm")}</button>
                </div>
            </DialogContent>
        </Dialog>
    );
}

export function ConfirmArchiveTasksDialog({ open, count, busy, error, onCancel, onConfirm }: { open: boolean; count: number; busy: boolean; error: string | null; onCancel: () => void; onConfirm: () => void }) {
    const t = useTranslations("tasks.archive");
    const tc = useTranslations("common");
    return (
        <Dialog open={open} onOpenChange={(next) => { if (!next && !busy) onCancel(); }}>
            <DialogContent className="bg-background text-foreground sm:max-w-md" showCloseButton={!busy}>
                <DialogHeader><DialogTitle>{t("manyTitle", { count })}</DialogTitle></DialogHeader>
                <p className="text-sm text-muted-foreground">{t("manyBody", { count })}</p>
                {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
                <div className="flex justify-end gap-2">
                    <button disabled={busy} onClick={onCancel} className="min-h-11 rounded-md border px-4 text-sm">{tc("cancel")}</button>
                    <button disabled={busy || count === 0} onClick={onConfirm} className="min-h-11 rounded-md bg-destructive px-4 text-sm text-white disabled:opacity-50">{busy ? t("archiving") : t("manyConfirm", { count })}</button>
                </div>
            </DialogContent>
        </Dialog>
    );
}

export function BlockTaskDialog({ open, title, reason, setReason, busy, error, onCancel, onConfirm }: { open: boolean; title: string; reason: string; setReason: (value: string) => void; busy: boolean; error: string | null; onCancel: () => void; onConfirm: () => void }) {
    const t = useTranslations("tasks.block");
    const tc = useTranslations("common");
    return (
        <Dialog open={open} onOpenChange={(next) => { if (!next && !busy) onCancel(); }}>
            <DialogContent className="bg-background text-foreground sm:max-w-md" showCloseButton={!busy}>
                <DialogHeader><DialogTitle>{t("title")}</DialogTitle></DialogHeader>
                <p className="text-sm text-muted-foreground">{t("body", { title })}</p>
                <label className="space-y-1 text-sm text-zinc-400">
                    <span>{t("why")}</span>
                    <textarea autoFocus value={reason} onChange={(event) => setReason(event.target.value)} placeholder={t("placeholder")} rows={3} className="w-full resize-y rounded-lg border border-zinc-800 bg-zinc-900 p-3 text-sm text-zinc-100 outline-none focus:border-cyan-400" />
                </label>
                {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
                <div className="flex flex-wrap items-center justify-end gap-2">
                    {!busy && !reason.trim() && <span className="mr-auto text-xs text-muted-foreground">{t("reasonRequired")}</span>}
                    <button disabled={busy} onClick={onCancel} className="min-h-11 rounded-md border px-4 text-sm">{tc("cancel")}</button>
                    <button disabled={busy || !reason.trim()} onClick={onConfirm} className="min-h-11 rounded-md bg-rose-500/90 px-4 text-sm font-medium text-white hover:bg-rose-500 disabled:opacity-50">{busy ? t("blocking") : t("confirm")}</button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
