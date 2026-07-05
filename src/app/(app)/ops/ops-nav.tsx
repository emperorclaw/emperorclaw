"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
    LayoutDashboard,
    Users,
    Building2,
    AlertTriangle,
    Radio,
    Store,
} from "lucide-react";

export const OPS_NAV_ITEMS = [
    { href: "/ops", label: "Overview", icon: LayoutDashboard, section: "Platform" },
    { href: "/ops/users", label: "Users", icon: Users, section: "Platform" },
    { href: "/ops/companies", label: "Companies", icon: Building2, section: "Platform" },
    { href: "/ops/errors", label: "Errors", icon: AlertTriangle, section: "Data" },
    { href: "/ops/runtimes", label: "Runtimes", icon: Radio, section: "Data" },
    { href: "/ops/resellers", label: "Resellers", icon: Store, section: "Commerce" },
];

export const SECTION_ORDER = ["Platform", "Data", "Commerce"] as const;

export function OpsNav() {
    const pathname = usePathname();

    return (
        <nav className="flex flex-wrap gap-2">
            {OPS_NAV_ITEMS.map((link) => {
                const isActive = pathname === link.href;
                return (
                    <Link
                        key={link.href}
                        href={link.href}
                        className={`rounded-lg border px-3 py-2 text-sm transition-colors ${
                            isActive
                                ? "border-indigo-500/40 bg-indigo-500/10 text-indigo-300"
                                : "border-zinc-800 bg-zinc-900/50 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
                        }`}
                    >
                        {link.label}
                    </Link>
                );
            })}
        </nav>
    );
}
