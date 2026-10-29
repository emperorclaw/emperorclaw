import { AppSidebar } from "@/components/app-sidebar";
import { OpenClawChat } from "@/components/openclaw-chat";
import { AutoRefresh } from "@/components/auto-refresh";
import { InteractiveTour } from "@/components/interactive-tour";
import { MobileTabBar } from "@/components/mobile-tab-bar";
import { CommandPalette } from "@/components/command-palette";
import { UpdateBanner } from "@/components/update-banner";
import { getCompanyId } from "@/lib/auth";
import { getPlatformAdminSession } from "@/lib/platform-admin";
import { getCurrentUserEffectiveRole } from "@/lib/roles";
import { loadCompanyModules } from "@/lib/modules-server";
import { ModulesProvider } from "@/components/modules-provider";
import { getLocale, getNow, getTimeZone } from "next-intl/server";
import { AppIntlProvider } from "@/components/app-intl-provider";
import { localeNeedsSync } from "@/i18n/request";
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
    // Viewers read only: no New task / Hire shortcuts.
    const canAct = !roleCtx || roleCtx.role !== "viewer";
    const isPlatformAdmin = platformAdmin?.isPlatformAdmin === true;
    // Only the locale, zone and clock go to the client: messages load from a cached
    // per-locale chunk, so the 15 s refresh never re-sends them.
    const [locale, timeZone, now, syncLocale] = await Promise.all([getLocale(), getTimeZone(), getNow(), localeNeedsSync()]);
    const intl = { locale, timeZone, now, syncLocale };
    // The root layout is static (lang="en"); set the real language before first paint.
    const langScript = <script dangerouslySetInnerHTML={{ __html: `document.documentElement.lang=${JSON.stringify(locale)}` }} />;

    if (!companyId) {
        return <AppIntlProvider {...intl}>{langScript}{children}</AppIntlProvider>;
    }
    const modules = await loadCompanyModules(companyId);

    return (
        <AppIntlProvider {...intl}>
            {langScript}
            <div className="emperor-app-shell flex h-dvh flex-col overflow-hidden md:flex-row">
                <AutoRefresh intervalMs={15000} />
                <InteractiveTour modules={modules} />
                <AppSidebar isPlatformAdmin={isPlatformAdmin} isCompanyAdmin={isCompanyAdmin} canAct={canAct} appVersion={pkg.version} modules={modules} />
                <CommandPalette access={{ isCompanyAdmin, isPlatformAdmin, modules }} canAct={canAct} />
                <main className="emperor-main flex-1 min-h-0 min-w-0 overflow-x-hidden overflow-y-auto w-full px-3 py-4 pb-8 sm:px-5 sm:py-5 md:pb-16 lg:px-8">
                    <div className="emperor-page-frame">
                        <UpdateBanner />
                        <ModulesProvider modules={modules}>{children}</ModulesProvider>
                    </div>
                    <OpenClawChat />
                </main>
                <MobileTabBar modules={modules} />
            </div>
        </AppIntlProvider>
    );
}
