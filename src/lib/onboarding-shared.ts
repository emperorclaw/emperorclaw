/**
 * Client-safe onboarding data: the kinds of company the setup assistant asks
 * about, the team templates it offers, and how a choice of teams becomes a
 * set of agents and group chats. Roles are agent-templates ids.
 */

/** Ready-made teams. Pick any mix; each brings its specialists and a group chat. */
export const TEAM_TEMPLATES = [
    {
        id: "development",
        label: "Development",
        icon: "💻",
        hint: "Build and test your product",
        roles: ["developer", "qa"],
        group: { title: "Development team", description: "Build, review, and test features. The developer implements, the tester verifies, and blockers are raised here." },
    },
    {
        id: "marketing",
        label: "Marketing & content",
        icon: "📣",
        hint: "Content, SEO, and campaigns",
        roles: ["content", "seo"],
        group: { title: "Marketing", description: "Plan and write content, optimize it for search, and report what worked. Publishing needs approval first." },
    },
    {
        id: "outreach",
        label: "Sales & outreach",
        icon: "🤝",
        hint: "Find leads and write to them",
        roles: ["growth", "content"],
        group: { title: "Sales & outreach", description: "Find and qualify leads, write outreach, and follow up. Anything sent outside the company needs approval first." },
    },
    {
        id: "support",
        label: "Customer support",
        icon: "🛟",
        hint: "Answer customers, escalate issues",
        roles: ["support"],
        group: { title: "Support", description: "Customer questions, escalations, and follow-ups. Bring in a person when a customer is upset or money is involved." },
    },
    {
        id: "finance",
        label: "Finance & reporting",
        icon: "📊",
        hint: "Books, invoices, and numbers",
        roles: ["accountant", "analyst"],
        group: { title: "Finance", description: "Bookkeeping, invoices, and reports. Payments and anything sent to customers need approval first." },
    },
] as const;

export type TeamTemplateId = typeof TEAM_TEMPLATES[number]["id"];

export const BUSINESS_TYPES = [
    { id: "software", label: "Software & product", hint: "SaaS, apps, dev studio", teams: ["development"] },
    { id: "agency", label: "Marketing agency", hint: "Campaigns, content, SEO for clients", teams: ["marketing", "outreach"] },
    { id: "ecommerce", label: "E-commerce", hint: "Online store, D2C brand", teams: ["support", "marketing"] },
    { id: "services", label: "Services & consulting", hint: "Clients, proposals, delivery", teams: ["outreach"] },
    { id: "finance", label: "Finance & accounting", hint: "Books, reporting, analysis", teams: ["finance"] },
    { id: "other", label: "Something else", hint: "Start with a lead and add as you go", teams: [] },
] as const satisfies readonly { id: string; label: string; hint: string; teams: readonly TeamTemplateId[] }[];

export type BusinessTypeId = typeof BUSINESS_TYPES[number]["id"];

/** Short default agent names per role, so nobody has to invent one to start. */
export const DEFAULT_AGENT_NAMES: Record<string, string> = {
    boss: "Boss",
    developer: "Builder",
    qa: "Tester",
    growth: "Outreach",
    content: "Writer",
    seo: "SEO",
    accountant: "Ledger",
    support: "Support",
    analyst: "Analyst",
};

/** Teams preselected for a kind of company. */
export function suggestedTeams(type: string | null | undefined): TeamTemplateId[] {
    return [...(BUSINESS_TYPES.find((t) => t.id === type)?.teams ?? [])];
}

/** Each agent runs its own container, so the assistant caps a first team. */
export const MAX_WIZARD_AGENTS = 8;
/** Above this, a small machine (a Raspberry Pi, a laptop) may struggle. */
export const COMFORTABLE_AGENT_COUNT = 4;

export type TeamChoice = {
    teams: readonly string[];
    includeBoss: boolean;
    /** Specialists added one by one, outside any team. */
    extraRoles: readonly string[];
    /** Roles taken out of the plan. */
    removedRoles: readonly string[];
    /** Names the operator typed, by role. */
    names: Readonly<Record<string, string>>;
};

export type PlannedGroup = { teamId: string; title: string; description: string; icon: string; roles: string[] };
export type TeamPlan = { agents: { templateId: string; name: string }[]; groups: PlannedGroup[] };

/**
 * Turn the operator's choices into agents and group chats. One agent per role
 * (a Writer chosen by two teams is one agent in both groups); the Boss leads
 * and joins every group; a group needs at least one specialist.
 */
export function planTeam(choice: TeamChoice): TeamPlan {
    const removed = new Set(choice.removedRoles);
    const teams = TEAM_TEMPLATES.filter((t) => choice.teams.includes(t.id));
    const roles: string[] = [];
    const add = (role: string) => { if (!removed.has(role) && !roles.includes(role)) roles.push(role); };
    if (choice.includeBoss) add("boss");
    teams.forEach((t) => t.roles.forEach(add));
    choice.extraRoles.forEach(add);
    const agents = roles.map((role) => ({ templateId: role, name: (choice.names[role] ?? DEFAULT_AGENT_NAMES[role] ?? role).trim() }));
    const hasBoss = roles.includes("boss");
    const groups = teams
        .map((t) => ({
            teamId: t.id,
            title: t.group.title,
            description: t.group.description,
            icon: t.icon,
            roles: [...(hasBoss ? ["boss"] : []), ...t.roles.filter((r) => roles.includes(r))],
        }))
        .filter((g) => g.roles.some((r) => r !== "boss"));
    return { agents, groups };
}

/** Problems that stop the plan from being created, or null. */
export function teamPlanProblem(plan: TeamPlan): string | null {
    if (plan.agents.length === 0) return "Pick at least one team or agent.";
    if (plan.agents.length > MAX_WIZARD_AGENTS) return `Start with at most ${MAX_WIZARD_AGENTS} agents; you can hire more later.`;
    if (plan.agents.some((a) => !a.name)) return "Every agent needs a name.";
    if (plan.agents.some((a) => a.name.length > 40)) return "Keep names under 40 characters.";
    const names = plan.agents.map((a) => a.name.toLowerCase());
    if (new Set(names).size !== names.length) return "Two agents have the same name.";
    return null;
}
