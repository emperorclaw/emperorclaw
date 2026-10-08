import { deriveAppearance } from "../../src/lib/character/model";
import type { DashboardData, DashboardMember, DashboardTask, AttentionEntry } from "../../src/lib/team-scene";

/** Synthetic data only: used for dashboard regression and visual checks. */
export function dashboardFixture(count = 8, generatedAt = new Date().toISOString()): DashboardData {
    const names = ["Ada", "Atlas", "Mira", "Quinn", "Nova", "Sage", "Jules", "Echo"];
    const roles = ["Software engineer", "Research analyst", "Content specialist", "QA engineer", "Operations", "Research analyst", "Designer", "Support"];
    const task = (i: number, state: string, title: string): DashboardTask => ({ id: `task-${i}-${state}`, projectId: "launch", projectName: "Autumn launch", title, state, taskType: roles[i % roles.length], assigneeKey: `agent:fixture-${i}`, updatedAt: generatedAt, dueAt: null });
    const members: DashboardMember[] = Array.from({ length: count }, (_, i) => ({
        key: `agent:fixture-${i}`, id: `fixture-${i}`, kind: "agent", name: `${names[i % names.length]}${i > 7 ? ` ${i + 1}` : ""}`, role: roles[i % roles.length],
        avatarUrl: i === 1 ? "/icon.png" : null, avatarAppearance: deriveAppearance(`fixture-${i}`), skills: ["planning", "teamwork"],
        health: i === 3 ? "down" : i === 4 ? "attention" : "healthy", healthReasons: i === 3 ? ["offline with work waiting"] : i === 4 ? ["1 unanswered message"] : [],
        activity: i === 0 ? "Building the release checklist" : null, href: `/agents?agent=fixture-${i}`, createdAt: null,
        doneToday: i % 2 === 0 ? 2 : 0,
        working: i % 4 === 0 ? [task(i, "in_progress", "Prepare a verified launch brief with links to supporting customer research")] : [],
        waiting: i % 4 === 1 ? [task(i, "review", "Review the launch brief")] : [], next: [],
        spendTodayCents: 124 + i * 30, monthlyCostCents: 1234 + i * 200, monthlyBudgetCents: 10000, lastActivityAt: generatedAt, runtimeOnline: i !== 3,
    }));
    const entry = (kind: AttentionEntry["kind"], i: number, title: string): AttentionEntry => ({ id: `fixture-${kind}-${i}`, kind, title, memberKey: members[i]?.key ?? null, memberName: members[i]?.name ?? null, area: "Autumn launch", at: generatedAt, actionLabel: "Open task", href: "/projects", taskId: `task-${i}-in_progress` });
    const attention: AttentionEntry[] = count ? [
        { ...entry("approval", 0, "Approve the launch brief before publication"), approvalId: "fixture-approval" },
        { ...entry("agent", 3, "Quinn has no recent connection with work waiting"), agentId: "fixture-3" },
        entry("message", 4, "Awaiting agent response: validate the supplier information"),
        entry("late", 0, "The launch brief is past its expected delivery time"),
        ...Array.from({ length: 4 }, (_, i) => ({ ...entry("approval", i % count, `Review request ${i + 2}: supporting assets for the autumn launch`), id: `fixture-additional-approval-${i}`, approvalId: `fixture-approval-${i}` })),
    ] : [];
    return {
        generatedAt, members, attention, board: { inProgress: members.flatMap((m) => m.working), review: members.flatMap((m) => m.waiting), done: count ? [task(0, "done", "Published the research summary")] : [] },
        collaborations: [], activity: [], feed: [],
        cost: { spendTodayCents: 3478, spendMonthCents: 18240, budgetCents: 80000, agents: members.slice(0, 3).map((m) => ({ key: m.key, name: m.name, spendTodayCents: m.spendTodayCents, monthCents: m.monthlyCostCents, budgetCents: m.monthlyBudgetCents })) },
        throughput: { doneToday: 16, doneThisWeek: 91, sparkline: [8, 12, 14, 9, 18, 14, 16], medianCycleMs: 1800000, blocked: 1 },
    };
}
