import { AppSidebar } from "@/components/app-sidebar";
import { OpenClawChat } from "@/components/openclaw-chat";
import { AutoRefresh } from "@/components/auto-refresh";
import { getCompanyId } from "@/lib/auth";
import { getPlatformAdminSession } from "@/lib/platform-admin";
import { redirect } from "next/navigation";

export default async function AppLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    const companyId = await getCompanyId();
    const platformAdmin = await getPlatformAdminSession();

    if (!companyId) {
        redirect("/login");
    }

    return (
        <div className="flex h-screen overflow-hidden">
            <AutoRefresh intervalMs={15000} />
            <AppSidebar isPlatformAdmin={platformAdmin?.isPlatformAdmin === true} />
            <main className="flex-1 overflow-y-auto w-full p-8 pb-16">
                {children}
                <OpenClawChat />
            </main>
        </div>
    );
}
