"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export function CreateAgentDialog() {
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [name, setName] = useState("");
    const [role, setRole] = useState("");
    const [memory, setMemory] = useState("");
    const [concurrencyLimit, setConcurrencyLimit] = useState(1);
    const [isSaving, setIsSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
 
    const handleCreate = async () => {
        setIsSaving(true);
        setError(null);
        try {
            const res = await fetch("/api/agents", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    name,
                    role,
                    memory,
                    concurrencyLimit,
                })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "Agent creation failed");
            if (res.ok) {
                setOpen(false);
                setName("");
                setRole("");
                setMemory("");
                setConcurrencyLimit(1);
                router.refresh();
                router.push(`/agents/${data.agent.id}`);
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : "Agent creation failed");
        } finally {
            setIsSaving(false);
        }
    };
 
    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
                <Button variant="default" className="shadow-sm">Add Agent</Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[425px] bg-zinc-950 border-zinc-800 text-zinc-200">
                <DialogHeader>
                    <DialogTitle className="text-zinc-100">Add Agent Profile</DialogTitle>
                    <DialogDescription className="text-zinc-500">
                        Create the durable Emperor profile. Runtime startup is handled by Hermes/OpenClaw separately.
                    </DialogDescription>
                </DialogHeader>
                <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-100/90">
                    This does not create a Hermes profile, OpenClaw workspace, or bridge service. After creating the
                    Emperor profile, map it to one runtime profile/service on the machine that will execute work.
                    <div className="mt-1 flex flex-wrap gap-3 text-amber-50">
                        <Link href="/docs/v1.1/hermes-runtime" className="underline underline-offset-4">Hermes setup</Link>
                        <Link href="/docs/v1.1/openclaw-agents" className="underline underline-offset-4">OpenClaw setup</Link>
                    </div>
                </div>
                <div className="grid gap-4 py-4">
                    <div className="flex items-center space-x-4 mb-2">
                        <div className="w-16 h-16 rounded-xl bg-zinc-900 border border-zinc-800 flex items-center justify-center overflow-hidden shrink-0 shadow-inner">
                            <img 
                                src={`https://api.dicebear.com/9.x/pixel-art/svg?seed=${encodeURIComponent(name || 'placeholder')}`} 
                                className="w-full h-full object-cover"
                                alt="Avatar Preview"
                            />
                        </div>
                        <div className="flex-1 space-y-1">
                            <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">Proposed Agent Name</label>
                            <input
                                className="w-full bg-zinc-900 border-zinc-800 focus:ring-1 focus:ring-indigo-500 rounded px-3 py-2 text-sm text-zinc-100 outline-none"
                                placeholder="e.g. Viktor"
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                            />
                        </div>
                    </div>
                    <div className="space-y-1">
                        <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">Role</label>
                        <input
                            className="w-full bg-zinc-900 border-zinc-800 focus:ring-1 focus:ring-indigo-500 rounded px-3 py-2 text-sm text-zinc-100 outline-none"
                            placeholder="e.g. Outreach Lead AI Automator"
                            value={role}
                            onChange={(e) => setRole(e.target.value)}
                        />
                    </div>
                    <div className="space-y-1">
                        <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">Profile Memory</label>
                        <Textarea
                            id="memory"
                            className="bg-zinc-900 border-zinc-800 focus-visible:ring-indigo-500 text-sm h-32"
                            placeholder="Operating style, scope, skills, guardrails, and when this agent should be assigned work."
                            value={memory}
                            onChange={(e) => setMemory(e.target.value)}
                        />
                    </div>
                    <div className="space-y-1">
                        <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">Concurrency Limit</label>
                        <input
                            type="number"
                            min={1}
                            className="w-full bg-zinc-900 border-zinc-800 focus:ring-1 focus:ring-indigo-500 rounded px-3 py-2 text-sm text-zinc-100 outline-none"
                            value={concurrencyLimit}
                            onChange={(e) => setConcurrencyLimit(Math.max(1, Number(e.target.value) || 1))}
                        />
                    </div>
                    {error && <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">{error}</div>}
                </div>
                <DialogFooter>
                    <Button type="button" variant="outline" onClick={() => setOpen(false)} className="border-zinc-800 text-zinc-300 hover:bg-zinc-800">
                        Cancel
                    </Button>
                    <Button type="button" onClick={handleCreate} disabled={isSaving || !name.trim()} className="bg-indigo-600 hover:bg-indigo-500 text-white">
                        {isSaving ? "Creating..." : "Create Agent"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
