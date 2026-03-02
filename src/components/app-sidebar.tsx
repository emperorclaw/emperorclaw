"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, FolderKanban, Bot, AlertTriangle, ShieldCheck, KeyRound, Terminal, LogOut, User, Repeat, FileBox } from "lucide-react";
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

function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

export function AppSidebar() {
    const pathname = usePathname();

    const links = [
        { name: "Dashboard", href: "/", icon: LayoutDashboard },
        { name: "Projects", href: "/projects", icon: FolderKanban },
        { name: "Pipelines", href: "/pipelines", icon: Repeat },
        { name: "Agents", href: "/agents", icon: Bot },
        { name: "Customers", href: "/customers", icon: ShieldCheck },
        { name: "Incidents", href: "/incidents", icon: AlertTriangle },
        { name: "Artifacts", href: "/artifacts", icon: FileBox },
        { name: "Settings", href: "/settings", icon: KeyRound },
        { name: "Setup Guide", href: "/setup", icon: Terminal },
    ];

    return (
        <div className="w-64 border-r border-zinc-800 bg-zinc-950/50 backdrop-blur-xl h-full flex flex-col">
            <div className="p-6 flex items-center space-x-3">
                <div className="w-8 h-8 rounded-lg bg-indigo-500/20 flex items-center justify-center border border-indigo-500/30">
                    <CustomLogo className="w-5 h-5 text-indigo-400" />
                </div>
                <span className="font-semibold text-lg tracking-tight text-white">Emperor Claw</span>
            </div>

            <nav className="flex-1 px-4 space-y-1 mt-4">
                {links.map((link) => {
                    const Icon = link.icon;
                    const isActive = pathname === link.href || pathname.startsWith(`${link.href}/`);
                    return (
                        <Link
                            key={link.name}
                            href={link.href}
                            className={cn(
                                "flex items-center space-x-3 px-3 py-2 rounded-md transition-all duration-200 group text-sm font-medium",
                                isActive
                                    ? "bg-zinc-800/80 text-white shadow-sm ring-1 ring-zinc-700/50"
                                    : "text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-100"
                            )}
                        >
                            <Icon className={cn("w-4 h-4", isActive ? "text-indigo-400" : "text-zinc-500 group-hover:text-zinc-300")} />
                            <span>{link.name}</span>
                        </Link>
                    );
                })}
            </nav>

            <div className="p-4 border-t border-zinc-800/80">
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <button className="w-full flex items-center space-x-3 px-3 py-2 rounded-md bg-zinc-900/50 border border-zinc-800/50 hover:bg-zinc-800/80 transition-colors text-left">
                            <div className="w-8 h-8 rounded-full bg-zinc-800 flex items-center justify-center text-xs font-bold text-zinc-300">
                                A
                            </div>
                            <div className="flex flex-col">
                                <span className="text-sm font-medium text-zinc-200">Admin</span>
                                <span className="text-xs text-zinc-500">owner</span>
                            </div>
                        </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-56 bg-zinc-950 border-zinc-800 text-zinc-200">
                        <DropdownMenuItem className="gap-2 text-zinc-200 focus:bg-zinc-900">
                            <User className="w-4 h-4 text-zinc-400" />
                            <span>Profile</span>
                        </DropdownMenuItem>
                        <DropdownMenuItem
                            className="gap-2 text-zinc-200 focus:bg-zinc-900"
                            onClick={() => signOut({ callbackUrl: "/login" })}
                        >
                            <LogOut className="w-4 h-4 text-zinc-400" />
                            <span>Logout</span>
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>
        </div>
    );
}
