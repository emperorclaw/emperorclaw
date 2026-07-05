"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const OPS_LINKS = [
    { href: "/ops", label: "Overview" },
    { href: "/ops/users", label: "Users" },
    { href: "/ops/companies", label: "Companies" },
    { href: "/ops/errors", label: "Errors" },
    { href: "/ops/runtimes", label: "Runtimes" },
];

export function OpsNav() {
    const pathname = usePathname();

    return (
        <nav className="flex flex-wrap gap-2">
            {OPS_LINKS.map((link) => {
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
