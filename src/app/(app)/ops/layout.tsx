import { redirect } from "next/navigation";
import { requirePlatformAdminSession } from "@/lib/platform-admin";
import { OpsShell } from "./ops-shell";

export default async function OpsLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    const platformAdmin = await requirePlatformAdminSession();

    if (!platformAdmin) {
        redirect("/");
    }

    return <OpsShell>{children}</OpsShell>;
}
