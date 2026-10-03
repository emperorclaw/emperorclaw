import { redirect } from "next/navigation";
import { getCompanyId, getValidatedServerSession } from "@/lib/auth";
import { getScopeFromSession, getScopedAgentIds } from "@/lib/member-scope";
import { computeCompanyHealth } from "@/lib/agent-health";
import { AgentHealthView } from "./agent-health-view";

export const dynamic = "force-dynamic";

export default async function AgentHealthPage() {
    const companyId = await getCompanyId();
    if (!companyId) redirect("/login");
    const session = await getValidatedServerSession();
    const agentIds = session ? getScopedAgentIds(getScopeFromSession(session)) : undefined;
    const health = await computeCompanyHealth(companyId, { agentIds });
    return <AgentHealthView initial={health} />;
}
