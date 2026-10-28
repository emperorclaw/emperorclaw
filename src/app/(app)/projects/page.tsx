import { redirect } from "next/navigation";
import { RealtimeRefresh } from "@/lib/use-realtime";
import ProjectsClient from "./projects-client";
import { requireRole } from "@/lib/roles";
import { loadProjectsBoard } from "@/lib/projects-board-reads";

export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
    // Role and member scope from the DB (requireRole), never the login-time
    // JWT copy; the board shows only what this person may see (0.20).
    const guard = await requireRole("viewer")().catch(() => null);
    if (!guard) redirect("/login");

    const board = await loadProjectsBoard(guard);
    const currentMemberId = board.members.find((member) => member.userId === guard.userId)?.id || null;

    return (
        <>
            <RealtimeRefresh topics={["projects"]} />
            <ProjectsClient
                initialTasks={board.tasks}
                projects={board.projects}
                agents={board.agents}
                limitedAgents={board.limitedAgents}
                customers={board.customers}
                artifacts={board.artifacts}
                taskEvents={board.taskEvents}
                initialProjectMemory={board.projectMemory}
                recurringDefinitions={board.recurringDefinitions}
                members={board.members}
                currentMemberId={currentMemberId}
                // Edit everywhere only when the company role does (and no restriction):
                // otherwise the board edits inside editableProjectIds only.
                companyRole={board.canEditAll ? guard.role : "viewer"}
                editableProjectIds={board.editableProjectIds}
            />
        </>
    );
}
