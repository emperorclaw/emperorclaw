import { redirect } from "next/navigation";
import { requirePlatformAdminSession } from "@/lib/platform-admin";
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
        <div className="max-w-7xl mx-auto space-y-8 animate-in fade-in duration-500">
            <div className="space-y-2">
                <h1 className="text-3xl font-semibold tracking-tight text-zinc-100">Platform Ops</h1>
                <p className="text-zinc-500 font-medium">
                    Launch visibility for users, workspaces, runtimes, and platform errors.
                </p>
            </div>

            <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-4">
                <OpsNav />
            </div>

            {children}
        </div>
    );
}
