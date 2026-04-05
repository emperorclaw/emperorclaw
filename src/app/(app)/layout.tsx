import { AppSidebar } from "@/components/app-sidebar";
import { OpenClawChat } from "@/components/openclaw-chat";
import { AutoRefresh } from "@/components/auto-refresh";
import { getCompanyId } from "@/lib/auth";

export default async function AppLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    const companyId = await getCompanyId();

    if (!companyId) {
        return <>{children}</>;
    }

    return (
        <div className="flex h-screen overflow-hidden">
            <AutoRefresh intervalMs={15000} />
            <AppSidebar />
            <main className="flex-1 overflow-y-auto w-full p-8 pb-16">
                {children}
                <OpenClawChat />
            </main>
        </div>
    );
}
