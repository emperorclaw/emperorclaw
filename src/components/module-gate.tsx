import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { IconPuzzle } from "@tabler/icons-react";
import { getTranslations } from "next-intl/server";
import { EmptyState } from "@/components/ui/empty-state";
import { getCurrentUserEffectiveRole } from "@/lib/roles";
import { type ModuleKey } from "@/lib/modules";
import { moduleEnabled } from "@/lib/modules-server";

/**
 * Wraps a module's pages (its layout.tsx). While the module is off, owners and
 * admins see where to turn it back on; everyone else gets a plain 404, as if
 * the page did not exist.
 */
export async function ModuleGate({ module, children }: { module: ModuleKey; children: ReactNode }) {
    const role = await getCurrentUserEffectiveRole().catch(() => null);
    if (!role || await moduleEnabled(role.companyId, module)) return <>{children}</>;
    if (!["instance_admin", "owner", "admin"].includes(role.role)) notFound();
    const [t, tModules] = await Promise.all([getTranslations("moduleGate"), getTranslations("settings.modules.items")]);
    return (
        <EmptyState
            icon={IconPuzzle}
            title={t("title", { module: tModules(`${module}.label`) })}
            description={t("description")}
            action={<Link href="/settings?tab=modules" className="inline-flex min-h-11 items-center rounded-lg border border-border bg-card px-4 text-sm font-medium text-foreground hover:bg-muted">{t("action")}</Link>}
            className="mt-6"
        />
    );
}
