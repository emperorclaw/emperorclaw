import { redirect } from "next/navigation";
import { getCompanyId, getValidatedServerSession } from "@/lib/auth";
import { loadOrganization } from "@/lib/organization";
import { OrganizationEditor } from "@/components/organization-editor";
export const dynamic = "force-dynamic";
export default async function OrganizationPage() {
    const session = await getValidatedServerSession();
    const companyId = await getCompanyId();
    if (!session || !companyId) redirect("/login");
    const role = session.user?.companyRole;
    const canEdit = session.user?.instanceRole === "instance_admin" || role === "owner" || role === "admin";
    const org = await loadOrganization(companyId);
    return <OrganizationEditor initial={org} canEdit={canEdit} />;
}
