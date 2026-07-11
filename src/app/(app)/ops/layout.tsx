import { redirect } from "next/navigation";
import { requirePlatformAdminSession } from "@/lib/platform-admin";
import { PageHeader } from "@/components/page-header";
import { OpsNav } from "./ops-nav";

export default async function OpsLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    const platformAdmin = await requirePlatformAdminSession();

    if (!platformAdmin) {
        redirect("/");
    }

    return (
        <div className="mx-auto max-w-[1800px] space-y-8 animate-in fade-in duration-500">
            <PageHeader
                eyebrow="Ops"
                title="Platform Ops"
                description="Launch visibility for users, workspaces, runtimes, and platform errors."
            />

            <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-4">
                <OpsNav />
            </div>

            {children}
        </div>
    );
}
