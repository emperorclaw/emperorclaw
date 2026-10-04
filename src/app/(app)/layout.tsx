import { AppSidebar } from "@/components/app-sidebar";
import { OpenClawChat } from "@/components/openclaw-chat";
import { AutoRefresh } from "@/components/auto-refresh";
import { InteractiveTour } from "@/components/interactive-tour";
import { UpdateBanner } from "@/components/update-banner";
import { getCompanyId } from "@/lib/auth";
import { getPlatformAdminSession } from "@/lib/platform-admin";
import { getCurrentUserEffectiveRole } from "@/lib/roles";
import pkg from "@/../package.json" assert { type: "json" };

export default async function AppLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    const companyId = await getCompanyId();
    const platformAdmin = await getPlatformAdminSession();
    const roleCtx = companyId ? await getCurrentUserEffectiveRole().catch(() => null) : null;
    const isCompanyAdmin = Boolean(roleCtx && ["instance_admin", "owner", "admin"].includes(roleCtx.role));

    if (!companyId) {
        return <>{children}</>;
    }

    return (
        <div className="emperor-app-shell flex h-screen overflow-hidden">
            <AutoRefresh intervalMs={15000} />
            <InteractiveTour />
            <AppSidebar isPlatformAdmin={platformAdmin?.isPlatformAdmin === true} isCompanyAdmin={isCompanyAdmin} appVersion={pkg.version} />
            <main className="emperor-main flex-1 min-h-0 overflow-y-auto w-full px-3 py-4 pb-20 sm:px-5 sm:py-5 sm:pb-16 lg:px-8">
                <div className="emperor-page-frame">
                    <UpdateBanner />
                    {children}
                </div>
                <OpenClawChat />
            </main>
        </div>
    );
}
