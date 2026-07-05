"use client";

import { useState, useEffect } from "react";
import { usePathname } from "next/navigation";
import { X } from "lucide-react";
import { OpsSidebar, OpsHeader } from "./ops-sidebar";
import { OPS_NAV_ITEMS } from "./ops-nav";
import { cn } from "@/lib/utils";

function useBreadcrumb() {
    const pathname = usePathname();
    const match = OPS_NAV_ITEMS.find((item) => item.href === pathname);
    return match?.label ?? "Dashboard";
}

export function OpsShell({ children }: { children: React.ReactNode }) {
    const breadcrumb = useBreadcrumb();
    const [mobileOpen, setMobileOpen] = useState(false);
    const pathname = usePathname();

    // Close mobile sidebar on route change
    useEffect(() => {
        setMobileOpen(false);
    }, [pathname]);

    return (
        <div className="flex min-h-screen bg-zinc-950">
            {/* Desktop sidebar - always present but hidden on mobile */}
            <div className="hidden lg:block">
                <OpsSidebar />
            </div>

            {/* Mobile sidebar overlay */}
            {mobileOpen && (
                <div
                    className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm lg:hidden"
                    onClick={() => setMobileOpen(false)}
                >
                    <div
                        className="h-full w-64 animate-in slide-in-from-left"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="flex h-14 items-center justify-end border-b border-zinc-800 bg-zinc-950 px-4">
                            <button
                                onClick={() => setMobileOpen(false)}
                                className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300 transition-colors"
                            >
                                <X className="h-5 w-5" />
                            </button>
                        </div>
                        <OpsSidebar onNavigate={() => setMobileOpen(false)} />
                    </div>
                </div>
            )}

            {/* Main content area */}
            <div className="flex flex-1 flex-col lg:pl-60">
                <OpsHeader breadcrumb={breadcrumb} />

                {/* Mobile hamburger + breadcrumb */}
                <div className="flex items-center gap-3 border-b border-zinc-800/60 px-4 py-2 lg:hidden">
                    <button
                        onClick={() => setMobileOpen(true)}
                        className="rounded-md p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition-colors"
                    >
                        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
                        </svg>
                    </button>
                    <div className="flex items-center gap-2 text-sm text-zinc-400">
                        <span className="text-zinc-600">Ops</span>
                        <span className="text-zinc-700">/</span>
                        <span className="font-medium text-zinc-200">{breadcrumb}</span>
                    </div>
                </div>

                <main className={cn("flex-1 p-6")}>
                    {children}
                </main>
            </div>
        </div>
    );
}
