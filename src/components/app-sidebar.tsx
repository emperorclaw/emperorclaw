"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, FolderKanban, Bot, ShieldCheck, KeyRound, Terminal, LogOut, User, HardDrive, MessageSquare, BadgeCheck, BookOpen, ScrollText, GitBranch } from "lucide-react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { CustomLogo } from "./custom-logo";
import { signOut } from "next-auth/react";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { WorkspaceTour } from "./workspace-tour";

function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

export function AppSidebar({ isPlatformAdmin = false }: { isPlatformAdmin?: boolean }) {
    const pathname = usePathname();
    const isDocsPage = pathname?.startsWith('/docs') ?? false;

    const links = [
        { name: "Dashboard", href: "/", icon: LayoutDashboard },
        { name: "Projects", href: "/projects", icon: FolderKanban },
        { name: "Pipelines", href: "/pipelines", icon: GitBranch },
        { name: "Knowledge & Rules", href: "/resources", icon: ScrollText },
        { name: "Messages", href: "/messages", icon: MessageSquare },
        { name: "Approvals", href: "/approvals", icon: BadgeCheck },
        { name: "Agents", href: "/agents", icon: Bot },
        { name: "Customers", href: "/customers", icon: ShieldCheck },
        { name: "Storage", href: "/artifacts", icon: HardDrive },
        { name: "Settings", href: "/settings", icon: KeyRound },
    ];

    if (isPlatformAdmin) {
        links.push({ name: "Ops", href: "/ops", icon: Terminal });
    }

    return (
        <aside className="flex h-full w-20 shrink-0 flex-col border-r border-white/10 bg-zinc-950/72 shadow-2xl shadow-black/30 backdrop-blur-2xl md:w-72">
            <div className="border-b border-white/10 p-5">
                <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.035] p-3">
                    <div className="grid h-10 w-10 place-items-center rounded-xl border border-cyan-400/25 bg-cyan-400/10 shadow-lg shadow-cyan-950/20">
                        <CustomLogo className="h-5 w-5 text-cyan-300" />
                    </div>
                    <div className="hidden min-w-0 md:block">
                        <div className="truncate text-sm font-semibold tracking-tight text-white">Emperor Claw</div>
                        <div className="text-[11px] font-medium uppercase tracking-[0.2em] text-zinc-500">Control Plane</div>
                    </div>
                </div>
            </div>

            <nav className="flex-1 space-y-1 overflow-y-auto px-4 py-5">
                {links.map((link) => {
                    const Icon = link.icon;
                    const isActive = pathname === link.href || (link.href !== "/" && pathname.startsWith(`${link.href}/`));
                    return (
                        <Link
                            key={link.name}
                            href={link.href}
                            className={cn(
                                "group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all duration-200",
                                isActive
                                    ? "border border-cyan-400/20 bg-cyan-400/10 text-white shadow-sm shadow-cyan-950/20"
                                    : "text-zinc-400 hover:bg-white/[0.045] hover:text-zinc-100"
                            )}
                        >
                            <Icon className={cn("h-4 w-4", isActive ? "text-cyan-300" : "text-zinc-500 group-hover:text-zinc-300")} />
                            <span className="hidden truncate md:inline">{link.name}</span>
                        </Link>
                    );
                })}
            </nav>

            {!isDocsPage && (
                <div className="space-y-3 border-t border-white/10 p-4">
                    <WorkspaceTour />
                    <Link
                        href="/docs"
                        className={cn(
                            "group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all duration-200",
                            pathname?.startsWith("/docs")
                                ? "border border-cyan-400/20 bg-cyan-400/10 text-white"
                                : "text-zinc-400 hover:bg-white/[0.045] hover:text-zinc-100"
                        )}
                    >
                        <BookOpen className={cn("h-4 w-4", pathname?.startsWith("/docs") ? "text-cyan-300" : "text-zinc-500 group-hover:text-zinc-300")} />
                        <span className="hidden md:inline">Documentation</span>
                    </Link>
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <button className="flex w-full cursor-pointer items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.035] px-3 py-3 text-left transition-colors hover:border-white/15 hover:bg-white/[0.055]">
                                <div className="grid h-9 w-9 place-items-center rounded-full border border-zinc-700 bg-zinc-900 text-xs font-bold text-zinc-200">
                                    A
                                </div>
                                <div className="hidden min-w-0 flex-1 flex-col md:flex">
                                    <span className="truncate text-sm font-medium text-zinc-100">Admin</span>
                                    <span className="text-xs text-zinc-500">owner</span>
                                </div>
                            </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" className="w-56 border-zinc-800 bg-zinc-950 text-zinc-200 shadow-2xl shadow-black/40">
                            <DropdownMenuItem asChild className="gap-2 text-zinc-200 focus:bg-zinc-900">
                                <Link href="/settings">
                                    <User className="h-4 w-4 text-zinc-400" />
                                    <span>Workspace Settings</span>
                                </Link>
                            </DropdownMenuItem>
                            <DropdownMenuItem
                                className="gap-2 text-zinc-200 focus:bg-zinc-900"
                                onClick={() => signOut({ callbackUrl: "/login" })}
                            >
                                <LogOut className="h-4 w-4 text-zinc-400" />
                                <span>Logout</span>
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            )}
        </aside>
    );
}
