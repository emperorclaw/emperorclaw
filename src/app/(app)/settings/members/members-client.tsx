"use client";

import { useEffect, useRef, useState } from "react";
import { IconMail, IconTrash, IconUserCog, IconUsers, IconShield, IconClock, IconLoader2, IconAlertTriangle } from "@tabler/icons-react";
import { toast } from "sonner";
import { useFormatter, useTranslations } from "next-intl";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type Member = {
    id: string;
    email: string;
    displayName?: string | null;
    roleTitle?: string | null;
    companyRole: string;
    instanceRole: string;
    joinedAt: string | null;
    /** "Harbor Dental · Can edit": roles on clients and projects (0.20 Access). */
    customAccess?: string | null;
};

type InvitationRow = {
    id: string;
    email: string;
    role: string;
    createdAt: string;
    expiresAt: string;
    status: "pending" | "expired" | "consumed";
};

interface Props {
    embedded?: boolean;
    currentUserId: string;
    currentUserRole: string;
    companyId: string;
    initialMembers: Member[];
    agents: { id: string; name: string }[];
    customersData: { id: string; name: string }[];
}

const ROLE_COLORS: Record<string, string> = {
    instance_admin: "bg-purple-500/10 text-purple-700 dark:text-purple-400 border-purple-500/20",
    owner: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20",
    admin: "bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20",
    member: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20",
    viewer: "bg-zinc-500/10 text-muted-foreground border-zinc-500/20",
};

const ROLE_OPTIONS = ["admin", "member", "viewer"] as const;

/** Roles with a badge label under settings.members.roleBadges (anything else shows as is). */
const ROLE_BADGE_KEYS = { instance_admin: "instanceAdmin", owner: "owner", admin: "admin", member: "member", viewer: "viewer" } as const;
const INVITATION_STATUSES = new Set(["pending", "expired", "consumed"]);

function RoleBadge({ role }: { role: string }) {
    const t = useTranslations("settings.members.roleBadges");
    return (
        <span className={cn(
            "inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border",
            ROLE_COLORS[role] || ROLE_COLORS.member
        )}>
            {role in ROLE_BADGE_KEYS ? t(ROLE_BADGE_KEYS[role as keyof typeof ROLE_BADGE_KEYS]) : role.replace("_", " ")}
        </span>
    );
}

export default function MembersClient({ currentUserId, currentUserRole, initialMembers, agents, customersData, embedded = false }: Props) {
    const t = useTranslations("settings.members");
    const tc = useTranslations("common");
    const format = useFormatter();
    const date = (iso: string) => format.dateTime(new Date(iso), { dateStyle: "medium" });
    const [members, setMembers] = useState<Member[]>(initialMembers);
    const [invitations, setInvitations] = useState<InvitationRow[]>([]);

    // Invite form
    const [inviteEmail, setInviteEmail] = useState("");
    const [inviteRole, setInviteRole] = useState<string>("member");
    const [sending, setSending] = useState(false);

    // Dialog state
    const [changingRoleFor, setChangingRoleFor] = useState<string | null>(null);
    const [newRole, setNewRole] = useState("");
    const [removingMember, setRemovingMember] = useState<string | null>(null);

    // Scope state
    const scopeRequest = useRef(0);
    const dialogOpener = useRef<HTMLButtonElement | null>(null);
    const restoreDialogFocus = (event: Event) => { event.preventDefault(); dialogOpener.current?.focus(); };
    const [scopeFor, setScopeFor] = useState<string | null>(null);
    const [scopeMode, setScopeMode] = useState<"all" | "restricted">("all");
    const [scopeAgentIds, setScopeAgentIds] = useState<string[]>([]);
    const [scopeCustomerIds, setScopeCustomerIds] = useState<string[]>([]);
    const [savingScope, setSavingScope] = useState(false);

    const canChangeRoles = currentUserRole === "instance_admin" || currentUserRole === "owner";
    const canInvite = currentUserRole === "instance_admin" || currentUserRole === "owner" || currentUserRole === "admin";

    // Load invitations on mount
    const loadInvitations = async () => {
        try {
            const res = await fetch("/api/instance/invitations");
            if (res.ok) {
                const data = await res.json();
                setInvitations(data.invitations || []);
            }
        } catch {
            // Non-critical
        }
    };

    // Initial load — in an effect, not during render (a render-body side effect
    // fires on every render and can double-fetch).
    useEffect(() => {
        void loadInvitations();
    }, []);

    const handleInvite = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!inviteEmail.trim() || sending) return;

        setSending(true);
        try {
            const res = await fetch("/api/instance/invitations", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email: inviteEmail.trim(), role: inviteRole }),
            });

            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.error || t("inviteFailed"));
            }

            const data = await res.json();
            const msg = data.emailSent
                ? t("inviteSent", { email: inviteEmail.trim() })
                : t("inviteNoEmail");
            
            if (!data.emailSent && data.inviteUrl) {
                toast.error(msg, {
                    description: data.inviteUrl,
                    duration: 15000,
                });
            } else {
                toast.success(msg);
            }
            
            setInviteEmail("");
            await loadInvitations();
        } catch (err: unknown) {
            toast.error(err instanceof Error ? err.message : t("inviteFailed"));
        } finally {
            setSending(false);
        }
    };

    const handleRevokeInvitation = async (id: string) => {
        try {
            const res = await fetch(`/api/instance/invitations/${id}`, { method: "DELETE" });
            if (!res.ok) throw new Error("revoke");
            toast.success(t("invitationRevoked"));
            await loadInvitations();
        } catch {
            toast.error(t("revokeFailed"));
        }
    };

    const handleResendInvitation = async (id: string) => {
        try {
            const res = await fetch(`/api/instance/invitations/${id}`, { method: "POST" });
            if (!res.ok) throw new Error("resend");
            toast.success(t("invitationResent"));
            await loadInvitations();
        } catch {
            toast.error(t("resendFailed"));
        }
    };

    const handleChangeRole = async (userId: string) => {
        if (!newRole) return;
        try {
            const res = await fetch(`/api/instance/members/${userId}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ role: newRole }),
            });

            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.error || t("roleFailed"));
            }

            setMembers((prev) =>
                prev.map((m) => (m.id === userId ? { ...m, companyRole: newRole } : m))
            );
            toast.success(t("roleUpdated"));
            setChangingRoleFor(null);
            setNewRole("");
        } catch (err: unknown) {
            toast.error(err instanceof Error ? err.message : t("roleFailed"));
        }
    };

    const handleRemoveMember = async (userId: string) => {
        try {
            const res = await fetch(`/api/instance/members/${userId}`, { method: "DELETE" });
            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.error || t("removeFailed"));
            }

            setMembers((prev) => prev.filter((m) => m.id !== userId));
            toast.success(t("memberRemoved"));
            setRemovingMember(null);
        } catch (err: unknown) {
            toast.error(err instanceof Error ? err.message : t("removeFailed"));
        }
    };

    const openScope = async (userId: string) => {
        const request = ++scopeRequest.current;
        try {
            const res = await fetch(`/api/instance/members/${userId}/scope`);
            if (!res.ok) throw new Error("scope");
            const data = await res.json();
            if (request !== scopeRequest.current) return;
            if (!data.scope || typeof data.scope !== "object" || Array.isArray(data.scope) || !["all", "restricted"].includes(data.scope.mode ?? "all")) throw new Error("scope");
            setScopeMode(data.scope.mode ?? "all");
            setScopeAgentIds(data.scope.agentIds || []);
            setScopeCustomerIds(data.scope.customerIds || []);
            setScopeFor(userId);
        } catch {
            if (request === scopeRequest.current) toast.error(t("scopeLoadFailed"));
        }
    };

    const saveScope = async () => {
        if (!scopeFor || savingScope) return;
        setSavingScope(true);
        try {
            const res = await fetch(`/api/instance/members/${scopeFor}/scope`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    scope: {
                        mode: scopeMode,
                        agentIds: scopeMode === "restricted" ? scopeAgentIds : [],
                        customerIds: scopeMode === "restricted" ? scopeCustomerIds : [],
                    },
                }),
            });
            if (!res.ok) throw new Error("save");
            toast.success(t("scopeUpdated"));
            setScopeFor(null);
        } catch {
            toast.error(t("scopeSaveFailed"));
        } finally {
            setSavingScope(false);
        }
    };

    const toggleScopeItem = (id: string, list: string[], setList: (v: string[]) => void) => {
        setList(list.includes(id) ? list.filter(x => x !== id) : [...list, id]);
    };

    return (
        <div className="min-w-0 space-y-6 max-w-4xl">
            {!embedded && <PageHeader
                eyebrow={t("eyebrow")}
                title={t("title")}
                description={t("description")}
            />}

            {/* ── Invite Form ─────────────────────────────────────────── */}
            {canInvite && (
                <div className="emperor-panel rounded-2xl border border-border bg-card p-6">
                    <h3 className="text-lg font-semibold text-foreground mb-4 flex items-center gap-2">
                        <IconMail className="w-5 h-5 text-indigo-400" />
                        {t("inviteTitle")}
                    </h3>
                    <form onSubmit={handleInvite} className="flex gap-3 flex-wrap">
                        <Input
                            type="email"
                            aria-label={t("invitationEmail")}
                            value={inviteEmail}
                            onChange={(e) => setInviteEmail(e.target.value)}
                            placeholder={t("invitePlaceholder")}
                            className="min-h-11 flex-1 min-w-[200px]"
                            required
                        />
                        <select
                            aria-label={t("invitationRole")}
                            value={inviteRole}
                            onChange={(e) => setInviteRole(e.target.value)}
                            className="min-h-11 bg-muted/30 border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                        >
                            {/* Only owners grant admin, by invite or role change. */}
                            {ROLE_OPTIONS.filter((r) => r !== "admin" || canChangeRoles).map((r) => (
                                <option key={r} value={r} className="bg-muted">
                                    {t(`roles.${r}`)}
                                </option>
                            ))}
                        </select>
                        <Button type="submit" className="min-h-11" disabled={sending}>
                            {sending ? <IconLoader2 className="w-4 h-4 animate-spin mr-1" /> : null}
                            {t("sendInvitation")}
                        </Button>
                    </form>
                </div>
            )}

            {/* ── Members List ─────────────────────────────────────────── */}
            <div className="emperor-panel rounded-2xl border border-border bg-card p-6">
                <h3 className="text-lg font-semibold text-foreground mb-4 flex items-center gap-2">
                    <IconUsers className="w-5 h-5 text-indigo-400" />
                    {t("teamMembers", { count: members.length })}
                </h3>

                {members.length === 0 ? <p className="py-8 text-center text-sm text-muted-foreground">{t("noMembers")}</p> : <div className="overflow-x-auto">
                    <table className="w-full min-w-[640px] text-sm [&_th]:whitespace-nowrap [&_th]:pr-4 [&_td]:pr-4 [&_th:last-child]:pr-0 [&_td:last-child]:pr-0">
                        <caption className="sr-only">{t("tableCaption")}</caption>
                        <thead>
                            <tr className="border-b border-border text-muted-foreground text-left">
                                <th className="pb-3 font-medium">{t("columns.email")}</th>
                                <th className="pb-3 font-medium">{t("columns.companyRole")}</th>
                                <th className="pb-3 font-medium">{t("columns.instanceRole")}</th>
                                <th className="pb-3 font-medium">{t("columns.joined")}</th>
                                <th className="pb-3 font-medium text-right">{t("columns.actions")}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {members.map((member) => (
                                <tr key={member.id} className="border-b border-border">
                                    <td className="py-3 text-foreground">
                                        {member.displayName && <span className="font-medium">{member.displayName}</span>}
                                        {member.displayName && <br />}
                                        <span className={member.displayName ? "text-xs text-muted-foreground" : ""}>{member.email}</span>
                                        {member.roleTitle && <span className="block text-xs text-cyan-400/70 mt-0.5">{member.roleTitle}</span>}
                                        {member.customAccess && <span className="mt-0.5 block text-xs text-muted-foreground">{t("customAccess", { access: member.customAccess })}</span>}
                                    </td>
                                    <td className="py-3"><RoleBadge role={member.companyRole} /></td>
                                    <td className="py-3"><RoleBadge role={member.instanceRole} /></td>
                                    <td className="py-3 text-muted-foreground">
                                        {member.joinedAt ? date(member.joinedAt) : "—"}
                                    </td>
                                    <td className="py-3 text-right">
                                        {member.id !== currentUserId && (
                                            <div className="flex gap-1 justify-end">
                                                <button
                                                    onClick={(event) => { dialogOpener.current = event.currentTarget; void openScope(member.id); }}
                                                    className="inline-flex h-11 w-11 items-center justify-center rounded-lg hover:bg-muted text-muted-foreground hover:text-cyan-400 transition-colors"
                                                    title={t("accessScope")}
                                                >
                                                    <IconShield className="w-4 h-4" />
                                                </button>
                                                {canChangeRoles && (
                                                    <button
                                                        onClick={(event) => { dialogOpener.current = event.currentTarget; setChangingRoleFor(member.id); setNewRole(member.companyRole); }}
                                                        className="inline-flex h-11 w-11 items-center justify-center rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                                                        title={t("changeRole")}
                                                    >
                                                        <IconUserCog className="w-4 h-4" />
                                                    </button>
                                                )}
                                                {canInvite && (member.companyRole !== "owner" || canChangeRoles) && (
                                                    <button
                                                        onClick={(event) => { dialogOpener.current = event.currentTarget; setRemovingMember(member.id); }}
                                                        className="inline-flex h-11 w-11 items-center justify-center rounded-lg hover:bg-red-500/10 text-muted-foreground hover:text-red-400 transition-colors"
                                                        title={t("removeMember")}
                                                    >
                                                        <IconTrash className="w-4 h-4" />
                                                    </button>
                                                )}
                                            </div>
                                        )}
                                    </td>
                                </tr>
                            ))}
                            {members.length === 0 && (
                                <tr>
                                    <td colSpan={5} className="py-8 text-center text-muted-foreground">
                                        {t("noMembers")}
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>}
            </div>

            {/* ── Pending Invitations ──────────────────────────────────── */}
            {canInvite && invitations.length > 0 && (
                <div className="emperor-panel rounded-2xl border border-border bg-card p-6">
                    <h3 className="text-lg font-semibold text-foreground mb-4 flex items-center gap-2">
                        <IconClock className="w-5 h-5 text-indigo-400" />
                        {t("pendingInvitations", { count: invitations.length })}
                    </h3>
                    <div className="overflow-x-auto">
                        <table className="w-full min-w-[640px] text-sm [&_th]:whitespace-nowrap [&_th]:pr-4 [&_td]:pr-4 [&_th:last-child]:pr-0 [&_td:last-child]:pr-0">
                            <thead>
                                <tr className="border-b border-border text-muted-foreground text-left">
                                    <th className="pb-3 font-medium">{t("columns.email")}</th>
                                    <th className="pb-3 font-medium">{t("columns.role")}</th>
                                    <th className="pb-3 font-medium">{t("columns.created")}</th>
                                    <th className="pb-3 font-medium">{t("columns.expires")}</th>
                                    <th className="pb-3 font-medium">{t("columns.status")}</th>
                                    <th className="pb-3 font-medium text-right">{t("columns.actions")}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {invitations.map((inv) => (
                                    <tr key={inv.id} className="border-b border-border">
                                        <td className="py-3 text-foreground">{inv.email}</td>
                                        <td className="py-3"><RoleBadge role={inv.role} /></td>
                                        <td className="py-3 text-muted-foreground">
                                            {date(inv.createdAt)}
                                        </td>
                                        <td className="py-3 text-muted-foreground">
                                            {date(inv.expiresAt)}
                                        </td>
                                        <td className="py-3">
                                            <span className={cn(
                                                "inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border",
                                                inv.status === "pending"
                                                    ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20"
                                                    : inv.status === "expired"
                                                        ? "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20"
                                                        : "bg-zinc-500/10 text-muted-foreground border-zinc-500/20"
                                            )}>
                                                {INVITATION_STATUSES.has(inv.status) ? t(`invitationStatus.${inv.status}`) : inv.status}
                                            </span>
                                        </td>
                                        <td className="py-3 text-right">
                                            {inv.status === "pending" && (
                                                <div className="flex items-center gap-1 justify-end">
                                                    <button
                                                        onClick={() => handleResendInvitation(inv.id)}
                                                        className="inline-flex h-11 w-11 items-center justify-center rounded-lg hover:bg-blue-500/10 text-muted-foreground hover:text-blue-400 transition-colors"
                                                        title={t("resend")}
                                                    >
                                                        <IconMail className="w-4 h-4" />
                                                    </button>
                                                    <button
                                                        onClick={() => handleRevokeInvitation(inv.id)}
                                                        className="inline-flex h-11 w-11 items-center justify-center rounded-lg hover:bg-red-500/10 text-muted-foreground hover:text-red-400 transition-colors"
                                                        title={t("revoke")}
                                                    >
                                                        <IconTrash className="w-4 h-4" />
                                                    </button>
                                                </div>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            {/* ── Role Change Dialog ────────────────────────────────────── */}
            {changingRoleFor && (
                <Dialog open={Boolean(changingRoleFor)} onOpenChange={(open) => { if (!open) setChangingRoleFor(null); }}>
                    <DialogContent onCloseAutoFocus={restoreDialogFocus} className="max-h-[90dvh] overflow-y-auto bg-background text-foreground sm:max-w-sm">
                        <DialogTitle>{t("changeRoleTitle")}</DialogTitle>
                        <DialogDescription>{t("changeRoleDescription")}</DialogDescription>
                        <select
                            value={newRole}
                            onChange={(e) => setNewRole(e.target.value)}
                            aria-label={t("workspaceRole")}
                            className="min-h-11 w-full bg-muted/30 border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-indigo-500/50 mb-4"
                        >
                            {ROLE_OPTIONS.map((r) => (
                                <option key={r} value={r} className="bg-muted">
                                    {t(`roles.${r}`)}
                                </option>
                            ))}
                        </select>
                        <div className="flex gap-3 justify-end">
                            <Button variant="ghost" onClick={() => setChangingRoleFor(null)}>
                                {tc("cancel")}
                            </Button>
                            <Button onClick={() => handleChangeRole(changingRoleFor)}>
                                {tc("save")}
                            </Button>
                        </div>
                    </DialogContent>
                </Dialog>
            )}

            {/* ── Remove Member Confirmation ───────────────────────────── */}
            {removingMember && (
                <Dialog open={Boolean(removingMember)} onOpenChange={(open) => { if (!open) setRemovingMember(null); }}>
                    <DialogContent onCloseAutoFocus={restoreDialogFocus} className="max-h-[90dvh] overflow-y-auto bg-background text-foreground sm:max-w-sm">
                        <div className="flex items-start gap-3 mb-4">
                            <IconAlertTriangle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
                            <div>
                                <DialogTitle>{t("removeTitle")}</DialogTitle>
                                <DialogDescription className="mt-1">
                                    {t("removeDescription")}
                                </DialogDescription>
                            </div>
                        </div>
                        <div className="flex gap-3 justify-end">
                            <Button variant="ghost" onClick={() => setRemovingMember(null)}>
                                {tc("cancel")}
                            </Button>
                            <Button
                                variant="destructive"
                                onClick={() => handleRemoveMember(removingMember)}
                            >
                                {tc("remove")}
                            </Button>
                        </div>
                    </DialogContent>
                </Dialog>
            )}

            {/* ── Scope Dialog ─────────────────────────────────────────── */}
            {scopeFor && (
                <Dialog open={Boolean(scopeFor)} onOpenChange={(open) => { if (!open && !savingScope) setScopeFor(null); }}>
                    <DialogContent onCloseAutoFocus={restoreDialogFocus} showCloseButton={!savingScope} className="max-h-[90dvh] overflow-y-auto bg-background text-foreground sm:max-w-lg">
                        <DialogTitle className="flex items-center gap-2">
                            <IconShield className="w-5 h-5 text-cyan-400" />
                            {t("scopeTitle")}
                        </DialogTitle>
                        <DialogDescription>
                            {members.find(m => m.id === scopeFor)?.email}
                        </DialogDescription>

                        <div className="space-y-4">
                            <label className="flex items-center min-h-11 gap-3 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={scopeMode === "restricted"}
                                    onChange={(e) => setScopeMode(e.target.checked ? "restricted" : "all")}
                                    className="rounded border-border bg-muted text-cyan-400 focus:ring-cyan-400"
                                />
                                <span className="text-sm text-foreground">{t("restricted")}</span>
                                <span className="text-xs text-muted-foreground">{t("restrictedHint")}</span>
                            </label>

                            {scopeMode === "restricted" && (
                                <>
                                    <p className="text-xs text-muted-foreground">
                                        {t("restrictedExplain")}
                                    </p>
                                    {(scopeAgentIds.length === 0 || scopeCustomerIds.length === 0) && (
                                        <div className="rounded-lg border border-amber-700/40 bg-amber-900/20 px-3 py-2 text-xs text-amber-300" role="status">
                                            {scopeAgentIds.length === 0 && scopeCustomerIds.length === 0
                                                ? t("noneSelected")
                                                : scopeAgentIds.length === 0
                                                    ? t("noAgentsSelected")
                                                    : t("noCustomersSelected")}
                                        </div>
                                    )}
                                    <div>
                                        <h4 className="text-sm font-medium text-foreground mb-2">{t("visibleAgents")}</h4>
                                        <div className="max-h-40 overflow-y-auto space-y-1 rounded-lg border border-border bg-muted/50 p-2">
                                            {agents.length === 0 && <p className="text-xs text-muted-foreground p-2">{t("noAgents")}</p>}
                                            {agents.map((a) => (
                                                <label key={a.id} className="flex items-center gap-2 min-h-11 cursor-pointer px-2 py-1 rounded hover:bg-muted/50">
                                                    <input
                                                        type="checkbox"
                                                        checked={scopeAgentIds.includes(a.id)}
                                                        onChange={() => toggleScopeItem(a.id, scopeAgentIds, setScopeAgentIds)}
                                                        className="rounded border-border bg-muted text-cyan-400"
                                                    />
                                                    <span className="text-sm text-foreground">{a.name}</span>
                                                </label>
                                            ))}
                                        </div>
                                    </div>
                                    <div>
                                        <h4 className="text-sm font-medium text-foreground mb-2">{t("visibleCustomers")}</h4>
                                        <div className="max-h-40 overflow-y-auto space-y-1 rounded-lg border border-border bg-muted/50 p-2">
                                            {customersData.length === 0 && <p className="text-xs text-muted-foreground p-2">{t("noCustomers")}</p>}
                                            {customersData.map((c) => (
                                                <label key={c.id} className="flex items-center gap-2 min-h-11 cursor-pointer px-2 py-1 rounded hover:bg-muted/50">
                                                    <input
                                                        type="checkbox"
                                                        checked={scopeCustomerIds.includes(c.id)}
                                                        onChange={() => toggleScopeItem(c.id, scopeCustomerIds, setScopeCustomerIds)}
                                                        className="rounded border-border bg-muted text-cyan-400"
                                                    />
                                                    <span className="text-sm text-foreground">{c.name}</span>
                                                </label>
                                            ))}
                                        </div>
                                    </div>
                                </>
                            )}
                        </div>

                        <div className="flex gap-3 justify-end mt-6">
                            <Button variant="ghost" onClick={() => setScopeFor(null)} disabled={savingScope}>{tc("cancel")}</Button>
                            <Button onClick={saveScope} disabled={savingScope}>
                                {savingScope ? <IconLoader2 className="w-4 h-4 animate-spin mr-1" /> : null}
                                {t("saveScope")}
                            </Button>
                        </div>
                    </DialogContent>
                </Dialog>
            )}
        </div>
    );
}
