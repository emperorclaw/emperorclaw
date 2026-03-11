"use client";

import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export function CreateAgentDialog() {
    const [open, setOpen] = useState(false);
    const [name, setName] = useState("");
    const [roleDescription, setRoleDescription] = useState("");
 
    const handleCreate = async () => {
        console.log("Sending agent creation request to OpenClaw chat:", roleDescription);
        try {
            const res = await fetch("/api/mcp/messages/send", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    text: `/register-agent name="${name || 'Unnamed Agent'}" capabilities="${roleDescription}"`,
                    senderType: "human"
                })
            });
            if (res.ok) {
                setOpen(false);
                setRoleDescription("");
                setName("");
            }
        } catch (e) {
            console.error(e);
        }
    };
 
    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
                <Button variant="default" className="shadow-sm">Register Agent</Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-[425px] bg-zinc-950 border-zinc-800 text-zinc-200">
                <DialogHeader>
                    <DialogTitle className="text-zinc-100">Register New Agent</DialogTitle>
                    <DialogDescription className="text-zinc-500">
                        Describe the role, persona, and capabilities of the new agent. OpenClaw will automatically spawn and position this operative.
                    </DialogDescription>
                </DialogHeader>
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
                                placeholder="e.g. DataSifter"
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                            />
                        </div>
                    </div>
                    <div className="space-y-1">
                        <label className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">Mission Capabilities</label>
                        <Textarea
                            id="roleDescription"
                            className="bg-zinc-900 border-zinc-800 focus-visible:ring-indigo-500 text-sm h-32"
                            placeholder="Example: I need a highly-specialized Data Extraction agent capable of writing Python scripts to parse massive unformatted PDF reports."
                            value={roleDescription}
                            onChange={(e) => setRoleDescription(e.target.value)}
                        />
                    </div>
                </div>
                <DialogFooter>
                    <Button type="button" variant="outline" onClick={() => setOpen(false)} className="border-zinc-800 text-zinc-300 hover:bg-zinc-800">
                        Cancel
                    </Button>
                    <Button type="button" onClick={handleCreate} disabled={!roleDescription.trim()} className="bg-indigo-600 hover:bg-indigo-500 text-white">
                        Create & Request from OpenClaw
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
