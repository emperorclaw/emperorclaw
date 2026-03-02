"use client";

import { useState } from "react";
import { Building2, Save, ExternalLink, Send } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

export default function CustomersClient({ initialData: customerData }: { initialData: any[] }) {
    const [isAddClientOpen, setIsAddClientOpen] = useState(false);
    const [newClientInstruction, setNewClientInstruction] = useState("");
    const [sending, setSending] = useState(false);

    // State to track text areas locally before "saving" (dispatching to OpenClaw)
    const [localNotes, setLocalNotes] = useState<Record<string, string>>({});

    const handleSendInstruction = async (instruction: string, callback?: () => void) => {
        if (!instruction.trim() || sending) return;
        setSending(true);
        try {
            await fetch('/api/mcp/messages/send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: 'human_manager',
                    text: instruction
                })
            });
            if (callback) callback();
        } catch (e) {
            console.error("Failed to send instruction", e);
        } finally {
            setSending(false);
        }
    };

    const handleAddClient = () => {
        handleSendInstruction(newClientInstruction, () => {
            setNewClientInstruction("");
            setIsAddClientOpen(false);
        });
    };

    const handleSaveNotes = (customerId: string, customerName: string) => {
        const notes = localNotes[customerId];
        if (!notes) return;
        const instruction = `Update the ICP notes for customer '${customerName}' (ID: ${customerId}) to the following markdown:\n\n${notes}`;
        handleSendInstruction(instruction);
    };

    return (
        <div className="max-w-6xl mx-auto space-y-8 animate-in fade-in duration-500">
            <div className="flex justify-between items-start">
                <div className="flex flex-col space-y-2">
                    <h1 className="text-3xl font-semibold tracking-tight text-zinc-100">Clients & Context</h1>
                    <p className="text-zinc-500 font-medium">Manage Target Ideal Customer Profiles (ICPs) for OpenClaw injections.</p>
                </div>

                <Dialog open={isAddClientOpen} onOpenChange={setIsAddClientOpen}>
                    <DialogTrigger asChild>
                        <button className="bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-md text-sm font-medium transition-colors shadow-sm focus:ring-2 focus:ring-indigo-500 focus:outline-none">
                            Add Client
                        </button>
                    </DialogTrigger>
                    <DialogContent className="sm:max-w-[500px] border-zinc-800 bg-zinc-950 text-zinc-200">
                        <DialogHeader>
                            <DialogTitle className="text-xl font-medium tracking-tight mb-2">Instruct OpenClaw</DialogTitle>
                        </DialogHeader>
                        <div className="grid gap-4 py-4">
                            <p className="text-sm text-zinc-400">
                                Explain to OpenClaw what client you want to create and any initial context.
                            </p>
                            <div className="relative">
                                <textarea
                                    value={newClientInstruction}
                                    onChange={(e) => setNewClientInstruction(e.target.value)}
                                    className="w-full h-32 bg-zinc-900 border border-zinc-800 rounded-md p-3 text-sm text-zinc-300 focus:outline-none focus:ring-1 focus:ring-indigo-500 resize-none"
                                    placeholder="e.g. Create a new client called Acme Corp. They target B2B SaaS managers..."
                                />
                            </div>
                        </div>
                        <div className="flex justify-end pt-2 border-t border-zinc-900">
                            <button
                                onClick={handleAddClient}
                                disabled={!newClientInstruction.trim() || sending}
                                className="bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 rounded-md font-medium text-sm disabled:opacity-50 flex items-center"
                            >
                                <Send className="w-4 h-4 mr-2" />
                                {sending ? "Sending..." : "Dispatch to OpenClaw"}
                            </button>
                        </div>
                    </DialogContent>
                </Dialog>
            </div>

            <div className="grid gap-6 bg-zinc-900/50 border border-zinc-800/80 rounded-xl p-8">
                {customerData.length === 0 ? (
                    <div className="text-center py-12">
                        <Building2 className="w-12 h-12 text-zinc-700 mx-auto mb-4" />
                        <h3 className="text-zinc-300 font-medium mb-1">No Clients Configured</h3>
                        <p className="text-sm text-zinc-500">Add a client to define the ICP rules OpenClaw will follow during execution.</p>
                    </div>
                ) : (
                    customerData.map((customer) => (
                        <div key={customer.id} className="border border-zinc-800/80 rounded-lg bg-zinc-950/50 overflow-hidden">
                            <div className="p-5 border-b border-zinc-800/80 bg-zinc-900/30">
                                <h3 className="text-lg font-medium text-zinc-200 flex items-center gap-2">
                                    {customer.name}
                                    <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded border bg-indigo-500/10 text-indigo-400 border-indigo-500/20">
                                        ID: {customer.id.substring(0, 8)}
                                    </span>
                                </h3>
                            </div>

                            <div className="p-5">
                                <div className="mb-2 flex items-center justify-between">
                                    <label className="text-sm font-medium text-zinc-400">Context Markdown (ICP Details)</label>
                                    <button
                                        onClick={() => handleSaveNotes(customer.id, customer.name)}
                                        disabled={sending}
                                        className="text-xs text-indigo-400 hover:text-indigo-300 flex items-center transition-colors disabled:opacity-50"
                                    >
                                        <Save className="w-3 h-3 mr-1" /> Send Updates to Agent
                                    </button>
                                </div>
                                <textarea
                                    className="w-full h-48 bg-zinc-900 border border-zinc-800 rounded-md p-4 text-sm text-zinc-300 font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 resize-y"
                                    placeholder="# Target Audience&#10;Describe who OpenClaw should be optimizing for..."
                                    defaultValue={customer.notes || ""}
                                    onChange={(e) => setLocalNotes(prev => ({ ...prev, [customer.id]: e.target.value }))}
                                />
                                <p className="text-xs text-zinc-600 mt-2">
                                    OpenClaw will automatically read this markdown block whenever it executes tasks strictly tied to this client. Edits are sent as chat directives.
                                </p>
                            </div>
                        </div>
                    ))
                )}
            </div>
        </div>
    );
}
