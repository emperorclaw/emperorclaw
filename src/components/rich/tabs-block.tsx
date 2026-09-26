"use client";

import React, { useState } from "react";
import { Tabs as TabsPrimitive } from "radix-ui";
import type { TabSection } from "@/lib/rich-blocks";

/**
 * A tabbed panel from a ```tabs block. Each tab body is regular message
 * Markdown (tables, charts, stats — even widgets), rendered through the same
 * pipeline the caller passes in, so tabs can hold anything a message can.
 */
export function TabsBlock({ tabs, renderMarkdown }: { tabs: TabSection[]; renderMarkdown: (content: string) => React.ReactNode }) {
    const [active, setActive] = useState("0");
    return (
        <TabsPrimitive.Root value={active} onValueChange={setActive} className="not-prose my-3 w-full min-w-0 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/40">
            <TabsPrimitive.List
                aria-label="Sections"
                className="flex min-w-0 gap-1 overflow-x-auto border-b border-zinc-800/80 bg-zinc-900/60 px-2 pt-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            >
                {tabs.map((tab, i) => (
                    <TabsPrimitive.Trigger
                        key={i}
                        value={String(i)}
                        className="relative shrink-0 whitespace-nowrap rounded-t-md px-3 pb-2 pt-1.5 text-[13px] font-medium text-zinc-500 outline-none transition-colors hover:text-zinc-200 focus-visible:ring-2 focus-visible:ring-cyan-400/50 data-[state=active]:text-zinc-50 after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-transparent after:transition-colors data-[state=active]:after:bg-[var(--primary)]"
                    >
                        {tab.label}
                    </TabsPrimitive.Trigger>
                ))}
            </TabsPrimitive.List>
            {tabs.map((tab, i) => (
                <TabsPrimitive.Content key={i} value={String(i)} className="ec-rich-fade min-w-0 px-4 py-3 outline-none">
                    {tab.content ? renderMarkdown(tab.content) : <p className="text-sm text-zinc-500">Nothing here.</p>}
                </TabsPrimitive.Content>
            ))}
        </TabsPrimitive.Root>
    );
}
