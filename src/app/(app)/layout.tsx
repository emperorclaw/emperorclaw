import { AppSidebar } from "@/components/app-sidebar";
import { OpenClawChat } from "@/components/openclaw-chat";
import { AutoRefresh } from "@/components/auto-refresh";
import { getCompanyId } from "@/lib/auth";
import { getPlatformAdminSession } from "@/lib/platform-admin";

export default async function AppLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    const companyId = await getCompanyId();
    const platformAdmin = await getPlatformAdminSession();

    if (!companyId) {
        return <>{children}</>;
    }

    return (
        <div className="emperor-app-shell flex h-screen overflow-hidden">
            <AutoRefresh intervalMs={15000} />
            <AppSidebar isPlatformAdmin={platformAdmin?.isPlatformAdmin === true} />
            <main className="emperor-main flex-1 overflow-y-auto w-full px-4 py-5 pb-16 sm:px-6 lg:px-8">
                <div className="emperor-page-frame">
                    {children}
                </div>
                <OpenClawChat />
            </main>
        </div>
    );
}
