"use client";

import { useState } from "react";
import { IconMail, IconTrash, IconUserCog, IconUsers, IconShield, IconClock, IconLoader2, IconAlertTriangle, IconCircleCheck } from "@tabler/icons-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type Member = {
    id: string;
    email: string;
    companyRole: string;
    instanceRole: string;
    joinedAt: string | null;
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
    currentUserId: string;
    currentUserRole: string;
    companyId: string;
    initialMembers: Member[];
    agents: { id: string; name: string }[];
    customersData: { id: string; name: string }[];
}

const ROLE_COLORS: Record<string, string> = {
    instance_admin: "bg-purple-500/10 text-purple-400 border-purple-500/20",
    owner: "bg-amber-500/10 text-amber-400 border-amber-500/20",
    admin: "bg-blue-500/10 text-blue-400 border-blue-500/20",
    member: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
    viewer: "bg-zinc-500/10 text-zinc-400 border-zinc-500/20",
};

const ROLE_OPTIONS = ["admin", "member", "viewer"] as const;

function roleBadge(role: string) {
    return (
        <span className={cn(
            "inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border",
            ROLE_COLORS[role] || ROLE_COLORS.member
        )}>
            {role.replace("_", " ")}
        </span>
    );
}

export default function MembersClient({ currentUserId, currentUserRole, companyId, initialMembers, agents, customersData }: Props) {
    const [members, setMembers] = useState<Member[]>(initialMembers);
    const [invitations, setInvitations] = useState<InvitationRow[]>([]);
    const [invitationsLoaded, setInvitationsLoaded] = useState(false);

    // Invite form
    const [inviteEmail, setInviteEmail] = useState("");
    const [inviteRole, setInviteRole] = useState<string>("member");
    const [sending, setSending] = useState(false);

    // Dialog state
    const [changingRoleFor, setChangingRoleFor] = useState<string | null>(null);
    const [newRole, setNewRole] = useState("");
    const [removingMember, setRemovingMember] = useState<string | null>(null);

    // Scope state
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
        setInvitationsLoaded(true);
    };

    // Initial load
    if (!invitationsLoaded) {
        loadInvitations();
    }

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
                throw new Error(data.error || "Failed to send invitation");
            }

            toast.success(`Invitation sent to ${inviteEmail.trim()}`);
            setInviteEmail("");
            await loadInvitations();
        } catch (err: unknown) {
            toast.error(err instanceof Error ? err.message : "Failed to send invitation");
        } finally {
            setSending(false);
        }
    };

    const handleRevokeInvitation = async (id: string) => {
        try {
            const res = await fetch(`/api/instance/invitations/${id}`, { method: "DELETE" });
            if (!res.ok) throw new Error("Failed to revoke");
            toast.success("Invitation revoked");
            await loadInvitations();
        } catch {
            toast.error("Failed to revoke invitation");
        }
    };

    const handleResendInvitation = async (id: string) => {
        try {
            const res = await fetch(`/api/instance/invitations/${id}`, { method: "POST" });
            if (!res.ok) throw new Error("Failed to resend");
            toast.success("Invitation resent");
            await loadInvitations();
        } catch {
            toast.error("Failed to resend invitation");
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
                throw new Error(data.error || "Failed to change role");
            }

            setMembers((prev) =>
                prev.map((m) => (m.id === userId ? { ...m, companyRole: newRole } : m))
            );
            toast.success("Role updated");
            setChangingRoleFor(null);
            setNewRole("");
        } catch (err: unknown) {
            toast.error(err instanceof Error ? err.message : "Failed to change role");
        }
    };

    const handleRemoveMember = async (userId: string) => {
        try {
            const res = await fetch(`/api/instance/members/${userId}`, { method: "DELETE" });
            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.error || "Failed to remove member");
            }

            setMembers((prev) => prev.filter((m) => m.id !== userId));
            toast.success("Member removed");
            setRemovingMember(null);
        } catch (err: unknown) {
            toast.error(err instanceof Error ? err.message : "Failed to remove member");
        }
    };

    const openScope = async (userId: string) => {
        try {
            const res = await fetch(`/api/instance/members/${userId}/scope`);
            if (res.ok) {
                const data = await res.json();
                const scope = data.scope || {};
                setScopeMode(scope.mode || "all");
                setScopeAgentIds(scope.agentIds || []);
                setScopeCustomerIds(scope.customerIds || []);
            }
        } catch { /* use defaults */ }
        setScopeFor(userId);
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
            if (!res.ok) throw new Error("Failed to save");
            toast.success("Access scope updated");
            setScopeFor(null);
        } catch {
            toast.error("Failed to save scope");
        } finally {
            setSavingScope(false);
        }
    };

    const toggleScopeItem = (id: string, list: string[], setList: (v: string[]) => void) => {
        setList(list.includes(id) ? list.filter(x => x !== id) : [...list, id]);
    };

    return (
        <div className="space-y-8 max-w-4xl">
            <PageHeader
                eyebrow="Team"
                title="Members"
                description="Manage team members, roles, and invitations."
            />

            {/* ── Invite Form ─────────────────────────────────────────── */}
            {canInvite && (
                <div className="emperor-panel rounded-2xl border border-white/10 bg-zinc-950/70 p-6">
                    <h3 className="text-lg font-semibold text-zinc-100 mb-4 flex items-center gap-2">
                        <IconMail className="w-5 h-5 text-indigo-400" />
                        Invite Member
                    </h3>
                    <form onSubmit={handleInvite} className="flex gap-3 flex-wrap">
                        <Input
                            type="email"
                            value={inviteEmail}
                            onChange={(e) => setInviteEmail(e.target.value)}
                            placeholder="colleague@company.com"
                            className="flex-1 min-w-[200px]"
                            required
                        />
                        <select
                            value={inviteRole}
                            onChange={(e) => setInviteRole(e.target.value)}
                            className="bg-zinc-950/50 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                        >
                            {ROLE_OPTIONS.map((r) => (
                                <option key={r} value={r} className="bg-zinc-900">
                                    {r.charAt(0).toUpperCase() + r.slice(1)}
                                </option>
                            ))}
                        </select>
                        <Button type="submit" disabled={sending}>
                            {sending ? <IconLoader2 className="w-4 h-4 animate-spin mr-1" /> : null}
                            Send Invitation
                        </Button>
                    </form>
                </div>
            )}

            {/* ── Members List ─────────────────────────────────────────── */}
            <div className="emperor-panel rounded-2xl border border-white/10 bg-zinc-950/70 p-6">
                <h3 className="text-lg font-semibold text-zinc-100 mb-4 flex items-center gap-2">
                    <IconUsers className="w-5 h-5 text-indigo-400" />
                    Team Members ({members.length})
                </h3>

                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="border-b border-white/10 text-zinc-500 text-left">
                                <th className="pb-3 font-medium">Email</th>
                                <th className="pb-3 font-medium">Company Role</th>
                                <th className="pb-3 font-medium">Instance Role</th>
                                <th className="pb-3 font-medium">Joined</th>
                                <th className="pb-3 font-medium text-right">Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {members.map((member) => (
                                <tr key={member.id} className="border-b border-white/5">
                                    <td className="py-3 text-zinc-200">{member.email}</td>
                                    <td className="py-3">{roleBadge(member.companyRole)}</td>
                                    <td className="py-3">{roleBadge(member.instanceRole)}</td>
                                    <td className="py-3 text-zinc-500">
                                        {member.joinedAt ? new Date(member.joinedAt).toLocaleDateString() : "—"}
                                    </td>
                                    <td className="py-3 text-right">
                                        {member.id !== currentUserId && (
                                            <div className="flex gap-1 justify-end">
                                                <button
                                                    onClick={() => openScope(member.id)}
                                                    className="p-1.5 rounded-lg hover:bg-white/5 text-zinc-400 hover:text-cyan-400 transition-colors"
                                                    title="Access scope"
                                                >
                                                    <IconShield className="w-4 h-4" />
                                                </button>
                                                {canChangeRoles && (
                                                    <button
                                                        onClick={() => { setChangingRoleFor(member.id); setNewRole(member.companyRole); }}
                                                        className="p-1.5 rounded-lg hover:bg-white/5 text-zinc-400 hover:text-zinc-200 transition-colors"
                                                        title="Change role"
                                                    >
                                                        <IconUserCog className="w-4 h-4" />
                                                    </button>
                                                )}
                                                {canInvite && (
                                                    <button
                                                        onClick={() => setRemovingMember(member.id)}
                                                        className="p-1.5 rounded-lg hover:bg-red-500/10 text-zinc-400 hover:text-red-400 transition-colors"
                                                        title="Remove member"
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
                                    <td colSpan={5} className="py-8 text-center text-zinc-500">
                                        No members found.
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* ── Pending Invitations ──────────────────────────────────── */}
            {canInvite && invitations.length > 0 && (
                <div className="emperor-panel rounded-2xl border border-white/10 bg-zinc-950/70 p-6">
                    <h3 className="text-lg font-semibold text-zinc-100 mb-4 flex items-center gap-2">
                        <IconClock className="w-5 h-5 text-indigo-400" />
                        Pending Invitations ({invitations.length})
                    </h3>
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="border-b border-white/10 text-zinc-500 text-left">
                                    <th className="pb-3 font-medium">Email</th>
                                    <th className="pb-3 font-medium">Role</th>
                                    <th className="pb-3 font-medium">Created</th>
                                    <th className="pb-3 font-medium">Expires</th>
                                    <th className="pb-3 font-medium">Status</th>
                                    <th className="pb-3 font-medium text-right">Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                {invitations.map((inv) => (
                                    <tr key={inv.id} className="border-b border-white/5">
                                        <td className="py-3 text-zinc-200">{inv.email}</td>
                                        <td className="py-3">{roleBadge(inv.role)}</td>
                                        <td className="py-3 text-zinc-500">
                                            {new Date(inv.createdAt).toLocaleDateString()}
                                        </td>
                                        <td className="py-3 text-zinc-500">
                                            {new Date(inv.expiresAt).toLocaleDateString()}
                                        </td>
                                        <td className="py-3">
                                            <span className={cn(
                                                "inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border",
                                                inv.status === "pending"
                                                    ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                                                    : inv.status === "expired"
                                                        ? "bg-amber-500/10 text-amber-400 border-amber-500/20"
                                                        : "bg-zinc-500/10 text-zinc-400 border-zinc-500/20"
                                            )}>
                                                {inv.status}
                                            </span>
                                        </td>
                                        <td className="py-3 text-right">
                                            {inv.status === "pending" && (
                                                <div className="flex items-center gap-1 justify-end">
                                                    <button
                                                        onClick={() => handleResendInvitation(inv.id)}
                                                        className="p-1.5 rounded-lg hover:bg-blue-500/10 text-zinc-400 hover:text-blue-400 transition-colors"
                                                        title="Resend"
                                                    >
                                                        <IconMail className="w-4 h-4" />
                                                    </button>
                                                    <button
                                                        onClick={() => handleRevokeInvitation(inv.id)}
                                                        className="p-1.5 rounded-lg hover:bg-red-500/10 text-zinc-400 hover:text-red-400 transition-colors"
                                                        title="Revoke"
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
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
                    <div className="bg-zinc-900 border border-white/10 rounded-2xl p-6 w-full max-w-sm shadow-2xl">
                        <h3 className="text-lg font-semibold text-zinc-100 mb-4">Change Role</h3>
                        <select
                            value={newRole}
                            onChange={(e) => setNewRole(e.target.value)}
                            className="w-full bg-zinc-950/50 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 mb-4"
                        >
                            {ROLE_OPTIONS.map((r) => (
                                <option key={r} value={r} className="bg-zinc-900">
                                    {r.charAt(0).toUpperCase() + r.slice(1)}
                                </option>
                            ))}
                        </select>
                        <div className="flex gap-3 justify-end">
                            <Button variant="ghost" onClick={() => setChangingRoleFor(null)}>
                                Cancel
                            </Button>
                            <Button onClick={() => handleChangeRole(changingRoleFor)}>
                                Save
                            </Button>
                        </div>
                    </div>
                </div>
            )}

            {/* ── Remove Member Confirmation ───────────────────────────── */}
            {removingMember && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
                    <div className="bg-zinc-900 border border-white/10 rounded-2xl p-6 w-full max-w-sm shadow-2xl">
                        <div className="flex items-start gap-3 mb-4">
                            <IconAlertTriangle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
                            <div>
                                <h3 className="text-lg font-semibold text-zinc-100">Remove Member</h3>
                                <p className="text-sm text-zinc-400 mt-1">
                                    Are you sure you want to remove this member from the workspace? This action can be undone by re-inviting them.
                                </p>
                            </div>
                        </div>
                        <div className="flex gap-3 justify-end">
                            <Button variant="ghost" onClick={() => setRemovingMember(null)}>
                                Cancel
                            </Button>
                            <Button
                                variant="destructive"
                                onClick={() => handleRemoveMember(removingMember)}
                            >
                                Remove
                            </Button>
                        </div>
                    </div>
                </div>
            )}

            {/* ── Scope Dialog ─────────────────────────────────────────── */}
            {scopeFor && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
                    <div className="emperor-panel w-full max-w-lg rounded-2xl border border-white/10 bg-zinc-950 p-6 shadow-2xl">
                        <h3 className="text-lg font-semibold text-zinc-100 mb-4 flex items-center gap-2">
                            <IconShield className="w-5 h-5 text-cyan-400" />
                            Access Scope
                        </h3>
                        <p className="text-sm text-zinc-500 mb-4">
                            {members.find(m => m.id === scopeFor)?.email}
                        </p>

                        <div className="space-y-4">
                            <label className="flex items-center gap-3 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={scopeMode === "restricted"}
                                    onChange={(e) => setScopeMode(e.target.checked ? "restricted" : "all")}
                                    className="rounded border-zinc-700 bg-zinc-900 text-cyan-400 focus:ring-cyan-400"
                                />
                                <span className="text-sm text-zinc-200">Restricted access</span>
                                <span className="text-xs text-zinc-500">(unchecked = see everything)</span>
                            </label>

                            {scopeMode === "restricted" && (
                                <>
                                    <div>
                                        <h4 className="text-sm font-medium text-zinc-300 mb-2">Visible Agents</h4>
                                        <div className="max-h-40 overflow-y-auto space-y-1 rounded-lg border border-zinc-800 bg-zinc-900/50 p-2">
                                            {agents.length === 0 && <p className="text-xs text-zinc-600 p-2">No agents</p>}
                                            {agents.map((a) => (
                                                <label key={a.id} className="flex items-center gap-2 cursor-pointer px-2 py-1 rounded hover:bg-zinc-800/50">
                                                    <input
                                                        type="checkbox"
                                                        checked={scopeAgentIds.includes(a.id)}
                                                        onChange={() => toggleScopeItem(a.id, scopeAgentIds, setScopeAgentIds)}
                                                        className="rounded border-zinc-700 bg-zinc-900 text-cyan-400"
                                                    />
                                                    <span className="text-sm text-zinc-300">{a.name}</span>
                                                </label>
                                            ))}
                                        </div>
                                    </div>
                                    <div>
                                        <h4 className="text-sm font-medium text-zinc-300 mb-2">Visible Customers</h4>
                                        <div className="max-h-40 overflow-y-auto space-y-1 rounded-lg border border-zinc-800 bg-zinc-900/50 p-2">
                                            {customersData.length === 0 && <p className="text-xs text-zinc-600 p-2">No customers</p>}
                                            {customersData.map((c) => (
                                                <label key={c.id} className="flex items-center gap-2 cursor-pointer px-2 py-1 rounded hover:bg-zinc-800/50">
                                                    <input
                                                        type="checkbox"
                                                        checked={scopeCustomerIds.includes(c.id)}
                                                        onChange={() => toggleScopeItem(c.id, scopeCustomerIds, setScopeCustomerIds)}
                                                        className="rounded border-zinc-700 bg-zinc-900 text-cyan-400"
                                                    />
                                                    <span className="text-sm text-zinc-300">{c.name}</span>
                                                </label>
                                            ))}
                                        </div>
                                    </div>
                                </>
                            )}
                        </div>

                        <div className="flex gap-3 justify-end mt-6">
                            <Button variant="ghost" onClick={() => setScopeFor(null)}>Cancel</Button>
                            <Button onClick={saveScope} disabled={savingScope}>
                                {savingScope ? <IconLoader2 className="w-4 h-4 animate-spin mr-1" /> : null}
                                Save Scope
                            </Button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
