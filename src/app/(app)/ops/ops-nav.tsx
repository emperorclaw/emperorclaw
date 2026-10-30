"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";

const OPS_LINKS = [
    { href: "/ops", id: "overview" },
    { href: "/ops/users", id: "users" },
    { href: "/ops/companies", id: "companies" },
    { href: "/ops/errors", id: "errors" },
    { href: "/ops/runtimes", id: "runtimes" },
    { href: "/ops/storage", id: "storage" },
] as const;

export function OpsNav() {
    const t = useTranslations("ops.nav");
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
                        {t(link.id)}
                    </Link>
                );
            })}
        </nav>
    );
}
