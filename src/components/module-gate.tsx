import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { IconPuzzle } from "@tabler/icons-react";
import { EmptyState } from "@/components/ui/empty-state";
import { getCurrentUserEffectiveRole } from "@/lib/roles";
import { moduleDefinition, type ModuleKey } from "@/lib/modules";
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
    const { label } = moduleDefinition(module);
    return (
        <EmptyState
            icon={IconPuzzle}
            title={`The ${label} module is off`}
            description={<>Turn it on in Settings → Modules. Its data was kept, so everything comes back as it was.</>}
            action={<Link href="/settings?tab=modules" className="inline-flex min-h-11 items-center rounded-lg border border-border bg-card px-4 text-sm font-medium text-foreground hover:bg-muted">Open Settings → Modules</Link>}
            className="mt-6"
        />
    );
}
